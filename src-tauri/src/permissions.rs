//! Permission modes and the approval broker every provider shares. A provider turns an
//! agent's permission request into an [`Approval`] for the chat plus the payload each
//! decision answers with; the user's decision comes back as an [`Answer`] the provider
//! writes to its agent in its own wire format.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tokio::sync::mpsc;

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

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Approval {
    pub id: String,
    pub title: String,
    pub reason: Option<String>,
    pub details: String,
    pub accept_label: String,
    pub decisions: Vec<Decision>,
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
        }
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
    fn claude_and_copilot_offer_ask_and_full_access() {
        for provider in [Provider::Claude, Provider::Copilot] {
            assert_eq!(
                fixed_modes(provider),
                [PermissionMode::Ask, PermissionMode::FullAccess]
            );
        }
    }
}
