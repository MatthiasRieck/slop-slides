//! Which agent CLIs are installed and which models each offers. Codex and Copilot report
//! the models available to the signed-in account (`codex app-server`'s `model/list`,
//! `copilot --server`'s `models.list`); Claude Code has no such query, so its catalog is
//! fixed here.

use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;

use serde::Serialize;

use crate::error::{Error, Result};
use crate::{codex, copilot, env, extensions};

const PROBE_TIMEOUT: Duration = Duration::from_secs(15);
/// How long a CLI gets to answer a question about itself (its version, whether it is signed
/// in): it asks nobody else, so it answers at once or not at all.
const LOCAL_TIMEOUT: Duration = Duration::from_secs(5);
const CLAUDE_EFFORTS: [&str; 5] = ["low", "medium", "high", "xhigh", "max"];
/// Context window sizes Claude Code can run a model with; `1m` is requested with the
/// `[1m]` model suffix (see `claude::model`).
pub const CLAUDE_CONTEXT_WINDOWS: [&str; 2] = ["200k", "1m"];
/// Id, label, and default context window (`None`: the model has a single, fixed window).
const CLAUDE_MODELS: [(&str, &str, Option<&str>); 6] = [
    ("claude-opus-5-5", "Claude Opus 5.5", Some("1m")),
    ("claude-fable-5-1", "Claude Fable 5.1", Some("1m")),
    ("claude-opus-5", "Claude Opus 5", Some("1m")),
    ("claude-sonnet-5-5", "Claude Sonnet 5.5", Some("200k")),
    ("claude-sonnet-5", "Claude Sonnet 5", Some("200k")),
    ("claude-haiku-4-5", "Claude Haiku 4.5", None),
];

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderInfo {
    id: &'static str,
    installed: bool,
    path: Option<String>,
    models: Vec<ModelInfo>,
    /// Set when the CLI is installed but its models could not be listed.
    error: Option<String>,
    /// What `<cli> --version` reports; None when it is not installed or does not say.
    version: Option<String>,
    auth: Auth,
}

/// Whether a provider's CLI is signed in to an account, as far as it tells without a request
/// to a model.
#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Auth {
    SignedIn,
    SignedOut,
    /// Not installed, or the CLI did not answer.
    Unknown,
}

#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ModelInfo {
    pub id: String,
    pub label: String,
    pub is_default: bool,
    pub efforts: Vec<String>,
    pub default_effort: Option<String>,
    /// Selectable context window sizes; empty when the provider picks it.
    pub context_windows: Vec<String>,
    pub default_context_window: Option<String>,
}

/// Every provider, each asked at the same time as the others, and each of its questions (its
/// models, its version) at the same time too: the list takes as long as its slowest answer.
pub async fn list() -> Vec<ProviderInfo> {
    let (claude, codex, copilot) = tokio::join!(claude(), codex(), copilot());
    vec![claude, codex, copilot]
}

async fn claude() -> ProviderInfo {
    let path = env::resolve_claude();
    let (version, auth) = match &path {
        Some(path) => tokio::join!(version(path), claude_auth(path)),
        None => (None, Auth::Unknown),
    };
    let models = if path.is_some() {
        CLAUDE_MODELS
            .iter()
            .enumerate()
            .map(|(i, (id, label, context_window))| ModelInfo {
                id: id.to_string(),
                label: label.to_string(),
                is_default: i == 0,
                efforts: CLAUDE_EFFORTS.map(String::from).to_vec(),
                default_effort: Some("medium".into()),
                context_windows: match context_window {
                    Some(_) => CLAUDE_CONTEXT_WINDOWS.map(String::from).to_vec(),
                    None => Vec::new(),
                },
                default_context_window: context_window.map(String::from),
            })
            .collect()
    } else {
        Vec::new()
    };
    ProviderInfo {
        id: "claude",
        installed: path.is_some(),
        path: path.map(|p| p.to_string_lossy().into_owned()),
        models,
        error: None,
        version,
        auth,
    }
}

/// What `<cli> <args>` prints, as (stdout, stderr); None when it does not start or takes longer
/// than [`LOCAL_TIMEOUT`] (it is stopped then).
async fn said(cli: &Path, args: &[&str]) -> Option<(String, String)> {
    let mut command = crate::process::command(cli).ok()?;
    command
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let output = tokio::time::timeout(LOCAL_TIMEOUT, command.output())
        .await
        .ok()?
        .ok()?;
    let text = |bytes: &[u8]| String::from_utf8_lossy(bytes).into_owned();
    Some((text(&output.stdout), text(&output.stderr)))
}

/// The version `<cli> --version` reports.
async fn version(cli: &Path) -> Option<String> {
    let (stdout, stderr) = said(cli, &["--version"]).await?;
    parse_version(&stdout).or_else(|| parse_version(&stderr))
}

/// The first word of `output` that looks like a version: `2.1.327` of `2.1.327 (Claude Code)`,
/// `0.170.0` of `codex-cli 0.170.0`, `1.0.92` of `GitHub Copilot CLI 1.0.92.`.
fn parse_version(output: &str) -> Option<String> {
    output.split_whitespace().find_map(|word| {
        let word = word.trim_end_matches(|c: char| !c.is_ascii_alphanumeric());
        let word = word.strip_prefix('v').unwrap_or(word);
        let looks_like_one = word.starts_with(|c: char| c.is_ascii_digit())
            && word.contains('.')
            && word
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || ".-+".contains(c));
        looks_like_one.then(|| word.to_string())
    })
}

/// Whether Claude Code is signed in, from `claude auth status`: it reads what the CLI has
/// stored and asks no model.
async fn claude_auth(cli: &Path) -> Auth {
    // A CLI from before `auth status` would take the two words for a prompt and send them to a
    // model. Asked for help it only ever prints help, which tells whether it knows the command.
    let offered = said(cli, &["auth", "--help"])
        .await
        .is_some_and(|(help, _)| offers_auth_status(&help));
    if !offered {
        return Auth::Unknown;
    }
    match said(cli, &["auth", "status", "--json"]).await {
        Some((status, _)) => parse_claude_auth(&status),
        None => Auth::Unknown,
    }
}

/// Whether `help`, what `claude auth --help` printed, is the help of an `auth` command that has
/// `status`, not the CLI's own help.
fn offers_auth_status(help: &str) -> bool {
    help.contains("claude auth")
        && help
            .lines()
            .any(|line| line.split_whitespace().next() == Some("status"))
}

/// What `claude auth status --json` printed, as an [`Auth`]. A signed-out CLI prints the same
/// JSON (and exits with an error, which is why its exit code is not asked).
fn parse_claude_auth(status: &str) -> Auth {
    let logged_in = serde_json::from_str::<serde_json::Value>(status)
        .ok()
        .and_then(|status| status["loggedIn"].as_bool());
    match logged_in {
        Some(true) => Auth::SignedIn,
        Some(false) => Auth::SignedOut,
        None => Auth::Unknown,
    }
}

impl ProviderInfo {
    /// A provider whose CLI is not installed.
    fn missing(id: &'static str) -> Self {
        ProviderInfo {
            id,
            installed: false,
            path: None,
            models: Vec::new(),
            error: None,
            version: None,
            auth: Auth::Unknown,
        }
    }

    /// A provider whose CLI at `path`, of version `version`, listed `models`, or failed to;
    /// `no_models` tells what to do when it lists none. These CLIs list the models of the
    /// signed-in account: none means nobody is signed in.
    fn listed(
        id: &'static str,
        path: &Path,
        version: Option<String>,
        models: Result<Vec<ModelInfo>>,
        no_models: &str,
    ) -> Self {
        let (models, error, auth) = match models {
            Ok(models) if models.is_empty() => (models, Some(no_models.into()), Auth::SignedOut),
            Ok(models) => (models, None, Auth::SignedIn),
            Err(e) => (Vec::new(), Some(e.to_string()), Auth::Unknown),
        };
        ProviderInfo {
            id,
            installed: true,
            path: Some(path.to_string_lossy().into_owned()),
            models,
            error,
            version,
            auth,
        }
    }
}

/// What `list` resolves to, or `late` if it takes longer than [`PROBE_TIMEOUT`].
async fn probe(
    list: impl std::future::Future<Output = Result<Vec<ModelInfo>>>,
    late: &str,
) -> Result<Vec<ModelInfo>> {
    tokio::time::timeout(PROBE_TIMEOUT, list)
        .await
        .unwrap_or_else(|_| Err(Error::msg(late)))
}

async fn codex() -> ProviderInfo {
    let Some(path) = env::resolve_codex() else {
        return ProviderInfo::missing("codex");
    };
    let (models, version) = tokio::join!(
        probe(codex::list_models(&path), "Codex did not answer in time."),
        version(&path)
    );
    ProviderInfo::listed(
        "codex",
        &path,
        version,
        models,
        "Codex reported no models. Run `codex` to sign in.",
    )
}

async fn copilot() -> ProviderInfo {
    let Some(path) = env::resolve_copilot() else {
        return ProviderInfo::missing("copilot");
    };
    let (models, version) = tokio::join!(
        probe(
            copilot::list_models(&path),
            "GitHub Copilot did not answer in time.",
        ),
        version(&path)
    );
    ProviderInfo::listed(
        "copilot",
        &path,
        version,
        models,
        "GitHub Copilot reported no models. Run `copilot` and use /login to sign in.",
    )
}

/// One thing the agents need from the machine besides their own CLI, for Settings › Providers.
#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct EnvironmentCheck {
    id: &'static str,
    ok: bool,
    /// What was found, or what is wrong.
    detail: String,
}

/// The checks of the environment: `git` is there, and the MCP servers shared by all decks
/// (`mcp.json` in `home`, the app's folder) can be read.
pub fn check_environment(home: &Path) -> Vec<EnvironmentCheck> {
    // `git` is on the PATH of the user's shell.
    env::ready();
    vec![git_check(which::which("git").ok()), mcp_check(home)]
}

fn git_check(found: Option<PathBuf>) -> EnvironmentCheck {
    EnvironmentCheck {
        id: "git",
        ok: found.is_some(),
        detail: match found {
            Some(path) => path.to_string_lossy().into_owned(),
            None => "git was not found.".into(),
        },
    }
}

fn mcp_check(home: &Path) -> EnvironmentCheck {
    let file = home.join(extensions::MCP_FILE);
    let read = match std::fs::read_to_string(&file) {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            let detail = format!(
                "No ~/{}/{}; nothing to load.",
                crate::files::HOME_DIR,
                extensions::MCP_FILE
            );
            return EnvironmentCheck {
                id: "mcpConfig",
                ok: true,
                detail,
            };
        }
        Err(e) => Err(e.to_string()),
        Ok(raw) => extensions::check_mcp_servers(&raw),
    };
    EnvironmentCheck {
        id: "mcpConfig",
        ok: read.is_ok(),
        detail: match read {
            Ok(()) => file.to_string_lossy().into_owned(),
            Err(why) => why,
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::TempDir;

    #[test]
    fn reports_what_listing_the_models_found() {
        let path = Path::new("/bin/codex");
        let model = |id: &str| ModelInfo {
            id: id.into(),
            label: id.into(),
            is_default: false,
            efforts: Vec::new(),
            default_effort: None,
            context_windows: Vec::new(),
            default_context_window: None,
        };
        let version = || Some("0.170.0".to_string());
        let listed =
            ProviderInfo::listed("codex", path, version(), Ok(vec![model("a")]), "Sign in.");
        assert!(listed.installed && listed.error.is_none());
        assert_eq!(listed.version.as_deref(), Some("0.170.0"));
        assert_eq!(listed.auth, Auth::SignedIn);
        assert_eq!(listed.path.as_deref(), Some("/bin/codex"));
        assert_eq!(listed.models, [model("a")]);
        let none = ProviderInfo::listed("codex", path, version(), Ok(Vec::new()), "Sign in.");
        assert_eq!(none.error.as_deref(), Some("Sign in."));
        assert_eq!(none.auth, Auth::SignedOut, "no models: nobody is signed in");
        let failed = ProviderInfo::listed("codex", path, None, Err(Error::msg("boom")), "Sign in.");
        assert!(failed.installed && failed.models.is_empty());
        assert_eq!(failed.error.as_deref(), Some("boom"));
        assert_eq!(failed.auth, Auth::Unknown, "it did not say");
        assert_eq!(failed.version, None);
        let missing = ProviderInfo::missing("codex");
        assert!(!missing.installed && missing.path.is_none() && missing.error.is_none());
        assert_eq!((missing.version, missing.auth), (None, Auth::Unknown));
    }

    #[test]
    fn a_provider_goes_to_the_frontend_with_its_version_and_sign_in() {
        let info = ProviderInfo::listed(
            "codex",
            Path::new("/bin/codex"),
            Some("0.170.0".into()),
            Ok(Vec::new()),
            "Sign in.",
        );
        let json = serde_json::to_value(&info).unwrap();
        assert_eq!(json["version"], "0.170.0");
        assert_eq!(json["auth"], "signedOut");
        assert_eq!(
            serde_json::to_value(Auth::SignedIn).unwrap(),
            serde_json::json!("signedIn")
        );
        assert_eq!(
            serde_json::to_value(Auth::Unknown).unwrap(),
            serde_json::json!("unknown")
        );
        let missing = serde_json::to_value(ProviderInfo::missing("copilot")).unwrap();
        assert!(missing["version"].is_null());
        assert_eq!(missing["auth"], "unknown");
    }

    #[test]
    fn finds_the_version_in_what_each_cli_prints() {
        let version = |output: &str| parse_version(output);
        assert_eq!(
            version("2.1.327 (Claude Code)\n").as_deref(),
            Some("2.1.327")
        );
        assert_eq!(version("codex-cli 0.170.0\n").as_deref(), Some("0.170.0"));
        assert_eq!(
            version("GitHub Copilot CLI 1.0.92.\nRun 'copilot update' to check for updates.\n")
                .as_deref(),
            Some("1.0.92")
        );
        assert_eq!(
            version("tool v1.2.3-beta.1+build5").as_deref(),
            Some("1.2.3-beta.1+build5")
        );
        assert_eq!(version("version 7"), None, "a lone number is not a version");
        assert_eq!(version("command not found: 1.x/y"), None);
        assert_eq!(version(""), None);
    }

    #[test]
    fn reads_whether_claude_code_is_signed_in() {
        assert_eq!(
            parse_claude_auth(r#"{"loggedIn": true, "authMethod": "claude.ai"}"#),
            Auth::SignedIn
        );
        assert_eq!(
            parse_claude_auth(r#"{"loggedIn": false, "authMethod": "none"}"#),
            Auth::SignedOut
        );
        assert_eq!(
            parse_claude_auth(r#"{"authMethod": "none"}"#),
            Auth::Unknown
        );
        assert_eq!(parse_claude_auth("Not logged in."), Auth::Unknown);
        assert_eq!(parse_claude_auth(""), Auth::Unknown);
    }

    #[test]
    fn asks_claude_code_for_its_sign_in_only_when_it_has_the_command() {
        let auth_help = "Usage: claude auth [options] [command]\n\nManage authentication\n\n\
                         Commands:\n  login [options]   Sign in\n  status [options]  Show \
                         authentication status\n";
        assert!(offers_auth_status(auth_help));
        // A CLI without the command answers with its own help.
        let own_help = "Usage: claude [options] [command] [prompt]\n\nCommands:\n  \
                        mcp     Configure servers\n  doctor  Show the status of the updater\n";
        assert!(!offers_auth_status(own_help));
        assert!(!offers_auth_status(""));
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn asks_a_cli_for_its_version_and_its_sign_in() {
        let dir = TempDir::new("providers");
        let cli = dir.join("claude");
        crate::test_support::write_script(
            &cli,
            "#!/bin/sh\n\
             case \"$*\" in\n\
             --version) echo '9.8.7 (Claude Code)' ;;\n\
             'auth --help') echo 'Usage: claude auth [options] [command]'; echo '  status  Show' ;;\n\
             'auth status --json') echo '{\"loggedIn\": false}'; exit 1 ;;\n\
             esac\n",
        );
        assert_eq!(version(&cli).await.as_deref(), Some("9.8.7"));
        assert_eq!(claude_auth(&cli).await, Auth::SignedOut);

        // One that knows no `auth status` is never asked for it.
        let old = dir.join("old");
        let asked = dir.join("asked");
        crate::test_support::write_script(
            &old,
            &format!(
                "#!/bin/sh\n\
                 case \"$*\" in\n\
                 'auth --help') echo 'Usage: claude [options] [prompt]' ;;\n\
                 --version) echo 'no idea' >&2 ;;\n\
                 *) touch '{}' ;;\n\
                 esac\n",
                asked.display()
            ),
        );
        assert_eq!(claude_auth(&old).await, Auth::Unknown);
        assert!(!asked.exists(), "it would have been sent to a model");
        assert_eq!(version(&old).await, None);
        assert_eq!(version(&dir.join("missing")).await, None);
    }

    #[test]
    fn git_is_found_or_reported_missing() {
        let found = git_check(Some(PathBuf::from("/usr/bin/git")));
        assert_eq!(
            serde_json::to_value(&found).unwrap(),
            serde_json::json!({ "id": "git", "ok": true, "detail": "/usr/bin/git" })
        );
        let missing = git_check(None);
        assert!(!missing.ok);
        assert_eq!(missing.detail, "git was not found.");
    }

    #[test]
    fn the_shared_mcp_config_may_be_missing_but_not_broken() {
        let home = TempDir::new("providers-env");
        let missing = mcp_check(&home);
        assert_eq!(missing.id, "mcpConfig");
        assert!(missing.ok);
        assert_eq!(
            missing.detail,
            "No ~/.slopslides/mcp.json; nothing to load."
        );

        let file = home.write(
            "mcp.json",
            r#"{"mcpServers": {"docs": {"command": "docs"}}}"#,
        );
        let read = mcp_check(&home);
        assert!(read.ok);
        assert_eq!(read.detail, file.to_string_lossy());
        home.write("mcp.json", r#"{"docs": {"command": "docs"}}"#);
        assert!(mcp_check(&home).ok, "the servers may be the whole object");

        home.write("mcp.json", "{\"mcpServers\": {");
        let broken = mcp_check(&home);
        assert!(!broken.ok);
        assert!(broken.detail.contains("line 1"), "{}", broken.detail);

        home.write("mcp.json", r#"{"mcpServers": ["docs"]}"#);
        let odd = mcp_check(&home);
        assert!(!odd.ok);
        assert_eq!(odd.detail, "Expected an object of MCP servers.");
        home.write("mcp.json", r#"{"docs": "npx docs"}"#);
        let odd = mcp_check(&home);
        assert!(!odd.ok);
        assert_eq!(odd.detail, "MCP server `docs`: expected an object.");
    }

    #[test]
    fn the_environment_is_checked_for_git_and_the_mcp_config() {
        let home = TempDir::new("providers-env");
        let checks = check_environment(&home);
        let ids: Vec<_> = checks.iter().map(|check| check.id).collect();
        assert_eq!(ids, ["git", "mcpConfig"]);
    }
}
