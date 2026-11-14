//! The agent's text, as it streams, joined into one event per frame. A provider reports text a
//! few characters at a time, hundreds of times a second, and each report sent on its own is a
//! message to every window and a render of the chat. Nothing can be seen changing faster than
//! the screen draws, so the text that arrives within one frame goes out as one event.
//!
//! Order is kept: any other event (a tool call, a result, the end of the turn) sends the text
//! waiting before it first.

use std::sync::{Arc, Mutex};
use std::time::Duration;

use super::AgentEvent;

/// How long text waits for more: about a frame at 30 a second.
pub(super) const FRAME: Duration = Duration::from_millis(33);

type Sink = Box<dyn Fn(&AgentEvent) + Send + Sync>;
/// Something to run once the frame is over.
pub(super) type Later = Box<dyn FnOnce() + Send>;

struct Waiting {
    /// The text not sent yet.
    text: String,
    /// Whether a send of it is already due at the end of the frame.
    due: bool,
    sink: Sink,
}

impl Waiting {
    fn send_text(&mut self) {
        if !self.text.is_empty() {
            let text = std::mem::take(&mut self.text);
            (self.sink)(&AgentEvent::TextDelta { text });
        }
    }
}

/// Events on their way to `sink`, the text deltas among them joined (see the module).
pub(super) struct Deltas {
    /// One lock around the waiting text and every send, so the end of a frame and an event
    /// arriving at that moment cannot swap places.
    waiting: Arc<Mutex<Waiting>>,
    /// Runs its argument when the frame that starts now is over.
    after_frame: Box<dyn Fn(Later) + Send + Sync>,
}

impl Deltas {
    /// Sends to `sink`, with the frames timed by the app's async runtime.
    pub fn per_frame(sink: impl Fn(&AgentEvent) + Send + Sync + 'static) -> Self {
        Self::new(sink, |later| {
            tauri::async_runtime::spawn(async move {
                tokio::time::sleep(FRAME).await;
                later();
            });
        })
    }

    pub fn new(
        sink: impl Fn(&AgentEvent) + Send + Sync + 'static,
        after_frame: impl Fn(Later) + Send + Sync + 'static,
    ) -> Self {
        Deltas {
            waiting: Arc::new(Mutex::new(Waiting {
                text: String::new(),
                due: false,
                sink: Box::new(sink),
            })),
            after_frame: Box::new(after_frame),
        }
    }

    /// Passes `event` on: text at the end of the frame its first piece arrived in, anything else
    /// at once, after the text that came before it.
    pub fn emit(&self, event: &AgentEvent) {
        let mut waiting = self.waiting.lock().unwrap_or_else(|e| e.into_inner());
        let AgentEvent::TextDelta { text } = event else {
            waiting.send_text();
            (waiting.sink)(event);
            return;
        };
        waiting.text.push_str(text);
        if waiting.due {
            return;
        }
        waiting.due = true;
        let shared = self.waiting.clone();
        (self.after_frame)(Box::new(move || {
            let mut waiting = shared.lock().unwrap_or_else(|e| e.into_inner());
            waiting.due = false;
            waiting.send_text();
        }));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Events as they reach the frontend, and the frames waiting to end.
    #[derive(Clone, Default)]
    struct Stage {
        sent: Arc<Mutex<Vec<AgentEvent>>>,
        frames: Arc<Mutex<Vec<Later>>>,
    }

    impl Stage {
        fn deltas(&self) -> Deltas {
            let (sent, frames) = (self.sent.clone(), self.frames.clone());
            Deltas::new(
                move |event| sent.lock().unwrap().push(event.clone()),
                move |later| frames.lock().unwrap().push(later),
            )
        }

        fn sent(&self) -> Vec<AgentEvent> {
            self.sent.lock().unwrap().clone()
        }

        /// The frames that were waiting end.
        fn tick(&self) {
            let due: Vec<Later> = std::mem::take(&mut *self.frames.lock().unwrap());
            for later in due {
                later();
            }
        }
    }

    fn delta(text: &str) -> AgentEvent {
        AgentEvent::TextDelta { text: text.into() }
    }

    fn tool() -> AgentEvent {
        AgentEvent::ToolUse {
            id: "t1".into(),
            name: "Read".into(),
            input: serde_json::json!({}),
        }
    }

    #[test]
    fn the_text_of_one_frame_is_one_event() {
        let stage = Stage::default();
        let deltas = stage.deltas();
        let mut whole = String::new();
        for n in 0..100 {
            let piece = format!("{n} ");
            deltas.emit(&delta(&piece));
            whole.push_str(&piece);
        }
        assert!(stage.sent().is_empty(), "nothing goes out mid-frame");
        assert_eq!(
            stage.frames.lock().unwrap().len(),
            1,
            "one frame is waited for, not one per piece"
        );
        stage.tick();
        assert_eq!(stage.sent(), [delta(&whole)]);

        deltas.emit(&delta("next"));
        deltas.emit(&delta(" frame"));
        stage.tick();
        assert_eq!(stage.sent(), [delta(&whole), delta("next frame")]);
        stage.tick();
        assert_eq!(stage.sent().len(), 2, "an empty frame sends nothing");
    }

    #[test]
    fn another_event_sends_the_waiting_text_first() {
        let stage = Stage::default();
        let deltas = stage.deltas();
        deltas.emit(&AgentEvent::TextStart);
        deltas.emit(&delta("Let me "));
        deltas.emit(&delta("look."));
        deltas.emit(&tool());
        assert_eq!(
            stage.sent(),
            [AgentEvent::TextStart, delta("Let me look."), tool()],
            "in the order they happened, without waiting for the frame"
        );
        deltas.emit(&delta("Done"));
        deltas.emit(&AgentEvent::Finished { interrupted: false });
        stage.tick();
        assert_eq!(
            stage.sent()[3..],
            [delta("Done"), AgentEvent::Finished { interrupted: false }],
            "the frame that ends afterwards has nothing left to send"
        );
    }

    #[test]
    fn events_that_are_not_text_pass_straight_through() {
        let stage = Stage::default();
        let deltas = stage.deltas();
        deltas.emit(&AgentEvent::Thinking);
        deltas.emit(&tool());
        assert_eq!(stage.sent(), [AgentEvent::Thinking, tool()]);
        assert!(
            stage.frames.lock().unwrap().is_empty(),
            "no frame is waited for"
        );
    }

    #[tokio::test]
    async fn a_frame_ends_by_itself() {
        let sent = Arc::new(Mutex::new(Vec::new()));
        let seen = sent.clone();
        let deltas = Deltas::new(
            move |event: &AgentEvent| seen.lock().unwrap().push(event.clone()),
            |later| {
                tokio::spawn(async move {
                    tokio::time::sleep(FRAME).await;
                    later();
                });
            },
        );
        deltas.emit(&delta("a"));
        deltas.emit(&delta("b"));
        tokio::time::sleep(FRAME * 6).await;
        assert_eq!(*sent.lock().unwrap(), [delta("ab")]);
    }
}
