//! Which agent CLIs are installed and which models each offers. Codex and Copilot report
//! the models available to the signed-in account (`codex app-server`'s `model/list`,
//! `copilot --server`'s `models.list`); Claude Code has no such query, so its catalog is
//! fixed here.

use std::path::Path;
use std::time::Duration;

use serde::Serialize;

use crate::error::{Error, Result};
use crate::{codex, copilot, env};

const PROBE_TIMEOUT: Duration = Duration::from_secs(15);
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

pub async fn list() -> Vec<ProviderInfo> {
    let (codex, copilot) = tokio::join!(codex(), copilot());
    vec![claude(), codex, copilot]
}

fn claude() -> ProviderInfo {
    let path = env::resolve_claude();
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
        }
    }

    /// A provider whose CLI at `path` listed `models`, or failed to; `no_models` tells what
    /// to do when it lists none.
    fn listed(
        id: &'static str,
        path: &Path,
        models: Result<Vec<ModelInfo>>,
        no_models: &str,
    ) -> Self {
        let (models, error) = match models {
            Ok(models) if models.is_empty() => (models, Some(no_models.into())),
            Ok(models) => (models, None),
            Err(e) => (Vec::new(), Some(e.to_string())),
        };
        ProviderInfo {
            id,
            installed: true,
            path: Some(path.to_string_lossy().into_owned()),
            models,
            error,
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
    let models = probe(codex::list_models(&path), "Codex did not answer in time.").await;
    ProviderInfo::listed(
        "codex",
        &path,
        models,
        "Codex reported no models. Run `codex` to sign in.",
    )
}

async fn copilot() -> ProviderInfo {
    let Some(path) = env::resolve_copilot() else {
        return ProviderInfo::missing("copilot");
    };
    let models = probe(
        copilot::list_models(&path),
        "GitHub Copilot did not answer in time.",
    )
    .await;
    ProviderInfo::listed(
        "copilot",
        &path,
        models,
        "GitHub Copilot reported no models. Run `copilot` and use /login to sign in.",
    )
}

#[cfg(test)]
mod tests {
    use super::*;

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
        let listed = ProviderInfo::listed("codex", path, Ok(vec![model("a")]), "Sign in.");
        assert!(listed.installed && listed.error.is_none());
        assert_eq!(listed.path.as_deref(), Some("/bin/codex"));
        assert_eq!(listed.models, [model("a")]);
        let none = ProviderInfo::listed("codex", path, Ok(Vec::new()), "Sign in.");
        assert_eq!(none.error.as_deref(), Some("Sign in."));
        let failed = ProviderInfo::listed("codex", path, Err(Error::msg("boom")), "Sign in.");
        assert!(failed.installed && failed.models.is_empty());
        assert_eq!(failed.error.as_deref(), Some("boom"));
        let missing = ProviderInfo::missing("codex");
        assert!(!missing.installed && missing.path.is_none() && missing.error.is_none());
    }
}
