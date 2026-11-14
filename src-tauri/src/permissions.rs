//! Permission modes and the approval broker every provider shares. A provider turns an
//! agent's permission request into an [`Approval`] for the chat plus the payload each
//! decision answers with; the user's decision comes back as an [`Answer`] the provider
//! writes to its agent in its own wire format.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tokio::sync::{mpsc, watch};

use crate::agent::Provider;
use crate::error::{Error, Result};

#[derive(Debug, Clone, Copy, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum PermissionMode {
    /// Workspace work and the app's own tools run freely; anything else asks the user.
    #[default]
    Ask,
    /// Codex only: its reviewer decides requests for extra access.
    AutoReview,
    /// Everything runs without asking.
    FullAccess,
    /// Codex only: the user's own Codex configuration.
    Custom,
}

/// A running turn's permission mode, which the user may change while it runs.
pub type LiveMode = watch::Receiver<PermissionMode>;

/// A mode that never changes, for turns nobody steers.
#[cfg(test)]
pub fn fixed_mode(mode: PermissionMode) -> LiveMode {
    watch::channel(mode).1
}

/// The modes Claude Code and GitHub Copilot offer. Codex asks its configuration (see
/// [`crate::codex::permission_modes`]).
pub fn fixed_modes(provider: Provider) -> Vec<PermissionMode> {
    match provider {
        Provider::Claude | Provider::Copilot => {
            vec![PermissionMode::Ask, PermissionMode::FullAccess]
        }
        Provider::Codex => Vec::new(),
    }
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum Decision {
    Accept,
    AcceptForSession,
    Decline,
}

/// Decision names, also the keys of the payloads a request offers.
pub type DecisionKey = &'static str;

impl Decision {
    pub fn key(self) -> DecisionKey {
        match self {
            Self::Accept => "accept",
            Self::AcceptForSession => "acceptForSession",
            Self::Decline => "decline",
        }
    }
}

/// The payload each offered decision answers the agent with.
pub type Choices = HashMap<DecisionKey, Value>;

/// What a request the user may allow once, allow for the rest of the session (when
/// `for_session` is the payload that does), or decline offers: the decisions in the order the
/// chat shows them, and the payload each answers the agent with.
pub fn offer(
    accept: Value,
    for_session: Option<Value>,
    decline: Value,
) -> (Vec<Decision>, Choices) {
    let mut decisions = vec![Decision::Accept];
    let mut choices = Choices::from([
        (Decision::Accept.key(), accept),
        (Decision::Decline.key(), decline),
    ]);
    if let Some(payload) = for_session {
        choices.insert(Decision::AcceptForSession.key(), payload);
        decisions.push(Decision::AcceptForSession);
    }
    decisions.push(Decision::Decline);
    (decisions, choices)
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Approval {
    pub id: String,
    pub title: String,
    pub reason: Option<String>,
    pub details: String,
    pub accept_label: String,
    pub decisions: Vec<Decision>,
    /// What allowing for the session covers from here on, in words for the user ("commands
    /// starting with `npm test`"); None when the agent did not say.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session_scope: Option<String>,
}

impl Approval {
    /// An approval with a fresh id offering `decisions` in their order.
    pub fn new(
        title: &str,
        reason: Option<String>,
        details: String,
        decisions: Vec<Decision>,
    ) -> Self {
        Self {
            id: uuid::Uuid::new_v4().to_string(),
            title: title.into(),
            reason,
            details,
            accept_label: "Allow once".into(),
            decisions,
            session_scope: None,
        }
    }

    /// The approval, saying what allowing it for the session covers.
    pub fn covering(mut self, scope: Option<String>) -> Self {
        self.session_scope = scope;
        self
    }
}

/// `text` as code in a sentence shown to the user.
fn code(text: &str) -> String {
    format!("`{}`", text.replace('`', "'"))
}

/// What the rules Claude Code suggests for a request (its `permission_suggestions`) would allow
/// for the rest of the session, in words; None when they say nothing this can read.
pub fn claude_session_scope(rules: &[Value]) -> Option<String> {
    let mut covered: Vec<String> = Vec::new();
    for update in rules {
        match update["type"].as_str() {
            Some("addRules") => {
                for rule in update["rules"].as_array().into_iter().flatten() {
                    let tool = rule["toolName"].as_str().unwrap_or_default();
                    let content = rule["ruleContent"].as_str().filter(|c| !c.is_empty());
                    covered.push(match (tool, content) {
                        ("Bash", Some(command)) => match command.strip_suffix(":*") {
                            Some(start) => format!("commands starting with {}", code(start)),
                            None => format!("the command {}", code(command)),
                        },
                        ("Bash", None) => "any command".into(),
                        ("Edit" | "Write" | "MultiEdit" | "NotebookEdit", Some(files)) => {
                            format!("changes to files matching {}", code(files))
                        }
                        ("Edit" | "Write" | "MultiEdit" | "NotebookEdit", None) => {
                            "changes to any file".into()
                        }
                        ("Read" | "Glob" | "Grep", Some(files)) => {
                            format!("reading files matching {}", code(files))
                        }
                        ("Read" | "Glob" | "Grep", None) => "reading any file".into(),
                        ("WebFetch", Some(site)) => format!(
                            "pages on {}",
                            code(site.strip_prefix("domain:").unwrap_or(site))
                        ),
                        ("WebFetch" | "WebSearch", None) => "any web page".into(),
                        ("", _) => continue,
                        (tool, _) => format!("the tool {}", code(tool)),
                    });
                }
            }
            Some("setMode") if update["mode"] == "acceptEdits" => {
                covered.push("changes to files in this folder".into());
            }
            Some("addDirectories") => {
                for dir in update["directories"].as_array().into_iter().flatten() {
                    if let Some(dir) = dir.as_str() {
                        covered.push(format!("files in {}", code(dir)));
                    }
                }
            }
            _ => {}
        }
    }
    covered.dedup();
    (!covered.is_empty()).then(|| covered.join(", "))
}

/// What the session approval Copilot is answered with (its `approval`) allows for the rest of
/// the session, in words.
pub fn copilot_session_scope(answer: &Value) -> Option<String> {
    let approval = &answer["approval"];
    match approval["kind"].as_str()? {
        "commands" => {
            let commands: Vec<String> = approval["commandIdentifiers"]
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(|command| command.as_str().map(code))
                .collect();
            (!commands.is_empty()).then(|| format!("the commands {}", commands.join(", ")))
        }
        "write" => Some("changes to any file".into()),
        "read" => Some("reading any file".into()),
        "mcp" => Some(format!(
            "the tool {} of {}",
            code(approval["toolName"].as_str().unwrap_or("?")),
            code(approval["serverName"].as_str().unwrap_or("?"))
        )),
        _ => None,
    }
}

/// The user's decision on its way back to the agent.
#[derive(Debug)]
pub struct Answer {
    /// The [`Approval`] id.
    pub id: String,
    /// The agent's id for the request.
    pub wire_id: Value,
    pub payload: Value,
}

struct Pending {
    workspace: String,
    run_id: String,
    wire_id: Value,
    choices: Choices,
    sender: mpsc::UnboundedSender<Answer>,
}

/// Requests waiting for the user, across all running turns.
#[derive(Default)]
pub struct Approvals(Mutex<HashMap<String, Pending>>);

impl Approvals {
    pub fn respond(&self, workspace: &str, id: &str, decision: Decision) -> Result<()> {
        let mut pending = self.0.lock().unwrap();
        let request = pending
            .get(id)
            .ok_or_else(|| Error::msg("This approval is no longer pending."))?;
        if request.workspace != workspace {
            return Err(Error::msg(
                "This approval belongs to a different workspace.",
            ));
        }
        let payload = request
            .choices
            .get(decision.key())
            .ok_or_else(|| Error::msg("The agent did not offer that decision."))?
            .clone();
        let request = pending.remove(id).expect("checked pending request");
        request
            .sender
            .send(Answer {
                id: id.into(),
                wire_id: request.wire_id,
                payload,
            })
            .map_err(|_| Error::msg("This turn has ended."))
    }

    pub fn cancel_workspace(&self, workspace: &str) {
        self.0
            .lock()
            .unwrap()
            .retain(|_, p| p.workspace != workspace);
    }

    /// Starts tracking the requests of one turn, which are dropped with the returned [`Run`].
    /// The receiver yields the user's decisions, to write to the agent.
    pub fn start(self: &Arc<Self>, workspace: &str) -> (Run, mpsc::UnboundedReceiver<Answer>) {
        let (sender, answers) = mpsc::unbounded_channel();
        let run = Run {
            approvals: self.clone(),
            workspace: workspace.into(),
            id: uuid::Uuid::new_v4().to_string(),
            sender,
        };
        (run, answers)
    }

    #[cfg(test)]
    pub fn is_empty(&self) -> bool {
        self.0.lock().unwrap().is_empty()
    }
}

/// One turn's pending requests.
pub struct Run {
    approvals: Arc<Approvals>,
    workspace: String,
    id: String,
    sender: mpsc::UnboundedSender<Answer>,
}

impl Run {
    /// Waits for the user on `approval`, answering request `wire_id` from `choices`.
    pub fn ask(&self, wire_id: Value, approval: &Approval, choices: Choices) {
        self.approvals.0.lock().unwrap().insert(
            approval.id.clone(),
            Pending {
                workspace: self.workspace.clone(),
                run_id: self.id.clone(),
                wire_id,
                choices,
                sender: self.sender.clone(),
            },
        );
    }

    /// Allows every request of this turn still waiting for the user, as granting Full access
    /// mid-turn does. The answers arrive on the turn's receiver like the user's own.
    pub fn accept_all(&self) {
        let mut pending = self.approvals.0.lock().unwrap();
        let ids: Vec<String> = pending
            .iter()
            .filter(|(_, p)| p.run_id == self.id && p.choices.contains_key("accept"))
            .map(|(id, _)| id.clone())
            .collect();
        for id in ids {
            let request = pending.remove(&id).expect("listed pending request");
            let _ = request.sender.send(Answer {
                payload: request.choices["accept"].clone(),
                id,
                wire_id: request.wire_id,
            });
        }
    }

    /// The agent settled request `wire_id` itself; returns the approval it closed, if pending.
    pub fn resolved(&self, wire_id: &Value) -> Option<String> {
        let mut pending = self.approvals.0.lock().unwrap();
        let id = pending
            .iter()
            .find(|(_, p)| p.run_id == self.id && p.wire_id == *wire_id)
            .map(|(id, _)| id.clone())?;
        pending.remove(&id);
        Some(id)
    }
}

impl Drop for Run {
    fn drop(&mut self) {
        self.approvals
            .0
            .lock()
            .unwrap()
            .retain(|_, p| p.run_id != self.id);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn approval() -> Approval {
        Approval::new(
            "Run a command",
            None,
            "ls".into(),
            vec![Decision::Accept, Decision::Decline],
        )
    }

    #[test]
    fn routes_a_decision_to_its_turn() {
        let approvals = Arc::new(Approvals::default());
        let (run, mut answers) = approvals.start("deck-1");
        let a = approval();
        run.ask(
            json!(7),
            &a,
            Choices::from([("accept", json!("yes")), ("decline", json!("no"))]),
        );
        assert!(approvals
            .respond("deck-2", &a.id, Decision::Accept)
            .is_err());
        assert!(approvals
            .respond("deck-1", &a.id, Decision::AcceptForSession)
            .is_err());
        approvals
            .respond("deck-1", &a.id, Decision::Decline)
            .unwrap();
        let answer = answers.try_recv().unwrap();
        assert_eq!(
            (answer.id, answer.wire_id, answer.payload),
            (a.id.clone(), json!(7), json!("no"))
        );
        assert!(
            approvals
                .respond("deck-1", &a.id, Decision::Accept)
                .is_err(),
            "answered once"
        );
    }

    #[test]
    fn forgets_requests_the_agent_settled_or_the_turn_left() {
        let approvals = Arc::new(Approvals::default());
        let (run, _answers) = approvals.start("deck-1");
        let (a, b) = (approval(), approval());
        run.ask(json!("r1"), &a, Choices::new());
        run.ask(json!("r2"), &b, Choices::new());
        assert_eq!(run.resolved(&json!("r1")), Some(a.id));
        assert_eq!(run.resolved(&json!("r1")), None);
        drop(run);
        assert!(approvals.is_empty());
    }

    #[test]
    fn full_access_allows_the_turns_waiting_requests() {
        let approvals = Arc::new(Approvals::default());
        let (run, mut answers) = approvals.start("deck-1");
        let (other, mut other_answers) = approvals.start("deck-2");
        let (a, b, c) = (approval(), approval(), approval());
        run.ask(
            json!(1),
            &a,
            Choices::from([("accept", json!("yes")), ("decline", json!("no"))]),
        );
        // Nothing to accept with: left for the user.
        run.ask(json!(2), &b, Choices::from([("decline", json!("no"))]));
        other.ask(json!(3), &c, Choices::from([("accept", json!("yes"))]));
        run.accept_all();
        let answer = answers.try_recv().unwrap();
        assert_eq!(
            (answer.id, answer.wire_id, answer.payload),
            (a.id.clone(), json!(1), json!("yes"))
        );
        assert!(answers.try_recv().is_err());
        assert!(approvals
            .respond("deck-1", &a.id, Decision::Accept)
            .is_err());
        approvals
            .respond("deck-1", &b.id, Decision::Decline)
            .unwrap();
        assert!(
            other_answers.try_recv().is_err(),
            "another turn's requests wait"
        );
        approvals
            .respond("deck-2", &c.id, Decision::Accept)
            .unwrap();
    }

    #[test]
    fn says_what_allowing_for_the_session_covers() {
        let rules = [
            json!({"type": "addRules", "behavior": "allow", "rules": [
                {"toolName": "Bash", "ruleContent": "npm run test:*"},
                {"toolName": "Bash", "ruleContent": "ls"},
                {"toolName": "Edit", "ruleContent": "/src/**"},
                {"toolName": "Read"},
                {"toolName": "WebFetch", "ruleContent": "domain:example.com"},
                {"toolName": "mcp__files__search"},
            ]}),
            json!({"type": "setMode", "mode": "acceptEdits"}),
            json!({"type": "addDirectories", "directories": ["/tmp/out"]}),
            json!({"type": "setMode", "mode": "plan"}),
        ];
        assert_eq!(
            claude_session_scope(&rules).unwrap(),
            "commands starting with `npm run test`, the command `ls`, changes to files matching `/src/**`, \
             reading any file, pages on `example.com`, the tool `mcp__files__search`, \
             changes to files in this folder, files in `/tmp/out`"
        );
        assert_eq!(claude_session_scope(&[]), None);
        assert_eq!(claude_session_scope(&[json!({"type": "other"})]), None);

        let copilot = |approval: Value| copilot_session_scope(&json!({"approval": approval}));
        assert_eq!(
            copilot(json!({"kind": "commands", "commandIdentifiers": ["ls", "cat"]})).unwrap(),
            "the commands `ls`, `cat`"
        );
        assert_eq!(
            copilot(json!({"kind": "write"})).unwrap(),
            "changes to any file"
        );
        assert_eq!(
            copilot(json!({"kind": "mcp", "serverName": "files", "toolName": "search"})).unwrap(),
            "the tool `search` of `files`"
        );
        assert_eq!(
            copilot(json!({"kind": "commands", "commandIdentifiers": []})),
            None
        );
        assert_eq!(copilot(json!({"kind": "else"})), None);

        // Said with the request, and left out of it when unknown.
        let approval = approval().covering(Some("any command".into()));
        assert_eq!(
            serde_json::to_value(&approval).unwrap()["sessionScope"],
            "any command"
        );
        let plain = serde_json::to_value(super::tests::approval()).unwrap();
        assert!(plain.get("sessionScope").is_none());
    }

    #[test]
    fn offers_the_session_only_with_its_payload() {
        let (decisions, choices) = offer(json!("once"), None, json!("no"));
        assert_eq!(decisions, [Decision::Accept, Decision::Decline]);
        assert_eq!(
            choices,
            Choices::from([("accept", json!("once")), ("decline", json!("no"))])
        );
        let (decisions, choices) = offer(json!("once"), Some(json!("all")), json!("no"));
        assert_eq!(
            decisions,
            [
                Decision::Accept,
                Decision::AcceptForSession,
                Decision::Decline
            ]
        );
        assert_eq!(choices["acceptForSession"], json!("all"));
    }

    #[test]
    fn claude_and_copilot_offer_ask_and_full_access() {
        for provider in [Provider::Claude, Provider::Copilot] {
            assert_eq!(
                fixed_modes(provider),
                [PermissionMode::Ask, PermissionMode::FullAccess]
            );
        }
    }
}
