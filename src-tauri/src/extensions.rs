//! The user's agent extensions, loaded for every provider alike: MCP servers, skills
//! (`<name>/SKILL.md`), plugins and instructions (`AGENTS.md`), from the app home
//! (`~/.slopslides`) and from the workspace:
//!
//! | | `~/.slopslides` | workspace |
//! |---|---|---|
//! | MCP servers | `mcp.json` | `.mcp.json` |
//! | skills | `skills/` | `.agents/skills/` |
//! | plugins | `plugins/<name>/` | `.agents/plugins/<name>/` |
//! | instructions | `AGENTS.md` | `AGENTS.md` |
//!
//! MCP files use Claude Code's `.mcp.json` format; each provider gets them converted.
//! Plugins use the Claude Code plugin layout (`skills/`, `.mcp.json`, agents, hooks), which
//! Claude Code and Copilot load whole; Codex gets their skills and MCP servers. Every agent
//! reads the workspace's `AGENTS.md` itself, so only the app home's is passed on. The
//! agents' own configuration (`~/.claude`, `~/.codex`, `~/.copilot`) is left to them.

use std::path::{Path, PathBuf};

use serde_json::{json, Map, Value};

use crate::error::Result;
use crate::mcp;

const MCP_FILE: &str = "mcp.json";
const WORKSPACE_MCP_FILE: &str = ".mcp.json";
const INSTRUCTIONS_FILE: &str = "AGENTS.md";
const SKILLS_DIR: &str = "skills";
const PLUGINS_DIR: &str = "plugins";
const WORKSPACE_SKILLS_DIR: &str = ".agents/skills";
const WORKSPACE_PLUGINS_DIR: &str = ".agents/plugins";
const SKILL_FILE: &str = "SKILL.md";
/// Where plugin MCP configs refer to their plugin's folder.
const PLUGIN_ROOT_VAR: &str = "${CLAUDE_PLUGIN_ROOT}";
/// The plugin the app builds in the session to give Claude Code the skill folders.
const CLAUDE_SKILLS_PLUGIN: &str = "slopslides";

#[derive(Debug, Default)]
pub struct Extensions {
    /// MCP servers by name, in Claude Code's format; the workspace's win over the app home's.
    pub mcp_servers: Map<String, Value>,
    /// MCP servers that plugins bring, `${CLAUDE_PLUGIN_ROOT}` filled in. Copilot loads
    /// these with the plugins; the others get them from the app.
    pub plugin_mcp_servers: Map<String, Value>,
    /// The app home's skill folder, if there is one.
    pub user_skills: Option<PathBuf>,
    /// The workspace's skill folder, if there is one.
    pub workspace_skills: Option<PathBuf>,
    /// Plugin folders, the workspace's first.
    pub plugins: Vec<PathBuf>,
    /// The app home's `AGENTS.md`.
    pub instructions: Option<String>,
    /// Problems with files that were skipped, for the user.
    pub warnings: Vec<String>,
}

impl Extensions {
    pub fn load(app_home: &Path, workspace: &Path) -> Self {
        let mut ext = Extensions {
            user_skills: dir(app_home.join(SKILLS_DIR)),
            workspace_skills: dir(workspace.join(WORKSPACE_SKILLS_DIR)),
            instructions: std::fs::read_to_string(app_home.join(INSTRUCTIONS_FILE))
                .ok()
                .filter(|s| !s.trim().is_empty()),
            ..Default::default()
        };
        for file in [app_home.join(MCP_FILE), workspace.join(WORKSPACE_MCP_FILE)] {
            if let Some(servers) = ext.read_mcp_file(&file) {
                ext.add_servers(servers, false);
            }
        }
        for root in [
            workspace.join(WORKSPACE_PLUGINS_DIR),
            app_home.join(PLUGINS_DIR),
        ] {
            ext.plugins.extend(subdirs(&root));
        }
        for plugin in ext.plugins.clone() {
            for servers in ext.plugin_servers(&plugin) {
                ext.add_servers(servers, true);
            }
        }
        ext
    }

    fn add_servers(&mut self, servers: Map<String, Value>, from_plugin: bool) {
        for (name, server) in servers {
            // The app's own server cannot be replaced; older versions wrote it to the
            // app home's mcp.json.
            if name == mcp::SERVER {
                continue;
            }
            if !server.is_object() {
                self.warnings
                    .push(format!("Skipped MCP server `{name}`: expected an object."));
                continue;
            }
            if from_plugin {
                // The first plugin to name a server keeps it.
                self.plugin_mcp_servers.entry(name).or_insert(server);
            } else {
                self.mcp_servers.insert(name, server);
            }
        }
    }

    /// The servers in an `.mcp.json`-style file; None if it is missing or unreadable.
    fn read_mcp_file(&mut self, file: &Path) -> Option<Map<String, Value>> {
        let raw = std::fs::read_to_string(file).ok()?;
        match serde_json::from_str::<Value>(&raw) {
            Ok(value) => servers_of(value).or_else(|| {
                self.warnings.push(format!(
                    "Skipped {}: expected an object of MCP servers.",
                    file.display()
                ));
                None
            }),
            Err(e) => {
                self.warnings
                    .push(format!("Skipped {}: {e}", file.display()));
                None
            }
        }
    }

    /// A plugin's MCP servers: its `.mcp.json` and those in its manifest.
    fn plugin_servers(&mut self, plugin: &Path) -> Vec<Map<String, Value>> {
        let root = plugin.to_string_lossy();
        let mut found = Vec::new();
        if let Some(servers) = self.read_mcp_file(&plugin.join(WORKSPACE_MCP_FILE)) {
            found.push(servers);
        }
        let manifest = std::fs::read_to_string(plugin.join(".claude-plugin/plugin.json"))
            .ok()
            .and_then(|raw| serde_json::from_str::<Value>(&raw).ok());
        if let Some(Value::Object(servers)) = manifest.map(|m| m["mcpServers"].clone()) {
            found.push(servers);
        }
        found
            .into_iter()
            .map(
                |servers| match replace_vars(Value::Object(servers), &root) {
                    Value::Object(servers) => servers,
                    _ => unreachable!("replacing strings keeps objects"),
                },
            )
            .collect()
    }

    /// Every MCP server for providers that do not load plugins' servers themselves.
    pub fn all_mcp_servers(&self) -> Map<String, Value> {
        let mut all = self.plugin_mcp_servers.clone();
        all.extend(self.mcp_servers.clone());
        all
    }

    /// Folders holding skills (`<name>/SKILL.md`) outside plugins, the workspace's first.
    pub fn skill_folders(&self) -> Vec<PathBuf> {
        self.workspace_skills
            .iter()
            .chain(&self.user_skills)
            .cloned()
            .collect()
    }

    /// The plugins' skill folders, for agents that cannot load the plugins themselves.
    pub fn plugin_skill_folders(&self) -> Vec<PathBuf> {
        self.plugins
            .iter()
            .filter_map(|p| dir(p.join(SKILLS_DIR)))
            .collect()
    }

    /// The app's instructions followed by the user's.
    pub fn system_prompt(&self, app: &str) -> String {
        match &self.instructions {
            Some(user) => format!("{app}\n\n# The user's instructions\n\n{}", user.trim_end()),
            None => app.to_string(),
        }
    }

    /// Builds a plugin in `dir` holding the app home's and workspace's skills, which Claude
    /// Code only loads from plugins. None when there are none.
    pub fn claude_skills_plugin(&self, dir: &Path) -> Result<Option<PathBuf>> {
        let plugin = dir.join(CLAUDE_SKILLS_PLUGIN);
        if plugin.exists() {
            std::fs::remove_dir_all(&plugin)?;
        }
        let skills: Vec<PathBuf> = self
            .skill_folders()
            .iter()
            .flat_map(|root| subdirs(root))
            .filter(|skill| skill.join(SKILL_FILE).is_file())
            .collect();
        if skills.is_empty() {
            return Ok(None);
        }
        std::fs::create_dir_all(plugin.join(".claude-plugin"))?;
        std::fs::write(
            plugin.join(".claude-plugin/plugin.json"),
            json!({
                "name": CLAUDE_SKILLS_PLUGIN,
                "description": "Skills from ~/.slopslides and the workspace",
            })
            .to_string(),
        )?;
        let target = plugin.join(SKILLS_DIR);
        std::fs::create_dir_all(&target)?;
        for skill in skills {
            let link = target.join(skill.file_name().expect("subdirs have names"));
            // The workspace's skill comes first and wins over the app home's of that name.
            if !link.exists() {
                link_dir(&skill, &link)?;
            }
        }
        Ok(Some(plugin))
    }
}

/// The servers of an `.mcp.json` value: under `mcpServers`, or the whole object.
fn servers_of(value: Value) -> Option<Map<String, Value>> {
    match value {
        Value::Object(mut obj) => match obj.remove("mcpServers") {
            Some(Value::Object(servers)) => Some(servers),
            Some(_) => None,
            None => Some(obj),
        },
        _ => None,
    }
}

fn replace_vars(value: Value, root: &str) -> Value {
    match value {
        Value::String(s) => Value::String(s.replace(PLUGIN_ROOT_VAR, root)),
        Value::Array(items) => {
            Value::Array(items.into_iter().map(|v| replace_vars(v, root)).collect())
        }
        Value::Object(obj) => Value::Object(
            obj.into_iter()
                .map(|(k, v)| (k, replace_vars(v, root)))
                .collect(),
        ),
        other => other,
    }
}

fn dir(path: PathBuf) -> Option<PathBuf> {
    path.is_dir().then_some(path)
}

/// The visible folders in `root`, sorted.
fn subdirs(root: &Path) -> Vec<PathBuf> {
    let Ok(entries) = std::fs::read_dir(root) else {
        return Vec::new();
    };
    let mut dirs: Vec<PathBuf> = entries
        .flatten()
        .filter(|e| !e.file_name().to_string_lossy().starts_with('.'))
        .map(|e| e.path())
        .filter(|p| p.is_dir())
        .collect();
    dirs.sort();
    dirs
}

#[cfg(unix)]
fn link_dir(from: &Path, to: &Path) -> std::io::Result<()> {
    std::os::unix::fs::symlink(from, to)
}

/// Windows needs a privilege for symbolic links, so skills are copied.
#[cfg(not(unix))]
fn link_dir(from: &Path, to: &Path) -> std::io::Result<()> {
    std::fs::create_dir_all(to)?;
    for entry in std::fs::read_dir(from)?.flatten() {
        let dest = to.join(entry.file_name());
        if entry.file_type()?.is_dir() {
            link_dir(&entry.path(), &dest)?;
        } else {
            std::fs::copy(entry.path(), dest)?;
        }
    }
    Ok(())
}

fn is_stdio(server: &Value) -> bool {
    match server["type"].as_str() {
        Some(kind) => kind == "stdio",
        None => server.get("url").is_none(),
    }
}

/// Codex's form of a server: `command`/`args`/`env`/`cwd`, or `url` with `http_headers`.
fn codex_server(server: &Value) -> Map<String, Value> {
    let keys: &[(&str, &str)] = if is_stdio(server) {
        &[
            ("command", "command"),
            ("args", "args"),
            ("env", "env"),
            ("cwd", "cwd"),
        ]
    } else {
        &[("url", "url"), ("headers", "http_headers")]
    };
    keys.iter()
        .filter_map(|(from, to)| {
            server
                .get(*from)
                .filter(|v| !v.is_null())
                .map(|v| (to.to_string(), v.clone()))
        })
        .collect()
}

/// `-c` overrides adding `servers` to Codex. Its dotted keys take bare names only, so
/// servers named otherwise are left out with a warning.
pub fn codex_config_args(servers: &Map<String, Value>, warnings: &mut Vec<String>) -> Vec<String> {
    let mut args = Vec::new();
    for (name, server) in servers {
        let bare = !name.is_empty()
            && name
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-');
        if !bare {
            warnings.push(format!(
                "Codex cannot use MCP server `{name}`: use letters, digits, - and _ in its name."
            ));
            continue;
        }
        let table = Value::Object(codex_server(server));
        args.push("-c".into());
        args.push(format!("mcp_servers.{name}={}", toml_inline(&table)));
    }
    args
}

/// `value` as a TOML inline value. JSON string escapes are valid TOML basic strings; nulls,
/// which TOML lacks, are left out.
fn toml_inline(value: &Value) -> String {
    match value {
        Value::Array(items) => format!(
            "[{}]",
            items
                .iter()
                .filter(|v| !v.is_null())
                .map(toml_inline)
                .collect::<Vec<_>>()
                .join(",")
        ),
        Value::Object(obj) => format!(
            "{{{}}}",
            obj.iter()
                .filter(|(_, v)| !v.is_null())
                .map(|(k, v)| format!("{}={}", Value::String(k.clone()), toml_inline(v)))
                .collect::<Vec<_>>()
                .join(",")
        ),
        other => other.to_string(),
    }
}

/// Copilot's form of a server, all its tools enabled (approval still follows the mode).
pub fn copilot_server(server: &Value) -> Value {
    let mut out = server.as_object().cloned().unwrap_or_default();
    if is_stdio(server) {
        out.insert("type".into(), json!("stdio"));
        out.entry("args").or_insert(json!([]));
    } else {
        out.entry("type").or_insert(json!("http"));
    }
    out.insert("tools".into(), json!(["*"]));
    Value::Object(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    struct TempDir(PathBuf);

    impl TempDir {
        fn new() -> Self {
            let dir = std::env::temp_dir().join(format!("ext-{}", uuid::Uuid::new_v4()));
            std::fs::create_dir_all(&dir).unwrap();
            TempDir(dir)
        }
        fn write(&self, rel: &str, contents: &str) {
            let path = self.0.join(rel);
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            std::fs::write(path, contents).unwrap();
        }
    }

    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    fn skill(dir: &TempDir, rel: &str) {
        dir.write(
            &format!("{rel}/SKILL.md"),
            "---\nname: x\ndescription: x\n---\n",
        );
    }

    #[test]
    fn empty_folders_load_nothing() {
        let (home, ws) = (TempDir::new(), TempDir::new());
        let ext = Extensions::load(&home.0, &ws.0);
        assert!(ext.mcp_servers.is_empty() && ext.plugin_mcp_servers.is_empty());
        assert!(ext.plugins.is_empty() && ext.skill_folders().is_empty());
        assert!(ext.plugin_skill_folders().is_empty());
        assert!(ext.instructions.is_none() && ext.warnings.is_empty());
        assert_eq!(ext.system_prompt("app"), "app");
    }

    #[test]
    fn workspace_mcp_servers_win_and_the_app_server_is_reserved() {
        let (home, ws) = (TempDir::new(), TempDir::new());
        home.write(
            "mcp.json",
            r#"{"mcpServers":{"a":{"command":"home"},"b":{"command":"b"},"slopslide":{"command":"old"}}}"#,
        );
        // Without the mcpServers wrapper, as Claude Code also accepts.
        ws.write(".mcp.json", r#"{"a":{"command":"ws"}}"#);
        let ext = Extensions::load(&home.0, &ws.0);
        assert_eq!(ext.mcp_servers["a"]["command"], "ws");
        assert_eq!(ext.mcp_servers["b"]["command"], "b");
        assert!(!ext.mcp_servers.contains_key(mcp::SERVER));
    }

    #[test]
    fn broken_mcp_files_are_reported_and_skipped() {
        let (home, ws) = (TempDir::new(), TempDir::new());
        home.write("mcp.json", "{not json");
        ws.write(".mcp.json", r#"{"mcpServers":[],"x":1}"#);
        let ext = Extensions::load(&home.0, &ws.0);
        assert!(ext.mcp_servers.is_empty());
        assert_eq!(ext.warnings.len(), 2, "{:?}", ext.warnings);
    }

    #[test]
    fn non_object_servers_are_reported() {
        let (home, ws) = (TempDir::new(), TempDir::new());
        home.write("mcp.json", r#"{"mcpServers":{"a":"cmd"}}"#);
        let ext = Extensions::load(&home.0, &ws.0);
        assert!(ext.mcp_servers.is_empty());
        assert_eq!(ext.warnings.len(), 1);
    }

    #[test]
    fn plugins_bring_skills_and_servers_with_their_root_filled_in() {
        let (home, ws) = (TempDir::new(), TempDir::new());
        home.write(
            "plugins/p/.mcp.json",
            r#"{"mcpServers":{"ps":{"command":"${CLAUDE_PLUGIN_ROOT}/bin/s","args":["${CLAUDE_PLUGIN_ROOT}"]}}}"#,
        );
        home.write(
            "plugins/p/.claude-plugin/plugin.json",
            r#"{"name":"p","mcpServers":{"inline":{"url":"http://x"}}}"#,
        );
        skill(&home, "plugins/p/skills/s1");
        ws.write(
            ".agents/plugins/q/.mcp.json",
            r#"{"ps":{"command":"from-ws"}}"#,
        );
        ws.write(".agents/plugins/marketplace.json", "{}");
        let ext = Extensions::load(&home.0, &ws.0);
        let p = home.0.join("plugins/p");
        assert_eq!(ext.plugins, [ws.0.join(".agents/plugins/q"), p.clone()]);
        assert_eq!(
            ext.plugin_mcp_servers["ps"]["command"], "from-ws",
            "the workspace's plugin comes first"
        );
        assert_eq!(ext.plugin_mcp_servers["inline"]["url"], "http://x");
        assert!(ext.mcp_servers.is_empty());
        assert_eq!(ext.plugin_skill_folders(), [p.join("skills")]);
        assert!(ext.skill_folders().is_empty());

        let (home2, ws2) = (TempDir::new(), TempDir::new());
        home2.write(
            "plugins/p/.mcp.json",
            r#"{"ps":{"command":"${CLAUDE_PLUGIN_ROOT}/bin/s","args":["${CLAUDE_PLUGIN_ROOT}"]}}"#,
        );
        let ext = Extensions::load(&home2.0, &ws2.0);
        // The folder as listed, with the platform's separators.
        let root = ext.plugins[0].to_string_lossy().into_owned();
        assert_eq!(ext.plugins[0], home2.0.join("plugins").join("p"));
        assert_eq!(
            ext.plugin_mcp_servers["ps"]["command"],
            format!("{root}/bin/s")
        );
        assert_eq!(ext.plugin_mcp_servers["ps"]["args"][0], root);
    }

    #[test]
    fn configured_servers_win_over_plugin_servers() {
        let (home, ws) = (TempDir::new(), TempDir::new());
        home.write("mcp.json", r#"{"s":{"command":"mine"}}"#);
        home.write(
            "plugins/p/.mcp.json",
            r#"{"s":{"command":"plugin"},"t":{"command":"t"}}"#,
        );
        let all = Extensions::load(&home.0, &ws.0).all_mcp_servers();
        assert_eq!(all["s"]["command"], "mine");
        assert_eq!(all["t"]["command"], "t");
    }

    #[test]
    fn skill_folders_list_the_workspace_first() {
        let (home, ws) = (TempDir::new(), TempDir::new());
        skill(&home, "skills/a");
        skill(&ws, ".agents/skills/b");
        let ext = Extensions::load(&home.0, &ws.0);
        assert_eq!(ext.user_skills, Some(home.0.join("skills")));
        assert_eq!(
            ext.skill_folders(),
            [ws.0.join(".agents/skills"), home.0.join("skills")]
        );
    }

    #[test]
    fn user_instructions_follow_the_app_prompt() {
        let (home, ws) = (TempDir::new(), TempDir::new());
        home.write("AGENTS.md", "Use British spelling.\n");
        let ext = Extensions::load(&home.0, &ws.0);
        assert_eq!(
            ext.system_prompt("App."),
            "App.\n\n# The user's instructions\n\nUse British spelling."
        );
        home.write("AGENTS.md", "  \n");
        assert!(Extensions::load(&home.0, &ws.0).instructions.is_none());
    }

    #[test]
    fn claude_skills_plugin_holds_every_skill_once() {
        let (home, ws, session) = (TempDir::new(), TempDir::new(), TempDir::new());
        let ext = Extensions::load(&home.0, &ws.0);
        assert_eq!(ext.claude_skills_plugin(&session.0).unwrap(), None);

        skill(&home, "skills/shared");
        skill(&home, "skills/mine");
        home.write("skills/not-a-skill/README.md", "");
        skill(&ws, ".agents/skills/shared");
        home.write("skills/shared/home-only.txt", "");
        let ext = Extensions::load(&home.0, &ws.0);
        let plugin = ext.claude_skills_plugin(&session.0).unwrap().unwrap();
        let manifest: Value = serde_json::from_str(
            &std::fs::read_to_string(plugin.join(".claude-plugin/plugin.json")).unwrap(),
        )
        .unwrap();
        assert_eq!(manifest["name"], CLAUDE_SKILLS_PLUGIN);
        let mut names: Vec<_> = std::fs::read_dir(plugin.join("skills"))
            .unwrap()
            .flatten()
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .collect();
        names.sort();
        assert_eq!(names, ["mine", "shared"]);
        assert!(plugin.join("skills/mine/SKILL.md").is_file());
        assert!(
            !plugin.join("skills/shared/home-only.txt").exists(),
            "the workspace's skill wins"
        );

        // Rebuilt each turn: removed skills disappear.
        std::fs::remove_dir_all(home.0.join("skills/mine")).unwrap();
        let ext = Extensions::load(&home.0, &ws.0);
        let plugin = ext.claude_skills_plugin(&session.0).unwrap().unwrap();
        assert!(!plugin.join("skills/mine").exists());
    }

    #[test]
    fn codex_gets_servers_as_inline_tables() {
        let servers = json!({
            "local": {"command": "npx", "args": ["-y", "pkg \"q\""], "env": {"K": "v"}, "type": "stdio", "cwd": null},
            "remote": {"type": "http", "url": "https://x/mcp", "headers": {"Authorization": "Bearer t"}},
            "bad name": {"command": "x"},
        });
        let mut warnings = Vec::new();
        let args = codex_config_args(servers.as_object().unwrap(), &mut warnings);
        assert_eq!(
            args,
            [
                "-c",
                r#"mcp_servers.local={"args"=["-y","pkg \"q\""],"command"="npx","env"={"K"="v"}}"#,
                "-c",
                r#"mcp_servers.remote={"http_headers"={"Authorization"="Bearer t"},"url"="https://x/mcp"}"#,
            ]
        );
        assert_eq!(warnings.len(), 1);
        assert!(warnings[0].contains("bad name"));
    }

    #[test]
    fn copilot_gets_typed_servers_with_all_tools() {
        assert_eq!(
            copilot_server(&json!({"command": "x"})),
            json!({"type": "stdio", "command": "x", "args": [], "tools": ["*"]})
        );
        assert_eq!(
            copilot_server(&json!({"url": "https://x", "headers": {"A": "1"}})),
            json!({"type": "http", "url": "https://x", "headers": {"A": "1"}, "tools": ["*"]})
        );
        assert_eq!(
            copilot_server(&json!({"type": "sse", "url": "https://x", "tools": ["one"]})),
            json!({"type": "sse", "url": "https://x", "tools": ["*"]})
        );
    }
}
