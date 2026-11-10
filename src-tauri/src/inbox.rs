//! A session's inbox for what the agent's tools ask of the app (see render.rs and export.rs).
//! A tool runs in a process of its own, started by the agent's CLI, while only the app has a
//! webview: so the tool leaves a request as a JSON file in a folder of the session and waits
//! for the answer in another, and the app serves the inbox while a turn runs.

use std::future::Future;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use serde::de::DeserializeOwned;
use serde::Serialize;
use tauri::AppHandle;

use crate::error::{Error, Result};

/// How often the tool looks for its answer, and the app for requests.
const POLL: Duration = Duration::from_millis(100);

/// The folders of a session one kind of request goes to, and its answers.
pub(crate) struct Inbox {
    pub requests: &'static str,
    pub results: &'static str,
}

/// What an answer is: what was made, or why it failed, in words.
pub(crate) type Answer<T> = std::result::Result<T, String>;

impl Inbox {
    /// Leaves `request` in the inbox of `session` and waits up to `wait` for its answer. An
    /// answer that cannot be read is an error saying it is an `unreadable` one; with none in
    /// time the request is withdrawn and the error is `late`.
    pub fn ask<T: DeserializeOwned>(
        &self,
        session: &Path,
        request: &impl Serialize,
        wait: Duration,
        unreadable: &str,
        late: &str,
    ) -> Result<T> {
        let name = uuid::Uuid::new_v4().to_string();
        put(&session.join(self.requests), &name, request)?;
        let result = session.join(self.results).join(format!("{name}.json"));
        let deadline = Instant::now() + wait;
        while Instant::now() < deadline {
            if let Ok(raw) = std::fs::read(&result) {
                let _ = std::fs::remove_file(&result);
                let answer: Answer<T> = serde_json::from_slice(&raw)
                    .map_err(|e| Error::msg(format!("{unreadable}: {e}")))?;
                return answer.map_err(Error::msg);
            }
            std::thread::sleep(POLL.min(wait));
        }
        let _ = std::fs::remove_file(session.join(self.requests).join(format!("{name}.json")));
        Err(Error::msg(late.to_string()))
    }

    /// Drains the inbox of `session`, oldest first, skipping what cannot be read.
    pub fn take<T: DeserializeOwned>(&self, session: &Path) -> Vec<(String, T)> {
        take(&session.join(self.requests))
    }

    /// Answers the request `name` in the inbox of `session`.
    pub fn answer<T: Serialize>(
        &self,
        session: &Path,
        name: &str,
        answer: &Answer<T>,
    ) -> Result<()> {
        put(&session.join(self.results), name, answer)
    }

    /// Forgets requests and answers a previous turn left behind.
    fn clear(&self, session: &Path) {
        let _ = std::fs::remove_dir_all(session.join(self.requests));
        let _ = std::fs::remove_dir_all(session.join(self.results));
    }

    /// Serves the inbox of `session` for a turn in workspace `dir`, one request at a time,
    /// answering each with what `serve` makes of it.
    pub fn start<Q, T, F, Fut>(
        &'static self,
        app: AppHandle,
        dir: PathBuf,
        session: PathBuf,
        serve: F,
    ) -> Serving
    where
        Q: DeserializeOwned + Send + 'static,
        T: Serialize + Send,
        F: Fn(AppHandle, PathBuf, Q) -> Fut + Send + 'static,
        Fut: Future<Output = Result<T>> + Send,
    {
        let stop = Arc::new(AtomicBool::new(false));
        let stopped = stop.clone();
        tauri::async_runtime::spawn(async move {
            self.clear(&session);
            while !stopped.load(Ordering::Relaxed) {
                for (name, request) in self.take::<Q>(&session) {
                    let made = serve(app.clone(), dir.clone(), request).await;
                    let _ = self.answer(&session, &name, &made.map_err(|e| e.to_string()));
                }
                tokio::time::sleep(POLL).await;
            }
            self.clear(&session);
        });
        Serving(stop)
    }
}

/// Stops serving the inbox when dropped, with the turn.
pub struct Serving(Arc<AtomicBool>);

impl Drop for Serving {
    fn drop(&mut self) {
        self.0.store(true, Ordering::Relaxed);
    }
}

/// Writes `value` to `dir`/`name`.json in one step, so the reader never sees half of it.
fn put<T: Serialize + ?Sized>(dir: &Path, name: &str, value: &T) -> Result<()> {
    std::fs::create_dir_all(dir)?;
    let temp = dir.join(format!("{name}.tmp"));
    std::fs::write(
        &temp,
        serde_json::to_vec(value).map_err(|e| Error::msg(e.to_string()))?,
    )?;
    std::fs::rename(temp, dir.join(format!("{name}.json")))?;
    Ok(())
}

/// Drains the `inbox` folder of requests, oldest first, skipping what cannot be read.
fn take<T: DeserializeOwned>(inbox: &Path) -> Vec<(String, T)> {
    let Ok(entries) = std::fs::read_dir(inbox) else {
        return Vec::new();
    };
    let mut files: Vec<(std::time::SystemTime, PathBuf)> = entries
        .flatten()
        .map(|entry| entry.path())
        .filter(|p| p.extension().is_some_and(|ext| ext == "json"))
        .map(|p| {
            let made = std::fs::metadata(&p).and_then(|m| m.modified());
            (made.unwrap_or(std::time::UNIX_EPOCH), p)
        })
        .collect();
    files.sort();
    let mut requests = Vec::new();
    for (_, file) in files {
        let request = std::fs::read(&file)
            .ok()
            .and_then(|raw| serde_json::from_slice(&raw).ok());
        let _ = std::fs::remove_file(&file);
        let name = file.file_stem().and_then(|name| name.to_str());
        if let (Some(name), Some(request)) = (name, request) {
            requests.push((name.to_string(), request));
        }
    }
    requests
}

#[cfg(test)]
mod tests {
    use super::*;

    const INBOX: Inbox = Inbox {
        requests: "test-requests",
        results: "test-results",
    };

    fn session() -> PathBuf {
        let dir = std::env::temp_dir().join(format!("slopslide-inbox-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn takes_requests_oldest_first_and_once_skipping_the_unreadable() {
        let dir = session();
        let inbox = dir.join(INBOX.requests);
        put(&inbox, "first", "a.html").unwrap();
        std::thread::sleep(Duration::from_millis(20));
        put(&inbox, "second", "b.html").unwrap();
        std::fs::write(inbox.join("broken.json"), "{").unwrap();
        std::fs::write(inbox.join("half.tmp"), "{").unwrap();
        let taken: Vec<(String, String)> = INBOX.take(&dir);
        assert_eq!(
            taken,
            [
                ("first".to_string(), "a.html".to_string()),
                ("second".to_string(), "b.html".to_string())
            ]
        );
        assert!(INBOX.take::<String>(&dir).is_empty());
        assert!(inbox.join("half.tmp").exists(), "still being written");
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn clearing_forgets_what_a_turn_left_behind() {
        let dir = session();
        put(&dir.join(INBOX.requests), "old", "a.html").unwrap();
        INBOX
            .answer::<String>(&dir, "old", &Err("stale".into()))
            .unwrap();
        INBOX.clear(&dir);
        assert!(INBOX.take::<String>(&dir).is_empty());
        assert!(!dir.join(INBOX.results).exists());
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn an_unreadable_answer_says_so() {
        let dir = session();
        let app = {
            let dir = dir.clone();
            std::thread::spawn(move || loop {
                if let Some((name, _)) = INBOX.take::<String>(&dir).pop() {
                    put(&dir.join(INBOX.results), &name, "not an answer").unwrap();
                    return;
                }
                std::thread::sleep(Duration::from_millis(5));
            })
        };
        let error = INBOX
            .ask::<String>(
                &dir,
                &"a.html",
                Duration::from_secs(5),
                "unreadable thing",
                "late",
            )
            .unwrap_err();
        app.join().unwrap();
        assert!(
            error.to_string().starts_with("unreadable thing: "),
            "{error}"
        );
        std::fs::remove_dir_all(dir).unwrap();
    }
}
