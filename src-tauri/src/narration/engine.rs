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

/// Report unsupported hardware before entering C code compiled with AVX2/FMA.
pub fn unavailable_reason() -> Option<&'static str> {
    if !AVAILABLE {
        return Some("This build has no narration engine. Install an official supported SlopSlide build; source builds need the BLAS dependencies described in docs/windows-narration.md.");
    }
    #[cfg(target_arch = "x86_64")]
    if !std::is_x86_feature_detected!("avx2") || !std::is_x86_feature_detected!("fma") {
        return Some("Local narration requires a CPU with AVX2 and FMA support.");
    }
    None
}

/// Also exposed by --narration-license so the linked dependency's notice is shipped
/// in the executable and can be read without opening the GUI.
pub fn license() -> &'static str {
    #[cfg(all(windows, narration_engine))]
    {
        include_str!(concat!(env!("OUT_DIR"), "/openblas-license.txt"))
    }
    #[cfg(not(all(windows, narration_engine)))]
    {
        "This build does not statically bundle OpenBLAS."
    }
}

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
        if let Some(reason) = unavailable_reason() {
            return Err(Error::msg(reason));
        }
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
    if let Some(reason) = unavailable_reason() {
        send(Answer {
            error: Some(reason.into()),
            ..Answer::default()
        });
        return 1;
    }
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
    #[allow(clippy::assertions_on_constants)] // Deliberately validate the build-script cfg.
    fn required_engine_is_compiled_in() {
        if std::env::var_os("SLOPSLIDE_REQUIRE_NARRATION_ENGINE").is_some()
            && std::env::var_os("SLOPSLIDE_NO_NARRATION_ENGINE").is_none()
        {
            assert!(AVAILABLE, "CI must test the enabled engine");
        }
    }

    #[cfg(all(windows, narration_engine))]
    #[test]
    fn windows_native_paths_mapping_allocation_and_concurrent_pool() {
        use std::io::{Seek, SeekFrom};
        use std::os::windows::io::AsRawHandle;
        extern "C" {
            fn slop_windows_mark_sparse(handle: *mut std::ffi::c_void) -> i32;
            fn slop_windows_regression(
                dir: *const std::ffi::c_char,
                file: *const std::ffi::c_char,
            ) -> i32;
        }
        let dir = std::env::temp_dir().join(format!("narration 空間 {}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("model ä.bin");
        let mut file = std::fs::File::create(&path).unwrap();
        assert_eq!(unsafe { slop_windows_mark_sparse(file.as_raw_handle()) }, 0);
        file.seek(SeekFrom::Start((1u64 << 32) + 16)).unwrap();
        file.write_all(b"tail").unwrap();
        drop(file);
        let cdir = std::ffi::CString::new(dir.to_str().unwrap()).unwrap();
        let cpath = std::ffi::CString::new(path.to_str().unwrap()).unwrap();
        let result = unsafe { slop_windows_regression(cdir.as_ptr(), cpath.as_ptr()) };
        std::fs::remove_dir_all(dir).unwrap();
        assert_eq!(
            result, 0,
            "native Windows regression failed at test.c line {result}"
        );
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
