//! The speech engine, Qwen3-TTS in C (vendor/qwen3-tts, compiled by build.rs), runs in a
//! worker process: the app started again with [`WORKER_FLAG`]. The engine may exit its
//! process on a damaged model, takes about 3 GB of memory while loaded, and is stopped by
//! killing it, so none of that touches the app.
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

use super::audio;
use crate::error::{Error, Result};

/// `slopslide --narration-worker <model dir>` runs the worker.
pub const WORKER_FLAG: &str = "--narration-worker";

/// The most frames (12 a second) the engine may make for one piece before it is given up on:
/// it did not find the end of what it was saying.
#[cfg(narration_engine)]
const MAX_FRAMES: i32 = 562;
/// The same seed for every piece, so the same script in the same voice sounds the same.
#[cfg(narration_engine)]
const SEED: u32 = 42;

/// Whether this build has the speech engine (see build.rs).
pub const AVAILABLE: bool = cfg!(narration_engine);

/// Something for the worker to say.
#[derive(Debug, Serialize, Deserialize)]
pub struct Request {
    pub text: String,
    /// The engine's speaker name, e.g. `ryan`.
    pub speaker: String,
    /// The engine's language name, e.g. `English`.
    pub language: String,
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
        let mut child = Command::new(exe)
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

    async fn answer(&mut self) -> Result<Answer> {
        let line = self.lines.next_line().await.ok().flatten();
        let line = line.ok_or_else(|| self.gone())?;
        serde_json::from_str(&line).map_err(|_| self.gone())
    }

    fn gone(&mut self) -> Error {
        let _ = self.child.start_kill();
        Error::msg("the speech engine stopped unexpectedly")
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
    let Some(engine) = Engine::load(model_dir) else {
        send(Answer {
            error: Some("cannot load the narration voice model; download it again".into()),
            ..Answer::default()
        });
        return 1;
    };
    send(Answer {
        ready: true,
        ..Answer::default()
    });
    for line in std::io::stdin().lock().lines() {
        let Ok(line) = line else { break };
        let answer = match serde_json::from_str::<Request>(&line) {
            Ok(request) => match say(&engine, &request) {
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
fn say(engine: &Engine, request: &Request) -> Result<usize> {
    let mut said = Vec::new();
    for piece in audio::pieces(&request.text) {
        let samples = engine.speak(&piece.text, &request.speaker, &request.language)?;
        said.push((piece, samples));
    }
    let joined = audio::join(&said);
    audio::write_wav(&request.output, &joined, audio::RATE)?;
    Ok(joined.len())
}

#[cfg(narration_engine)]
mod ffi {
    use std::ffi::{c_char, c_int, c_uint, c_void};

    extern "C" {
        pub fn slop_tts_load(model_dir: *const c_char, threads: c_int) -> *mut c_void;
        #[allow(clippy::too_many_arguments)]
        pub fn slop_tts_speak(
            ctx: *mut c_void,
            text: *const c_char,
            speaker: *const c_char,
            language: *const c_char,
            max_frames: c_int,
            seed: c_uint,
            cancel: Option<extern "C" fn(*mut c_void) -> c_int>,
            user: *mut c_void,
            audio: *mut *mut f32,
            samples: *mut c_int,
        ) -> c_int;
        pub fn slop_tts_free_audio(audio: *mut f32);
        pub fn slop_tts_unload(ctx: *mut c_void);
    }
}

/// The loaded model.
struct Engine {
    #[cfg(narration_engine)]
    ctx: *mut std::ffi::c_void,
}

#[cfg(narration_engine)]
impl Engine {
    fn load(model_dir: &Path) -> Option<Self> {
        let dir = std::ffi::CString::new(model_dir.to_string_lossy().as_bytes()).ok()?;
        let threads = std::thread::available_parallelism().map_or(4, |n| n.get().min(8));
        let ctx = unsafe { ffi::slop_tts_load(dir.as_ptr(), threads as i32) };
        (!ctx.is_null()).then_some(Engine { ctx })
    }

    /// `text` said by `speaker` in `language`, at [`audio::RATE`].
    fn speak(&self, text: &str, speaker: &str, language: &str) -> Result<Vec<f32>> {
        let c = |s: &str| std::ffi::CString::new(s).map_err(|_| Error::msg("invalid text"));
        let (text, speaker, language) = (c(text)?, c(speaker)?, c(language)?);
        let mut audio = std::ptr::null_mut();
        let mut samples = 0;
        let rc = unsafe {
            ffi::slop_tts_speak(
                self.ctx,
                text.as_ptr(),
                speaker.as_ptr(),
                language.as_ptr(),
                MAX_FRAMES,
                SEED,
                None,
                std::ptr::null_mut(),
                &mut audio,
                &mut samples,
            )
        };
        match rc {
            0 => {
                let out = unsafe { std::slice::from_raw_parts(audio, samples as usize) }.to_vec();
                unsafe { ffi::slop_tts_free_audio(audio) };
                Ok(out)
            }
            -1 => Err(Error::msg(format!(
                "the voice model has no voice {speaker:?} or language {language:?}"
            ))),
            _ => Err(Error::msg(
                "the speech engine could not say this; try shorter sentences",
            )),
        }
    }
}

#[cfg(narration_engine)]
impl Drop for Engine {
    fn drop(&mut self) {
        unsafe { ffi::slop_tts_unload(self.ctx) };
    }
}

#[cfg(not(narration_engine))]
impl Engine {
    fn load(_model_dir: &Path) -> Option<Self> {
        None
    }

    fn speak(&self, _text: &str, _speaker: &str, _language: &str) -> Result<Vec<f32>> {
        Err(Error::msg("this build has no speech engine"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

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
