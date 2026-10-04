//! Process environment for spawning Claude Code from a GUI app.

use std::path::PathBuf;

/// GUI apps on macOS and Linux start with a minimal PATH. Adopt the user's login-shell
/// PATH so `claude` (and the tools it shells out to) resolve as they do in a terminal.
pub fn adopt_login_shell_path() {
    #[cfg(unix)]
    {
        use std::process::{Command, Stdio};
        use std::time::{Duration, Instant};

        let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".into());
        let marker = "__SLOPSLIDE_PATH__";
        let Ok(mut child) = Command::new(shell)
            .args(["-ilc", &format!("printf '{marker}%s{marker}' \"$PATH\"")])
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
        else {
            return;
        };
        // A misbehaving shell profile must not hang app startup.
        let deadline = Instant::now() + Duration::from_secs(4);
        while Instant::now() < deadline {
            match child.try_wait() {
                Ok(Some(_)) => break,
                Ok(None) => std::thread::sleep(Duration::from_millis(25)),
                Err(_) => return,
            }
        }
        if child.try_wait().ok().flatten().is_none() {
            let _ = child.kill();
            return;
        }
        let Ok(output) = child.wait_with_output() else { return };
        let stdout = String::from_utf8_lossy(&output.stdout);
        if let Some(path) = stdout.split(marker).nth(1).filter(|p| !p.is_empty()) {
            std::env::set_var("PATH", path);
        }
    }
}

pub fn resolve_claude() -> Option<PathBuf> {
    if let Some(custom) = std::env::var_os("SLOPSLIDE_CLAUDE_PATH").map(PathBuf::from) {
        return custom.is_file().then_some(custom);
    }
    if let Ok(found) = which::which("claude") {
        return Some(found);
    }
    let home = std::env::var_os("HOME").or_else(|| std::env::var_os("USERPROFILE")).map(PathBuf::from)?;
    let mut candidates = vec![
        home.join(".claude/local/claude"),
        home.join(".local/bin/claude"),
        PathBuf::from("/opt/homebrew/bin/claude"),
        PathBuf::from("/usr/local/bin/claude"),
    ];
    if cfg!(windows) {
        candidates.push(home.join(".local\\bin\\claude.exe"));
        if let Some(appdata) = std::env::var_os("APPDATA").map(PathBuf::from) {
            candidates.push(appdata.join("npm\\claude.cmd"));
        }
    }
    candidates.into_iter().find(|p| p.is_file())
}
