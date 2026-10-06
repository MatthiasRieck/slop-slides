//! Which agent CLIs are installed and which models each offers. Codex and Copilot report
//! the models available to the signed-in account (`codex app-server`'s `model/list`,
//! `copilot --server`'s `models.list`); Claude Code has no such query, so its catalog is
//! fixed here.

use std::path::Path;
use std::process::Stdio;
use std::time::Duration;

use serde::Serialize;
use serde_json::{json, Value};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader, Lines};
use tokio::process::{ChildStdin, ChildStdout, Command};

use crate::copilot;
use crate::env;
use crate::error::{Error, Result};

const PROBE_TIMEOUT: Duration = Duration::from_secs(15);
const CLAUDE_EFFORTS: [&str; 5] = ["low", "medium", "high", "xhigh", "max"];
const CLAUDE_MODELS: [(&str, &str); 6] = [
    ("claude-opus-5-5", "Claude Opus 5.5"),
    ("claude-fable-5-1", "Claude Fable 5.1"),
    ("claude-opus-5", "Claude Opus 5"),
    ("claude-sonnet-5-5", "Claude Sonnet 5.5"),
    ("claude-sonnet-5", "Claude Sonnet 5"),
    ("claude-haiku-4-5", "Claude Haiku 4.5"),
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
            .map(|(i, (id, label))| ModelInfo {
                id: id.to_string(),
                label: label.to_string(),
                is_default: i == 0,
                efforts: CLAUDE_EFFORTS.map(String::from).to_vec(),
                default_effort: Some("medium".into()),
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

async fn codex() -> ProviderInfo {
    let Some(path) = env::resolve_codex() else {
        return ProviderInfo {
            id: "codex",
            installed: false,
            path: None,
            models: Vec::new(),
            error: None,
        };
    };
    let result = tokio::time::timeout(PROBE_TIMEOUT, codex_models(&path))
        .await
        .unwrap_or_else(|_| Err(Error::msg("Codex did not answer in time.")));
    let (models, error) = match result {
        Ok(models) if models.is_empty() => (
            models,
            Some("Codex reported no models. Run `codex` to sign in.".into()),
        ),
        Ok(models) => (models, None),
        Err(e) => (Vec::new(), Some(e.to_string())),
    };
    ProviderInfo {
        id: "codex",
        installed: true,
        path: Some(path.to_string_lossy().into_owned()),
        models,
        error,
    }
}

async fn copilot() -> ProviderInfo {
    let Some(path) = env::resolve_copilot() else {
        return ProviderInfo {
            id: "copilot",
            installed: false,
            path: None,
            models: Vec::new(),
            error: None,
        };
    };
    let result = tokio::time::timeout(PROBE_TIMEOUT, copilot::list_models(&path))
        .await
        .unwrap_or_else(|_| Err(Error::msg("GitHub Copilot did not answer in time.")));
    let (models, error) = match result {
        Ok(models) if models.is_empty() => (
            models,
            Some(
                "GitHub Copilot reported no models. Run `copilot` and use /login to sign in."
                    .into(),
            ),
        ),
        Ok(models) => (models, None),
        Err(e) => (Vec::new(), Some(e.to_string())),
    };
    ProviderInfo {
        id: "copilot",
        installed: true,
        path: Some(path.to_string_lossy().into_owned()),
        models,
        error,
    }
}

/// Runs a short-lived `codex app-server`: initialize handshake, then every `model/list` page.
async fn codex_models(bin: &Path) -> Result<Vec<ModelInfo>> {
    let mut cmd = Command::new(bin);
    cmd.arg("app-server")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true);
    #[cfg(windows)]
    cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    let mut child = cmd
        .spawn()
        .map_err(|e| Error::msg(format!("Could not start Codex: {e}")))?;
    let mut rpc = Rpc {
        stdin: child.stdin.take().expect("piped stdin"),
        lines: BufReader::new(child.stdout.take().expect("piped stdout")).lines(),
        next_id: 0,
    };
    rpc.request(
        "initialize",
        json!({
            "clientInfo": {
                "name": "slopslide",
                "title": "SlopSlide",
                "version": env!("CARGO_PKG_VERSION"),
            },
        }),
    )
    .await?;
    rpc.notify("initialized").await?;

    let mut models = Vec::new();
    let mut cursor: Option<String> = None;
    loop {
        let params = match &cursor {
            Some(cursor) => json!({ "cursor": cursor }),
            None => json!({}),
        };
        let page = rpc.request("model/list", params).await?;
        models.extend(
            page["data"]
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(parse_codex_model),
        );
        cursor = page["nextCursor"].as_str().map(str::to_string);
        if cursor.is_none() {
            break;
        }
    }
    let _ = child.kill().await;
    Ok(models)
}

struct Rpc {
    stdin: ChildStdin,
    lines: Lines<BufReader<ChildStdout>>,
    next_id: u64,
}

impl Rpc {
    async fn send(&mut self, message: Value) -> Result<()> {
        let mut line = serde_json::to_vec(&message).expect("json");
        line.push(b'\n');
        self.stdin.write_all(&line).await?;
        self.stdin.flush().await?;
        Ok(())
    }

    async fn notify(&mut self, method: &str) -> Result<()> {
        self.send(json!({ "method": method })).await
    }

    async fn request(&mut self, method: &str, params: Value) -> Result<Value> {
        self.next_id += 1;
        let id = self.next_id;
        self.send(json!({ "id": id, "method": method, "params": params }))
            .await?;
        while let Some(line) = self.lines.next_line().await? {
            let Ok(message) = serde_json::from_str::<Value>(&line) else {
                continue;
            };
            // Skip notifications and server-initiated requests.
            if message.get("method").is_some() || message["id"].as_u64() != Some(id) {
                continue;
            }
            if let Some(error) = message.get("error") {
                let detail = error["message"].as_str().unwrap_or("unknown error");
                return Err(Error::msg(format!("Codex {method} failed: {detail}")));
            }
            return Ok(message["result"].clone());
        }
        Err(Error::msg("Codex exited before answering."))
    }
}

fn parse_codex_model(model: &Value) -> Option<ModelInfo> {
    if model["hidden"].as_bool().unwrap_or(false) {
        return None;
    }
    let id = model["model"].as_str()?.to_string();
    let name = model["displayName"].as_str().unwrap_or(&id);
    Some(ModelInfo {
        label: format_codex_name(name),
        is_default: model["isDefault"].as_bool().unwrap_or(false),
        efforts: model["supportedReasoningEfforts"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|e| e["reasoningEffort"].as_str().map(str::to_string))
            .collect(),
        default_effort: model["defaultReasoningEffort"].as_str().map(str::to_string),
        id,
    })
}

/// `gpt-6-astra` → `GPT-6-Astra`, matching T3 Code.
fn format_codex_name(name: &str) -> String {
    let name = match name.get(..3) {
        Some(prefix) if prefix.eq_ignore_ascii_case("gpt") => format!("GPT{}", &name[3..]),
        _ => name.to_string(),
    };
    let mut out = String::with_capacity(name.len());
    let mut after_dash = false;
    for c in name.chars() {
        out.push(if after_dash {
            c.to_ascii_uppercase()
        } else {
            c
        });
        after_dash = c == '-';
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_codex_models() {
        let model = json!({
            "id": "gpt-6-astra", "model": "gpt-6-astra", "displayName": "gpt-6-astra",
            "description": "", "hidden": false, "isDefault": true,
            "defaultReasoningEffort": "medium",
            "supportedReasoningEfforts": [
                {"reasoningEffort": "low", "description": ""},
                {"reasoningEffort": "high", "description": ""}
            ]
        });
        assert_eq!(
            parse_codex_model(&model),
            Some(ModelInfo {
                id: "gpt-6-astra".into(),
                label: "GPT-6-Astra".into(),
                is_default: true,
                efforts: vec!["low".into(), "high".into()],
                default_effort: Some("medium".into()),
            })
        );
        assert_eq!(
            parse_codex_model(&json!({"model": "x", "hidden": true})),
            None
        );
    }

    /// A stand-in `codex app-server` that answers by line order, paging `model/list` once.
    #[cfg(unix)]
    #[test]
    fn lists_models_over_app_server() {
        use std::os::unix::fs::PermissionsExt;

        let script = r#"#!/bin/sh
read -r _; echo '{"method":"thread/started","params":{}}'; echo '{"id":1,"result":{"userAgent":"mock/0"}}'
read -r _
read -r _; echo '{"id":2,"result":{"data":[{"model":"gpt-a","displayName":"gpt-a","hidden":false,"isDefault":true,"defaultReasoningEffort":"medium","supportedReasoningEfforts":[]}],"nextCursor":"p2"}}'
read -r _; echo '{"id":3,"result":{"data":[{"model":"gpt-b","displayName":"gpt-b","hidden":true,"isDefault":false,"supportedReasoningEfforts":[]},{"model":"gpt-c","displayName":"gpt-c","hidden":false,"isDefault":false,"supportedReasoningEfforts":[]}]}}'
"#;
        let path =
            std::env::temp_dir().join(format!("slopslide-mock-codex-{}", std::process::id()));
        std::fs::write(&path, script).unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        let models = runtime.block_on(codex_models(&path));
        let _ = std::fs::remove_file(&path);
        let ids: Vec<_> = models.unwrap().into_iter().map(|m| m.id).collect();
        assert_eq!(ids, ["gpt-a", "gpt-c"]);
    }

    #[test]
    fn formats_codex_names() {
        assert_eq!(format_codex_name("gpt-5.6-sol"), "GPT-5.6-Sol");
        assert_eq!(format_codex_name("GPT-6 Luna"), "GPT-6 Luna");
        assert_eq!(format_codex_name("o3"), "o3");
    }
}
