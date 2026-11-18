//! A session's inbox for what the agent's tools ask of the app (see render.rs and export.rs).
//! A tool runs in a process of its own, started by the agent's CLI, while only the app has a
//! webview: so the tool leaves a request as a JSON file in a folder of the session and waits
//! for the answer in another, and the app serves the inbox while a turn runs.

use std::future::Future;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde::de::DeserializeOwned;
use serde::Serialize;
use tauri::AppHandle;

use crate::error::{Error, Result};

/// How often the tool looks for its answer, and the app for requests.
const POLL: Duration = Duration::from_millis(100);

/// How often a waiting tool is told again what the app last said, so that whoever waits for
/// the tool hears it is still at work.
const BEAT: Duration = Duration::from_secs(10);
/// How often, at most, the app says how far it is with a request.
const REPORT: Duration = Duration::from_secs(1);

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
        self.ask_hearing(session, request, wait, unreadable, late, &|_| {})
    }

    /// [`Inbox::ask`] for a request that takes long: `hear` is told what the app says of its
    /// progress (see [`Reporter`]) whenever that changes, and again every [`BEAT`] while
    /// nothing does (None until the app has said anything). `wait` is then how long the app
    /// may say nothing new, not how long the request may take.
    pub fn ask_hearing<T: DeserializeOwned>(
        &self,
        session: &Path,
        request: &impl Serialize,
        wait: Duration,
        unreadable: &str,
        late: &str,
        hear: &dyn Fn(Option<&str>),
    ) -> Result<T> {
        self.ask_every(session, request, wait, BEAT, (unreadable, late), hear)
    }

    fn ask_every<T: DeserializeOwned>(
        &self,
        session: &Path,
        request: &impl Serialize,
        wait: Duration,
        beat: Duration,
        (unreadable, late): (&str, &str),
        hear: &dyn Fn(Option<&str>),
    ) -> Result<T> {
        let name = uuid::Uuid::new_v4().to_string();
        put(&session.join(self.requests), &name, request)?;
        let results = session.join(self.results);
        let result = results.join(format!("{name}.json"));
        let progress = results.join(format!("{}.json", progress_name(&name)));
        let mut said: Option<String> = None;
        let mut heard = Instant::now();
        let mut deadline = Instant::now() + wait;
        while Instant::now() < deadline {
            if let Ok(raw) = std::fs::read(&result) {
                let _ = std::fs::remove_file(&result);
                let _ = std::fs::remove_file(&progress);
                let answer: Answer<T> = serde_json::from_slice(&raw)
                    .map_err(|e| Error::msg(format!("{unreadable}: {e}")))?;
                return answer.map_err(Error::msg);
            }
            let now = std::fs::read(&progress)
                .ok()
                .and_then(|raw| serde_json::from_slice::<String>(&raw).ok());
            let news = now.is_some() && now != said;
            if news {
                said = now;
                deadline = Instant::now() + wait;
            }
            if news || heard.elapsed() >= beat {
                hear(said.as_deref());
                heard = Instant::now();
            }
            std::thread::sleep(POLL.min(wait));
        }
        let _ = std::fs::remove_file(session.join(self.requests).join(format!("{name}.json")));
        let _ = std::fs::remove_file(&progress);
        Err(Error::msg(late.to_string()))
    }

    /// Where the app says how far it is with the request `name` of `session`.
    pub fn reporter(&self, session: &Path, name: &str) -> Reporter {
        Reporter {
            dir: session.join(self.results),
            name: progress_name(name),
            said: Mutex::new(None),
        }
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
    /// answering each with what `serve` makes of it; `serve` may say how far it is on the way.
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
        F: Fn(AppHandle, PathBuf, Q, Reporter) -> Fut + Send + 'static,
        Fut: Future<Output = Result<T>> + Send,
    {
        let stop = Arc::new(AtomicBool::new(false));
        let stopped = stop.clone();
        tauri::async_runtime::spawn(async move {
            self.clear(&session);
            while !stopped.load(Ordering::Relaxed) {
                for (name, request) in self.take::<Q>(&session) {
                    let reporter = self.reporter(&session, &name);
                    let made = serve(app.clone(), dir.clone(), request, reporter).await;
                    let _ = self.answer(&session, &name, &made.map_err(|e| e.to_string()));
                }
                tokio::time::sleep(POLL).await;
            }
            self.clear(&session);
        });
        Serving(stop)
    }
}

/// The file name (less its extension) of the progress of the request `name`, among the results.
fn progress_name(name: &str) -> String {
    format!("{name}.progress")
}

/// Says how far the app is with a request, for the tool waiting on it (see
/// [`Inbox::ask_hearing`]).
pub struct Reporter {
    dir: PathBuf,
    name: String,
    said: Mutex<Option<Instant>>,
}

impl Reporter {
    /// Says `words` of the progress, unless something was said less than [`REPORT`] ago: an
    /// export says something after every frame.
    pub fn say(&self, words: &str) {
        let mut said = self.said.lock().unwrap_or_else(|e| e.into_inner());
        if said.is_some_and(|at| at.elapsed() < REPORT) {
            return;
        }
        *said = Some(Instant::now());
        let _ = put(&self.dir, &self.name, words);
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
    use crate::test_support::TempDir;

    const INBOX: Inbox = Inbox {
        requests: "test-requests",
        results: "test-results",
    };

    #[test]
    fn takes_requests_oldest_first_and_once_skipping_the_unreadable() {
        let dir = TempDir::new("inbox");
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
    }

    #[test]
    fn clearing_forgets_what_a_turn_left_behind() {
        let dir = TempDir::new("inbox");
        put(&dir.join(INBOX.requests), "old", "a.html").unwrap();
        INBOX
            .answer::<String>(&dir, "old", &Err("stale".into()))
            .unwrap();
        INBOX.clear(&dir);
        assert!(INBOX.take::<String>(&dir).is_empty());
        assert!(!dir.join(INBOX.results).exists());
    }

    #[test]
    fn an_unreadable_answer_says_so() {
        let dir = TempDir::new("inbox");
        let app = {
            let dir = dir.to_path_buf();
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
    }

    /// An app that takes the one request, says each of `words` of its progress `gap` apart,
    /// then answers "done".
    fn reporting_app(
        dir: &Path,
        words: &'static [&'static str],
        gap: Duration,
    ) -> std::thread::JoinHandle<()> {
        let dir = dir.to_path_buf();
        std::thread::spawn(move || loop {
            if let Some((name, _)) = INBOX.take::<String>(&dir).pop() {
                for word in words {
                    put(&dir.join(INBOX.results), &progress_name(&name), word).unwrap();
                    std::thread::sleep(gap);
                }
                INBOX.answer(&dir, &name, &Ok("done".to_string())).unwrap();
                return;
            }
            std::thread::sleep(Duration::from_millis(5));
        })
    }

    #[test]
    fn the_tool_hears_the_apps_progress_and_waits_on_while_it_changes() {
        let dir = TempDir::new("inbox");
        // Slower in all than the wait, but never silent for as long.
        let app = reporting_app(
            &dir,
            &["one", "two", "three", "four"],
            Duration::from_millis(400),
        );
        let heard = Mutex::new(Vec::new());
        let answer: String = INBOX
            .ask_every(
                &dir,
                &"a.html",
                Duration::from_millis(1200),
                Duration::from_secs(60),
                ("unreadable", "late"),
                &|words| heard.lock().unwrap().push(words.map(str::to_string)),
            )
            .unwrap();
        app.join().unwrap();
        assert_eq!(answer, "done");
        let heard = heard.into_inner().unwrap();
        assert_eq!(heard.first(), Some(&Some("one".to_string())), "{heard:?}");
        assert!(heard.contains(&Some("three".to_string())), "{heard:?}");
        let mut once = heard.clone();
        once.dedup();
        assert_eq!(heard, once, "only news is told between beats");
        let left: Vec<_> = std::fs::read_dir(dir.join(INBOX.results))
            .unwrap()
            .collect();
        assert!(left.is_empty(), "{left:?}");
    }

    #[test]
    fn the_tool_hears_a_beat_while_the_app_says_nothing_new() {
        let dir = TempDir::new("inbox");
        let app = reporting_app(&dir, &["busy"], Duration::from_millis(700));
        let heard = Mutex::new(Vec::new());
        let answer: String = INBOX
            .ask_every(
                &dir,
                &"a.html",
                Duration::from_secs(20),
                Duration::from_millis(150),
                ("unreadable", "late"),
                &|words| heard.lock().unwrap().push(words.map(str::to_string)),
            )
            .unwrap();
        app.join().unwrap();
        assert_eq!(answer, "done");
        let heard = heard.into_inner().unwrap();
        let busy = heard
            .iter()
            .filter(|w| w.as_deref() == Some("busy"))
            .count();
        assert!(busy >= 2, "{heard:?}");
    }

    #[test]
    fn beats_alone_do_not_keep_the_tool_waiting() {
        let dir = TempDir::new("inbox");
        let beats = Mutex::new(0);
        let error = INBOX
            .ask_every::<String>(
                &dir,
                &"a.html",
                Duration::from_millis(450),
                Duration::from_millis(100),
                ("unreadable", "late"),
                &|words| {
                    assert_eq!(words, None);
                    *beats.lock().unwrap() += 1;
                },
            )
            .unwrap_err();
        assert_eq!(error.to_string(), "late");
        assert!(*beats.lock().unwrap() >= 1);
        assert!(INBOX.take::<String>(&dir).is_empty(), "withdrawn");
    }

    #[test]
    fn the_app_reports_progress_at_most_once_in_a_while() {
        let dir = TempDir::new("inbox");
        let reporter = INBOX.reporter(&dir, "job");
        reporter.say("frame 1");
        reporter.say("frame 2");
        let file = dir.join(INBOX.results).join("job.progress.json");
        let said: String = serde_json::from_slice(&std::fs::read(&file).unwrap()).unwrap();
        assert_eq!(said, "frame 1");
        *reporter.said.lock().unwrap() = Some(Instant::now() - REPORT);
        reporter.say("frame 30");
        let said: String = serde_json::from_slice(&std::fs::read(&file).unwrap()).unwrap();
        assert_eq!(said, "frame 30");
        // The progress of a request is not mistaken for its answer, nor for a request.
        assert!(!dir.join(INBOX.results).join("job.json").exists());
        assert!(INBOX.take::<String>(&dir).is_empty());
    }
}
