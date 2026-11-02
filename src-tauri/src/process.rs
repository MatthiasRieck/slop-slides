//! Agent subprocesses. Unix keeps the direct CLI launch. On Windows an npm CLI's `.cmd`
//! launcher is not the agent: killing it alone leaves Node and its tools alive. A small
//! supervisor puts itself in a kill-on-close Job Object before starting any CLI. Killing
//! or dropping the supervisor then closes its job handle and stops just that process tree.

use std::path::Path;

use tokio::process::Command;

#[cfg(windows)]
const WORKER_FLAG: &str = "--agent-process";

/// An agent command, including automatic cleanup on cancellation or an early return.
pub fn command(program: &Path) -> std::io::Result<Command> {
    #[cfg(not(windows))]
    let mut command = Command::new(program);
    #[cfg(windows)]
    let mut command = {
        let mut command = Command::new(std::env::current_exe()?);
        command.arg(WORKER_FLAG).arg(program);
        command.creation_flags(0x0800_0000); // CREATE_NO_WINDOW; keep redirected stdio.
        command
    };
    command.kill_on_drop(true);
    Ok(command)
}

/// Dispatch before initializing Tauri. Stdio, environment and working directory came from
/// the caller and are inherited by the real CLI; arguments stay separate OS strings.
#[cfg(windows)]
pub fn worker_if_requested() {
    use std::ffi::OsStr;

    let mut args = std::env::args_os().skip(1);
    if args.next().as_deref() != Some(OsStr::new(WORKER_FLAG)) {
        return;
    }
    let Some(program) = args.next() else {
        eprintln!("missing agent executable");
        std::process::exit(1);
    };
    windows_job::run(&program, args);
}

#[cfg(windows)]
mod windows_job {
    use std::ffi::{OsStr, OsString};
    use std::os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle};
    use std::os::windows::process::CommandExt;

    use windows::core::PCWSTR;
    use windows::Win32::Foundation::HANDLE;
    use windows::Win32::System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
        SetInformationJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
        JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    };
    use windows::Win32::System::Threading::GetCurrentProcess;

    fn contain_current_process() -> windows::core::Result<OwnedHandle> {
        // SAFETY: create an unnamed, non-inheritable job; OwnedHandle closes it on setup
        // failure. Only this supervisor owns its handle, never the CLI or its descendants.
        let job = unsafe { CreateJobObjectW(None, PCWSTR::null())? };
        let job = unsafe { OwnedHandle::from_raw_handle(job.0) };
        let handle = HANDLE(job.as_raw_handle());
        let mut limits = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
        limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        // SAFETY: the structure has the class and size expected by this call; the process
        // handle refers to this supervisor. No CLI can start before assignment succeeds.
        unsafe {
            SetInformationJobObject(
                handle,
                JobObjectExtendedLimitInformation,
                (&limits as *const JOBOBJECT_EXTENDED_LIMIT_INFORMATION).cast(),
                std::mem::size_of_val(&limits) as u32,
            )?;
            AssignProcessToJobObject(handle, GetCurrentProcess())?;
        }
        Ok(job)
    }

    pub fn run(program: &OsStr, args: impl Iterator<Item = OsString>) -> ! {
        let _job = match contain_current_process() {
            Ok(job) => job,
            Err(error) => {
                eprintln!("could not contain the agent process: {error}");
                std::process::exit(1);
            }
        };
        let status = std::process::Command::new(program)
            .args(args)
            .creation_flags(0x0800_0000)
            .status();
        let code = match status {
            Ok(status) => status.code().unwrap_or(1),
            Err(error) => {
                eprintln!("could not start {}: {error}", program.to_string_lossy());
                1
            }
        };
        // Do not drop the job while this process is still running: it belongs to the job
        // too. Process exit closes the handle, preserving the CLI's exit code and stopping
        // any tools it left behind. Forced termination closes the same handle in the OS.
        std::process::exit(code);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Read;
    use std::path::PathBuf;
    use std::process::Stdio;
    use std::time::Duration;
    use tokio::io::AsyncWriteExt;

    const FIXTURE_FLAG: &str = "--slopslide-process-fixture";

    // Like the Codex protocol fixture, dispatch before the Rust test harness. No accounts,
    // inference, GUI windows or external tools are involved in these process tests.
    #[ctor::ctor(unsafe)]
    fn fixture_when_spawned() {
        #[cfg(windows)]
        worker_if_requested();
        let args: Vec<String> = std::env::args().collect();
        if args.get(1).map(String::as_str) != Some(FIXTURE_FLAG) {
            return;
        }
        match args[2].as_str() {
            "echo" => {
                let mut input = String::new();
                std::io::stdin().read_to_string(&mut input).unwrap();
                println!(
                    "{}",
                    serde_json::json!({
                        "args": &args[3..], "input": input,
                        "cwd": std::env::current_dir().unwrap(),
                        "env": std::env::var("SLOPSLIDE_PROCESS_TEST").unwrap(),
                    })
                );
                eprintln!("fixture stderr");
                std::process::exit(23);
            }
            #[cfg(windows)]
            "tree" => tree_fixture(Path::new(&args[3])),
            #[cfg(windows)]
            "child" => {
                let root = Path::new(&args[3]);
                std::fs::write(root.join("child.pid"), std::process::id().to_string()).unwrap();
                std::thread::sleep(Duration::from_secs(20));
                std::process::exit(0);
            }
            _ => std::process::exit(2),
        }
    }

    struct Temp(PathBuf);

    impl Temp {
        fn new() -> Self {
            let root =
                std::env::temp_dir().join(format!("slopslide-process-{}", uuid::Uuid::new_v4()));
            std::fs::create_dir_all(&root).unwrap();
            Self(root)
        }
    }

    impl Drop for Temp {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    #[tokio::test]
    async fn forwards_stdio_arguments_environment_cwd_and_exit_status() {
        let temp = Temp::new();
        assert_forwarded(&std::env::current_exe().unwrap(), &temp).await;
        #[cfg(windows)]
        assert_forwarded(&batch_launcher(&temp.0), &temp).await;
    }

    async fn assert_forwarded(program: &Path, temp: &Temp) {
        let arguments = [
            "two words",
            "café",
            "\"quoted\"",
            r#"{"cwd":"C:\my talks","enabled":true}"#,
        ];
        let mut command = command(program).unwrap();
        command
            .args([FIXTURE_FLAG, "echo"])
            .args(arguments)
            .env("SLOPSLIDE_PROCESS_TEST", "a b=c")
            .current_dir(&temp.0)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        let mut child = command.spawn().unwrap();
        child
            .stdin
            .take()
            .unwrap()
            .write_all(b"hello\n")
            .await
            .unwrap();
        let output = tokio::time::timeout(Duration::from_secs(10), child.wait_with_output())
            .await
            .unwrap()
            .unwrap();
        assert_eq!(output.status.code(), Some(23));
        let value: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();
        assert_eq!(value["args"], serde_json::json!(arguments));
        assert_eq!(value["input"], "hello\n");
        assert_eq!(value["env"], "a b=c");
        assert_eq!(
            PathBuf::from(value["cwd"].as_str().unwrap())
                .canonicalize()
                .unwrap(),
            temp.0.canonicalize().unwrap()
        );
        assert!(String::from_utf8_lossy(&output.stderr).contains("fixture stderr"));
    }

    #[cfg(windows)]
    fn batch_launcher(root: &Path) -> PathBuf {
        let wrapper = root.join("agent launcher.cmd");
        std::fs::write(
            &wrapper,
            format!(
                "@echo off\r\n\"{}\" %*\r\n",
                std::env::current_exe().unwrap().display()
            ),
        )
        .unwrap();
        wrapper
    }

    #[cfg(windows)]
    fn tree_fixture(root: &Path) -> ! {
        use std::os::windows::process::CommandExt;

        let child = std::process::Command::new(std::env::current_exe().unwrap())
            .args([FIXTURE_FLAG, "child"])
            .arg(root)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .creation_flags(0x0800_0000)
            .spawn()
            .unwrap();
        while !root.join("finish").exists() {
            std::thread::sleep(Duration::from_millis(20));
        }
        // Intentionally leave a running tool behind when the CLI exits normally.
        // The supervisor must clean up in this case as well as on cancellation.
        std::mem::forget(child);
        std::process::exit(0);
    }

    #[cfg(windows)]
    struct Tree {
        child: tokio::process::Child,
        descendant: std::os::windows::io::OwnedHandle,
        temp: Temp,
    }

    #[cfg(windows)]
    impl Tree {
        async fn start(batch: bool) -> Self {
            use std::os::windows::io::FromRawHandle;
            use windows::Win32::System::Threading::{OpenProcess, PROCESS_SYNCHRONIZE};

            let temp = Temp::new();
            let program = if batch {
                batch_launcher(&temp.0)
            } else {
                std::env::current_exe().unwrap()
            };
            let mut command = command(&program).unwrap();
            let child = command
                .args([FIXTURE_FLAG, "tree"])
                .arg(&temp.0)
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .spawn()
                .unwrap();
            let pid_file = temp.0.join("child.pid");
            tokio::time::timeout(Duration::from_secs(10), async {
                while !pid_file.exists() {
                    tokio::time::sleep(Duration::from_millis(20)).await;
                }
            })
            .await
            .expect("agent tool did not start");
            let pid = std::fs::read_to_string(pid_file)
                .unwrap()
                .parse::<u32>()
                .unwrap();
            // Hold the actual process object before cancellation; PID reuse cannot turn a
            // successful termination check into a result about an unrelated process.
            let handle = unsafe { OpenProcess(PROCESS_SYNCHRONIZE, false, pid).unwrap() };
            let descendant =
                unsafe { std::os::windows::io::OwnedHandle::from_raw_handle(handle.0) };
            Self {
                child,
                descendant,
                temp,
            }
        }

        fn stopped(&self, wait: u32) -> bool {
            use std::os::windows::io::AsRawHandle;
            use windows::Win32::Foundation::{HANDLE, WAIT_OBJECT_0};
            use windows::Win32::System::Threading::WaitForSingleObject;

            unsafe {
                WaitForSingleObject(HANDLE(self.descendant.as_raw_handle()), wait) == WAIT_OBJECT_0
            }
        }
    }

    #[cfg(windows)]
    #[tokio::test]
    async fn killing_native_and_batch_agents_stops_their_tools() {
        for batch in [false, true] {
            let mut tree = Tree::start(batch).await;
            tree.child.kill().await.unwrap();
            assert!(
                tree.stopped(3000),
                "agent tool survived cancellation (batch={batch})"
            );
        }
    }

    #[cfg(windows)]
    #[tokio::test]
    async fn dropping_a_batch_agent_stops_its_tools() {
        let tree = Tree::start(true).await;
        let Tree {
            child,
            descendant,
            temp: _temp,
        } = tree;
        drop(child);
        use std::os::windows::io::AsRawHandle;
        use windows::Win32::Foundation::{HANDLE, WAIT_OBJECT_0};
        use windows::Win32::System::Threading::WaitForSingleObject;
        assert_eq!(
            unsafe { WaitForSingleObject(HANDLE(descendant.as_raw_handle()), 3000) },
            WAIT_OBJECT_0
        );
    }

    #[cfg(windows)]
    #[tokio::test]
    async fn normal_exit_cleans_up_tools_without_stopping_another_agent() {
        let mut first = Tree::start(true).await;
        let mut other = Tree::start(true).await;
        std::fs::write(first.temp.0.join("finish"), "").unwrap();
        let status = tokio::time::timeout(Duration::from_secs(5), first.child.wait())
            .await
            .unwrap()
            .unwrap();
        assert!(status.success());
        assert!(first.stopped(3000));
        assert!(!other.stopped(0), "another agent's job was terminated");
        other.child.kill().await.unwrap();
        assert!(other.stopped(3000));
    }
}
