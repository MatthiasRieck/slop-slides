//! The speech engine, Kitten TTS (see [`super::kitten`]), runs in a worker process: the app
//! started again with [`WORKER_FLAG`]. A crash in ONNX Runtime or a damaged model does not
//! touch the app, and the worker is stopped by killing it.
//!
//! The app writes one JSON request per line to the worker's stdin and reads one JSON answer
//! per line from its stdout: first `{"ready":true}` once the model is loaded, then for each
//! request `{"samples":N}` once its WAV file is written, or `{"error":"…"}`.

use std::io::{BufRead, Write};
use std::path::{Path, PathBuf};
use std::process::Stdio;

use serde::{Deserialize, Serialize};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader, Lines};
use tokio::process::{Child, ChildStdin, ChildStdout, Command};

use super::{audio, kitten};
use crate::error::{Error, Result};

/// `slopslide --narration-worker <model dir>` runs the worker.
pub const WORKER_FLAG: &str = "--narration-worker";

/// Something for the worker to say.
#[derive(Debug, Serialize, Deserialize)]
pub struct Request {
    pub text: String,
    /// The model's name for the voice, e.g. `expr-voice-2-m`.
    pub speaker: String,
    /// The WAV file to write.
    pub output: PathBuf,
}

#[derive(Debug, Default, Serialize, Deserialize)]
struct Answer {
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    ready: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    samples: Option<usize>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    error: Option<String>,
}

/// A running worker with the model loaded. Dropping it kills the worker.
pub struct Worker {
    child: Child,
    stdin: ChildStdin,
    lines: Lines<BufReader<ChildStdout>>,
}

impl Worker {
    /// Starts a worker on the model in `model_dir` and waits until it has loaded it.
    pub async fn start(model_dir: &Path) -> Result<Self> {
        let exe = std::env::current_exe()?;
        let mut command = Command::new(exe);
        #[cfg(windows)]
        command.creation_flags(0x08000000); // CREATE_NO_WINDOW; retain the redirected pipes.
        let mut child = command
            .arg(WORKER_FLAG)
            .arg(model_dir)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .kill_on_drop(true)
            .spawn()
            .map_err(|e| Error::msg(format!("cannot start the speech engine: {e}")))?;
        let stdin = child.stdin.take().expect("piped stdin");
        let lines = BufReader::new(child.stdout.take().expect("piped stdout")).lines();
        let mut worker = Worker {
            child,
            stdin,
            lines,
        };
        match worker.answer().await? {
            Answer { ready: true, .. } => Ok(worker),
            other => {
                Err(Error::msg(other.error.unwrap_or_else(|| {
                    "the speech engine did not start".into()
                })))
            }
        }
    }

    /// Says `request`'s text into its WAV file; how many samples it holds.
    pub async fn say(&mut self, request: &Request) -> Result<usize> {
        let mut line = serde_json::to_string(request).map_err(|e| Error::msg(e.to_string()))?;
        line.push('\n');
        let sent = self.stdin.write_all(line.as_bytes()).await;
        sent.map_err(|_| self.gone())?;
        self.stdin.flush().await.map_err(|_| self.gone())?;
        match self.answer().await? {
            Answer {
                samples: Some(n), ..
            } => Ok(n),
            other => {
                Err(Error::msg(other.error.unwrap_or_else(|| {
                    "the speech engine gave no audio".into()
                })))
            }
        }
    }

    /// Close stdin so the worker unloads the model and exits normally.
    pub async fn shutdown(mut self) -> Result<()> {
        drop(self.stdin);
        let status = tokio::time::timeout(std::time::Duration::from_secs(10), self.child.wait())
            .await
            .map_err(|_| Error::msg("the speech engine did not shut down"))??;
        if !status.success() {
            return Err(Error::msg(format!(
                "the speech engine exited with {status}"
            )));
        }
        Ok(())
    }

    async fn answer(&mut self) -> Result<Answer> {
        let line = self.lines.next_line().await.ok().flatten();
        let line = line.ok_or_else(|| self.gone())?;
        serde_json::from_str(&line).map_err(|_| self.gone())
    }

    fn gone(&mut self) -> Error {
        let status = self.child.try_wait().ok().flatten();
        let _ = self.child.start_kill();
        Error::msg(match status {
            Some(status) => format!("the speech engine stopped unexpectedly ({status}); check available memory and re-download the voice model"),
            None => "the speech engine stopped unexpectedly; check available memory and re-download the voice model".into(),
        })
    }
}

/// The worker process's main: loads the model in `model_dir`, then says each request read
/// from stdin until it closes. Returns the process's exit code.
pub fn worker_main(model_dir: &Path) -> i32 {
    let stdout = std::io::stdout();
    let send = |answer: Answer| {
        let mut out = stdout.lock();
        let _ = serde_json::to_writer(&mut out, &answer);
        let _ = out.write_all(b"\n");
        let _ = out.flush();
    };
    let threads = std::thread::available_parallelism().map_or(4, |n| n.get().min(8));
    let onnx = model_dir.join(super::MODEL_FILE);
    let mut model = match kitten::Model::load(&onnx, &model_dir.join(super::VOICES_FILE), threads) {
        Ok(model) => model,
        Err(e) => {
            send(Answer {
                error: Some(format!("{e}; download the narration voice model again")),
                ..Answer::default()
            });
            return 1;
        }
    };
    send(Answer {
        ready: true,
        ..Answer::default()
    });
    for line in std::io::stdin().lock().lines() {
        let Ok(line) = line else { break };
        let answer = match serde_json::from_str::<Request>(&line) {
            Ok(request) => match say(&mut model, &request) {
                Ok(samples) => Answer {
                    samples: Some(samples),
                    ..Answer::default()
                },
                Err(e) => Answer {
                    error: Some(e.to_string()),
                    ..Answer::default()
                },
            },
            Err(e) => Answer {
                error: Some(format!("invalid speech request: {e}")),
                ..Answer::default()
            },
        };
        send(answer);
    }
    0
}

/// Says `request`'s script piece by piece and writes it, joined, to its WAV file.
fn say(model: &mut kitten::Model, request: &Request) -> Result<usize> {
    if !model.has_voice(&request.speaker) {
        return Err(Error::msg(format!(
            "the voice model has no voice {:?}",
            request.speaker
        )));
    }
    let mut said = Vec::new();
    for piece in audio::pieces(&request.text) {
        let samples = speak(model, &piece.text, &request.speaker)?;
        if samples.is_empty() || samples.iter().any(|s| !s.is_finite()) {
            return Err(Error::msg(
                "the speech engine could not say this; try shorter sentences",
            ));
        }
        said.push((piece, samples));
    }
    let joined = audio::join(&said);
    audio::write_wav(&request.output, &joined, audio::RATE)?;
    Ok(joined.len())
}

/// `text` said in `voice`: at once if the model reads that many phonemes at once, otherwise
/// in halves split between words.
fn speak(model: &mut kitten::Model, text: &str, voice: &str) -> Result<Vec<f32>> {
    let ids = model.tokens(text);
    if ids.len() <= kitten::MAX_TOKENS {
        return model.speak(text, ids, voice);
    }
    let Some((first, second)) = halves(text) else {
        return Err(Error::msg(
            "the speech engine could not say this; try shorter sentences",
        ));
    };
    let mut samples = speak(model, first, voice)?;
    samples.extend(speak(model, second, voice)?);
    Ok(samples)
}

/// `text` split at the space nearest its middle; None for one word.
fn halves(text: &str) -> Option<(&str, &str)> {
    let middle = text.len() / 2;
    let at = text
        .match_indices(' ')
        .map(|(at, _)| at)
        .min_by_key(|at| at.abs_diff(middle))?;
    Some((text[..at].trim(), text[at..].trim()))
}

#[cfg(test)]
mod tests {
    use super::*;

    // The test executable serves as the real worker too, before libtest parses args.
    #[ctor::ctor(unsafe)]
    fn worker_entry() {
        let args: Vec<_> = std::env::args_os().collect();
        if args.get(1).is_some_and(|arg| arg == WORKER_FLAG) {
            std::process::exit(worker_main(Path::new(&args[2])));
        }
    }

    #[tokio::test]
    async fn missing_model_in_unicode_path_reports_failure_and_exits() {
        let dir = std::env::temp_dir().join(format!("missing voice 模型 {}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let result = tokio::time::timeout(std::time::Duration::from_secs(30), Worker::start(&dir))
            .await
            .expect("worker must not hang on a missing model");
        assert!(result.is_err());
        std::fs::remove_dir(dir).unwrap();
    }

    #[test]
    fn long_text_is_halved_between_words() {
        assert_eq!(
            halves("one two three four"),
            Some(("one two", "three four"))
        );
        assert_eq!(halves("one two"), Some(("one", "two")));
        assert_eq!(halves("one"), None);
    }

    #[test]
    fn answers_are_one_short_json_object() {
        let ready = Answer {
            ready: true,
            ..Answer::default()
        };
        assert_eq!(serde_json::to_string(&ready).unwrap(), r#"{"ready":true}"#);
        let done = Answer {
            samples: Some(5),
            ..Answer::default()
        };
        assert_eq!(serde_json::to_string(&done).unwrap(), r#"{"samples":5}"#);
        let parsed: Answer = serde_json::from_str(r#"{"error":"no"}"#).unwrap();
        assert_eq!(parsed.error.as_deref(), Some("no"));
        assert!(!parsed.ready);
    }
}
