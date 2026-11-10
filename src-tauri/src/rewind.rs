//! Taking an agent's conversation back to before one of the user's messages, after the deck
//! changes of its turn were undone (see [`crate::history`]). The chat drops the message and the
//! replies after it; the provider's conversation is cut back when the next turn starts:
//!
//! - Claude Code resumes with `--resume-session-at` the last reply before the message,
//! - Codex reverts the thread (`thread/revert`) to before the message's turn,
//! - GitHub Copilot truncates the session's history (`session.history.truncate`) at the
//!   message's event.
//!
//! Where the conversation cannot be cut back (no point recorded for the message, another
//! provider, or the provider refuses), the next prompt starts with a note telling the agent
//! what was taken back instead.
//!
//! `rewind.json` in the session keeps, per message id, where its turn started, plus the
//! requested rewind until a turn takes it.

use std::collections::HashMap;
use std::fs;
use std::path::Path;

use serde::{Deserialize, Serialize};

use crate::agent::Provider;
use crate::error::{Error, Result};

const REWIND_FILE: &str = "rewind.json";

#[derive(Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct State {
    /// Where the provider's conversation stood when each message's turn started.
    #[serde(default)]
    anchors: HashMap<String, Anchor>,
    /// Claude Code: the newest message of its conversation, which the next turn starts after.
    #[serde(default)]
    claude_tail: Option<String>,
    #[serde(default)]
    pending: Option<Pending>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Anchor {
    provider: Provider,
    /// Claude: the last message before the turn (None: the turn started the conversation).
    /// Codex: the turn's id. Copilot: the id of the turn's user message event.
    point: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Pending {
    message: String,
    note: String,
}

/// How the next turn takes the conversation back.
#[derive(Debug, Clone, PartialEq)]
pub enum Plan {
    /// Start a new conversation: the message started the one there is.
    Fresh,
    /// Cut the conversation back at this provider-specific point; if that fails, start the
    /// prompt with `note`.
    At { point: String, note: String },
    /// The conversation cannot be cut back: start the prompt with this note.
    Note(String),
}

fn load(session: &Path) -> State {
    fs::read(session.join(REWIND_FILE))
        .ok()
        .and_then(|raw| serde_json::from_slice(&raw).ok())
        .unwrap_or_default()
}

fn save(session: &Path, state: &State) -> Result<()> {
    let json = serde_json::to_vec_pretty(state).map_err(|e| Error::msg(e.to_string()))?;
    fs::create_dir_all(session)?;
    crate::deck::atomic_write(&session.join(REWIND_FILE), &json)
}

/// Asks the next turn to take the conversation back to before `message`, telling the agent
/// `note` when it cannot.
pub fn request(session: &Path, message: &str, note: &str) -> Result<()> {
    let mut state = load(session);
    state.pending = Some(Pending {
        message: message.into(),
        note: note.into(),
    });
    save(session, &state)
}

/// Takes the requested rewind, if there is one, for a turn of `provider`.
pub fn take(session: &Path, provider: Provider) -> Result<Option<Plan>> {
    let mut state = load(session);
    let Some(pending) = state.pending.take() else {
        return Ok(None);
    };
    let plan = match state.anchors.get(&pending.message) {
        Some(anchor) if anchor.provider == provider => match anchor.point.clone() {
            Some(point) => Plan::At {
                point,
                note: pending.note,
            },
            None => Plan::Fresh,
        },
        _ => Plan::Note(pending.note),
    };
    save(session, &state)?;
    Ok(Some(plan))
}

/// Records where `provider`'s conversation stood when the turn of `message` started.
pub fn anchor(
    session: &Path,
    message: &str,
    provider: Provider,
    point: Option<&str>,
) -> Result<()> {
    let mut state = load(session);
    state.anchors.insert(
        message.into(),
        Anchor {
            provider,
            point: point.map(str::to_string),
        },
    );
    save(session, &state)
}

/// Claude Code: the newest message of the conversation.
pub fn claude_tail(session: &Path) -> Option<String> {
    load(session).claude_tail
}

pub fn set_claude_tail(session: &Path, tail: Option<&str>) -> Result<()> {
    let mut state = load(session);
    if state.claude_tail.as_deref() == tail {
        return Ok(());
    }
    state.claude_tail = tail.map(str::to_string);
    save(session, &state)
}

/// Called with the provider's point for a turn once it started: None when the turn starts the
/// conversation (Claude Code, see [`Anchor`]).
pub type Started<'a> = &'a (dyn Fn(Option<&str>) + Sync);

/// What a provider's turn needs to take the conversation back and to record where it started.
#[derive(Default, Clone, Copy)]
pub struct TurnRewind<'a> {
    /// The point to cut the conversation back at before the turn, with the note to start the
    /// prompt with if that fails (see [`Plan::At`]).
    pub cut: Option<(&'a str, &'a str)>,
    /// Called once the turn started (see [`Started`]).
    pub started: Option<Started<'a>>,
}

/// `prompt` with `note` before it.
pub fn with_note(note: &str, prompt: &str) -> String {
    format!("{note}\n\n{prompt}")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::TempDir;

    fn session() -> TempDir {
        TempDir::new("rewind")
    }

    #[test]
    fn nothing_to_take_without_a_request() {
        let dir = session();
        assert_eq!(take(&dir, Provider::Claude).unwrap(), None);
    }

    #[test]
    fn a_request_is_taken_once_at_the_messages_anchor() {
        let dir = session();
        anchor(&dir, "m2", Provider::Codex, Some("turn-2")).unwrap();
        request(&dir, "m2", "note").unwrap();
        assert_eq!(
            take(&dir, Provider::Codex).unwrap(),
            Some(Plan::At {
                point: "turn-2".into(),
                note: "note".into()
            })
        );
        assert_eq!(take(&dir, Provider::Codex).unwrap(), None);
    }

    #[test]
    fn the_first_message_starts_a_new_conversation() {
        let dir = session();
        anchor(&dir, "m1", Provider::Claude, None).unwrap();
        request(&dir, "m1", "note").unwrap();
        assert_eq!(take(&dir, Provider::Claude).unwrap(), Some(Plan::Fresh));
    }

    #[test]
    fn unknown_messages_and_other_providers_get_the_note() {
        let dir = session();
        anchor(&dir, "m1", Provider::Claude, Some("u1")).unwrap();
        request(&dir, "m1", "note").unwrap();
        assert_eq!(
            take(&dir, Provider::Copilot).unwrap(),
            Some(Plan::Note("note".into()))
        );
        request(&dir, "gone", "other").unwrap();
        assert_eq!(
            take(&dir, Provider::Claude).unwrap(),
            Some(Plan::Note("other".into()))
        );
    }

    #[test]
    fn a_newer_request_replaces_the_older() {
        let dir = session();
        anchor(&dir, "m1", Provider::Claude, Some("u0")).unwrap();
        anchor(&dir, "m2", Provider::Claude, Some("u1")).unwrap();
        request(&dir, "m2", "two").unwrap();
        request(&dir, "m1", "one").unwrap();
        assert_eq!(
            take(&dir, Provider::Claude).unwrap(),
            Some(Plan::At {
                point: "u0".into(),
                note: "one".into()
            })
        );
    }

    #[test]
    fn keeps_claudes_tail() {
        let dir = session();
        assert_eq!(claude_tail(&dir), None);
        set_claude_tail(&dir, Some("u1")).unwrap();
        assert_eq!(claude_tail(&dir).as_deref(), Some("u1"));
        set_claude_tail(&dir, None).unwrap();
        assert_eq!(claude_tail(&dir), None);
    }

    #[test]
    fn notes_go_before_the_prompt() {
        assert_eq!(with_note("N", "P"), "N\n\nP");
    }
}
