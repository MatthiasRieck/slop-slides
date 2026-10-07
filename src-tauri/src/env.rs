//! Process environment for spawning agent CLIs (Claude Code, Codex, Copilot) from a GUI app.

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
        let Ok(output) = child.wait_with_output() else {
            return;
        };
        let stdout = String::from_utf8_lossy(&output.stdout);
        if let Some(path) = stdout.split(marker).nth(1).filter(|p| !p.is_empty()) {
            std::env::set_var("PATH", path);
        }
    }
}

pub fn resolve_claude() -> Option<PathBuf> {
    resolve_cli("claude", "SLOPSLIDE_CLAUDE_PATH", &[".claude/local/claude"])
}

pub fn resolve_codex() -> Option<PathBuf> {
    resolve_cli("codex", "SLOPSLIDE_CODEX_PATH", &[])
}

pub fn resolve_copilot() -> Option<PathBuf> {
    resolve_cli("copilot", "SLOPSLIDE_COPILOT_PATH", &[])
}

fn resolve_cli(name: &str, override_var: &str, extra: &[&str]) -> Option<PathBuf> {
    if let Some(custom) = std::env::var_os(override_var).map(PathBuf::from) {
        return custom.is_file().then_some(custom);
    }
    if let Ok(found) = which::which(name) {
        return Some(found);
    }
    let home = std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .map(PathBuf::from)?;
    let mut candidates: Vec<PathBuf> = extra.iter().map(|p| home.join(p)).collect();
    candidates.extend([
        home.join(".local/bin").join(name),
        PathBuf::from("/opt/homebrew/bin").join(name),
        PathBuf::from("/usr/local/bin").join(name),
    ]);
    if cfg!(windows) {
        candidates.push(home.join(".local\\bin").join(format!("{name}.exe")));
        if let Some(appdata) = std::env::var_os("APPDATA").map(PathBuf::from) {
            candidates.push(appdata.join("npm").join(format!("{name}.cmd")));
        }
    }
    candidates.into_iter().find(|p| p.is_file())
}

#[cfg(test)]
mod tests {
    use super::*;

    // The only test that touches SLOPSLIDE_CLAUDE_PATH, so parallel tests cannot race on it.
    #[test]
    fn custom_claude_path_must_be_a_file() {
        let dir = std::env::temp_dir().join(format!("slopslide-env-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let claude = dir.join("claude");
        std::fs::write(&claude, "").unwrap();

        std::env::set_var("SLOPSLIDE_CLAUDE_PATH", &claude);
        assert_eq!(resolve_claude(), Some(claude.clone()));
        // A bad override is reported as missing rather than silently falling back.
        std::env::set_var("SLOPSLIDE_CLAUDE_PATH", dir.join("nope"));
        assert_eq!(resolve_claude(), None);
        std::env::set_var("SLOPSLIDE_CLAUDE_PATH", &dir);
        assert_eq!(resolve_claude(), None, "a directory is not an executable");
        std::env::remove_var("SLOPSLIDE_CLAUDE_PATH");

        let _ = std::fs::remove_dir_all(&dir);
    }
}
