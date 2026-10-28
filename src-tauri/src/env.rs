//! Process environment for spawning agent CLIs (Claude Code, Codex, Copilot) from a GUI app.

use std::path::PathBuf;

const MARKER: &str = "__SLOPSLIDE_ENV__";

/// Shell bookkeeping that describes the probe shell, not the user's environment.
const SKIPPED: &[&str] = &["PWD", "OLDPWD", "SHLVL", "_"];

/// GUI apps on macOS and Linux start with a minimal environment. Adopt the user's login-shell
/// environment so `claude` (and the tools it shells out to) resolve as they do in a terminal,
/// and see what the terminal sees: PATH, but also proxy settings (`HTTPS_PROXY`, `NO_PROXY`),
/// custom CA bundles (`NODE_EXTRA_CA_CERTS`) and provider config exported in shell profiles.
pub fn adopt_login_shell_env() {
    #[cfg(unix)]
    {
        use std::io::Read;
        use std::process::{Command, Stdio};
        use std::time::Duration;

        let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".into());
        let Ok(mut child) = Command::new(shell)
            .args([
                "-ilc",
                &format!("printf '{MARKER}'; /usr/bin/env -0; printf '{MARKER}'"),
            ])
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
        else {
            return;
        };
        // Drain stdout on a thread so a large environment cannot fill the pipe and stall the shell.
        let mut stdout = child.stdout.take().expect("stdout is piped");
        let (tx, rx) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            let mut out = Vec::new();
            let _ = stdout.read_to_end(&mut out);
            let _ = tx.send(out);
        });
        // A misbehaving shell profile must not hang app startup.
        let Ok(out) = rx.recv_timeout(Duration::from_secs(4)) else {
            let _ = child.kill();
            let _ = child.wait();
            return;
        };
        let _ = child.wait();
        for (key, value) in parse_env(&String::from_utf8_lossy(&out)) {
            std::env::set_var(key, value);
        }
    }
}

/// The variables between the markers of `env -0` output, minus shell bookkeeping. Anything a
/// profile prints before or after (banners, motd) falls outside the markers and is ignored.
fn parse_env(stdout: &str) -> Vec<(&str, &str)> {
    let Some(block) = stdout.split(MARKER).nth(1) else {
        return Vec::new();
    };
    block
        .split('\0')
        .filter_map(|entry| entry.split_once('='))
        .filter(|(key, _)| !key.is_empty() && !SKIPPED.contains(key))
        .collect()
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

    fn probe(env: &str) -> String {
        format!("Welcome!\n{MARKER}{env}{MARKER}bye\n")
    }

    #[test]
    fn adopts_proxy_and_path_from_the_login_shell() {
        let out = probe(
            "PATH=/opt/homebrew/bin:/usr/bin\0HTTPS_PROXY=http://proxy.corp:8080\0\
             no_proxy=localhost,.corp\0NODE_EXTRA_CA_CERTS=/etc/corp.pem\0",
        );
        assert_eq!(
            parse_env(&out),
            vec![
                ("PATH", "/opt/homebrew/bin:/usr/bin"),
                ("HTTPS_PROXY", "http://proxy.corp:8080"),
                ("no_proxy", "localhost,.corp"),
                ("NODE_EXTRA_CA_CERTS", "/etc/corp.pem"),
            ]
        );
    }

    #[test]
    fn keeps_values_with_newlines_and_equals_signs() {
        let out = probe("MULTI=line one\nline two\0OPTS=--a=b\0");
        assert_eq!(
            parse_env(&out),
            vec![("MULTI", "line one\nline two"), ("OPTS", "--a=b")]
        );
    }

    #[test]
    fn skips_shell_bookkeeping_and_malformed_entries() {
        let out = probe("PWD=/tmp\0OLDPWD=/\0SHLVL=2\0_=/usr/bin/env\0=x\0junk\0HOME=/Users/me\0");
        assert_eq!(parse_env(&out), vec![("HOME", "/Users/me")]);
    }

    #[test]
    fn ignores_output_without_markers() {
        assert!(parse_env("zsh: command not found: env\n").is_empty());
        assert!(parse_env("").is_empty());
    }

    #[cfg(unix)]
    #[test]
    fn a_real_shell_round_trips_through_the_parser() {
        let out = std::process::Command::new("/bin/sh")
            .args([
                "-c",
                &format!(
                    "printf '{MARKER}'; SLOPSLIDE_PROBE='a b=c' /usr/bin/env -0; printf '{MARKER}'"
                ),
            ])
            .output()
            .unwrap();
        let stdout = String::from_utf8_lossy(&out.stdout);
        assert!(parse_env(&stdout).contains(&("SLOPSLIDE_PROBE", "a b=c")));
    }

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
