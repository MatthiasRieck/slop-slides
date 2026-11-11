use super::*;
use crate::permissions::Decision;
use crate::test_support::TempDir;

#[test]
fn claude_model_adds_1m_suffix() {
    assert_eq!(
        model("claude-opus-5-5".into(), Some("1m")),
        "claude-opus-5-5[1m]"
    );
    assert_eq!(
        model("claude-opus-5-5[1m]".into(), Some("1m")),
        "claude-opus-5-5[1m]"
    );
    assert_eq!(
        model("claude-sonnet-5".into(), Some("200k")),
        "claude-sonnet-5"
    );
    assert_eq!(model("claude-haiku-4-5".into(), None), "claude-haiku-4-5");
}

#[test]
fn parses_text_stream() {
    let start = json!({"type":"stream_event","parent_tool_use_id":null,"event":{"type":"content_block_start","index":1,"content_block":{"type":"text","text":""}}});
    let delta = json!({"type":"stream_event","parent_tool_use_id":null,"event":{"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":"Hi"}}});
    assert_eq!(parse_line(&start), vec![AgentEvent::TextStart]);
    assert_eq!(
        parse_line(&delta),
        vec![AgentEvent::TextDelta { text: "Hi".into() }]
    );
}

#[test]
fn parses_tools_and_results() {
    let tool = json!({"type":"assistant","parent_tool_use_id":null,"message":{"content":[{"type":"tool_use","id":"t1","name":"Write","input":{"file_path":"/d/slides/01.html"}}]}});
    let result = json!({"type":"user","parent_tool_use_id":null,"message":{"content":[{"type":"tool_result","tool_use_id":"t1","content":"ok"}]}});
    let done = json!({"type":"result","subtype":"success","is_error":false,"result":"done","total_cost_usd":0.02,"duration_ms":1200});
    assert!(matches!(&parse_line(&tool)[0], AgentEvent::ToolUse { name, .. } if name == "Write"));
    assert_eq!(
        parse_line(&result),
        vec![AgentEvent::ToolResult {
            id: "t1".into(),
            is_error: false,
            output: Some("ok".into()),
            images: vec![]
        }]
    );
    assert!(matches!(
        &parse_line(&done)[0],
        AgentEvent::Result {
            is_error: false,
            ..
        }
    ));
}

#[test]
fn parses_context_usage() {
    let assistant = json!({"type":"assistant","parent_tool_use_id":null,"message":{"content":[{"type":"text","text":"hi"}],"usage":{"input_tokens":9,"cache_creation_input_tokens":7662,"cache_read_input_tokens":12313,"output_tokens":4}}});
    assert_eq!(
        parse_line(&assistant),
        vec![AgentEvent::Usage {
            context_tokens: Some(19988),
            context_window: None
        }]
    );
    let tool = json!({"type":"assistant","parent_tool_use_id":null,"message":{"content":[{"type":"tool_use","id":"t1","name":"Read","input":{}}],"usage":{"input_tokens":100}}});
    assert!(matches!(
        &parse_line(&tool)[..],
        [
            AgentEvent::ToolUse { .. },
            AgentEvent::Usage {
                context_tokens: Some(100),
                ..
            }
        ]
    ));
    let nested = json!({"type":"assistant","parent_tool_use_id":"t1","message":{"content":[],"usage":{"input_tokens":5}}});
    assert!(
        parse_line(&nested).is_empty(),
        "sub-agents have their own context"
    );
    let no_usage = json!({"type":"assistant","parent_tool_use_id":null,"message":{"content":[]}});
    assert!(parse_line(&no_usage).is_empty());

    let result = json!({"type":"result","subtype":"success","is_error":false,"result":"ok","modelUsage":{
        "claude-haiku-4-5-20251001":{"contextWindow":200000},
        "claude-opus-5-5":{"contextWindow":1000000}
    }});
    assert_eq!(
        parse_line(&result)[1..],
        [AgentEvent::Usage {
            context_tokens: None,
            context_window: Some(1_000_000)
        }]
    );
    let bare = json!({"type":"result","subtype":"success","is_error":false,"result":"ok"});
    assert_eq!(parse_line(&bare).len(), 1, "no window, no usage event");
}

#[test]
fn parses_compaction() {
    let status = |status: Value| json!({"type":"system","subtype":"status","status":status});
    assert_eq!(
        parse_line(&status(json!("compacting"))),
        vec![AgentEvent::Compacting]
    );
    assert!(parse_line(&status(Value::Null)).is_empty());
    let boundary = json!({"type":"system","subtype":"compact_boundary","compact_metadata":{"trigger":"auto","pre_tokens":20018,"post_tokens":1512}});
    assert_eq!(parse_line(&boundary), vec![AgentEvent::Compacted]);
    let init = json!({"type":"system","subtype":"init","session_id":"s"});
    assert!(parse_line(&init).is_empty());
}

#[test]
fn parses_thinking_and_ignores_other_stream_events() {
    let thinking = json!({"type":"stream_event","event":{"type":"content_block_start","content_block":{"type":"thinking"}}});
    assert_eq!(parse_line(&thinking), vec![AgentEvent::Thinking]);
    for ignored in [
        json!({"type":"stream_event","event":{"type":"content_block_start","content_block":{"type":"tool_use"}}}),
        json!({"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"input_json_delta","partial_json":"{"}}}),
        json!({"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta"}}}),
        json!({"type":"stream_event","event":{"type":"message_stop"}}),
        json!({"type":"system","subtype":"init","session_id":"abc"}),
        json!({"type":"something_new"}),
        json!({}),
        json!("just a string"),
    ] {
        assert_eq!(parse_line(&ignored), vec![], "{ignored}");
    }
}

#[test]
fn hides_events_from_nested_agents() {
    let nested = json!({"type":"assistant","parent_tool_use_id":"t0","message":{"content":[{"type":"tool_use","id":"t9","name":"Read","input":{}}]}});
    assert_eq!(parse_line(&nested), vec![]);
    let nested_text = json!({"type":"stream_event","parent_tool_use_id":"t0","event":{"type":"content_block_start","content_block":{"type":"text"}}});
    assert_eq!(parse_line(&nested_text), vec![]);
}

#[test]
fn emits_every_tool_use_in_a_message_and_skips_text_blocks() {
    let message = json!({"type":"assistant","message":{"content":[
        {"type":"text","text":"Let me look."},
        {"type":"tool_use","id":"a","name":"Read","input":{"file_path":"deck.html"}},
        {"type":"tool_use","id":"b","name":"Edit","input":{"old_string":"x","new_string":"y"}}
    ]}});
    assert_eq!(
        parse_line(&message),
        vec![
            AgentEvent::ToolUse {
                id: "a".into(),
                name: "Read".into(),
                input: json!({"file_path":"deck.html"})
            },
            AgentEvent::ToolUse {
                id: "b".into(),
                name: "Edit".into(),
                input: json!({"old_string":"x","new_string":"y"})
            },
        ]
    );
    let no_content = json!({"type":"assistant","message":{}});
    assert_eq!(parse_line(&no_content), vec![]);
}

#[test]
fn reports_failed_tool_results() {
    let result = json!({"type":"user","message":{"content":[
        {"type":"tool_result","tool_use_id":"a","is_error":true,"content":"denied"},
        {"type":"text","text":"ignored"}
    ]}});
    assert_eq!(
        parse_line(&result),
        vec![AgentEvent::ToolResult {
            id: "a".into(),
            is_error: true,
            output: Some("denied".into()),
            images: vec![]
        }]
    );
}

/// Reading the slide screenshot of Tidy layout gives an image: it is reported as an image, and
/// the output's text only names it.
#[test]
fn reports_tool_output_blocks_with_their_images_apart() {
    let result = json!({"type":"user","message":{"content":[
        {"type":"tool_result","tool_use_id":"shot","content":[
            {"type":"image","source":{"type":"base64","media_type":"image/png","data":"iVBORw0KGgo"}}
        ]},
        {"type":"tool_result","tool_use_id":"text","content":[{"type":"text","text":"1\tline"}]},
        {"type":"tool_result","tool_use_id":"none"}
    ]}});
    let output = |id: &str, output: Option<&str>, images: &[&str]| AgentEvent::ToolResult {
        id: id.into(),
        is_error: false,
        output: output.map(str::to_string),
        images: images.iter().map(|i| i.to_string()).collect(),
    };
    assert_eq!(
        parse_line(&result),
        vec![
            output(
                "shot",
                Some("[image]"),
                &["data:image/png;base64,iVBORw0KGgo"]
            ),
            output("text", Some("1\tline"), &[]),
            output("none", None, &[])
        ]
    );
}

#[test]
fn non_success_results_are_errors() {
    let max_turns =
        json!({"type":"result","subtype":"error_max_turns","is_error":false,"duration_ms":10});
    assert_eq!(
        parse_line(&max_turns),
        vec![AgentEvent::Result {
            is_error: true,
            text: None,
            cost_usd: None,
            duration_ms: Some(10)
        }]
    );
    let flagged = json!({"type":"result","subtype":"success","is_error":true,"result":"API Error","total_cost_usd":0.5});
    assert_eq!(
        parse_line(&flagged),
        vec![AgentEvent::Result {
            is_error: true,
            text: Some("API Error".into()),
            cost_usd: Some(0.5),
            duration_ms: None
        }]
    );
}

#[test]
fn detects_missing_session() {
    let missing = json!({"type":"result","subtype":"error_during_execution","is_error":true,"errors":["No conversation found with session ID: x"]});
    assert!(is_missing_session(&missing));
    // Only a result with that error.
    for other in [
        json!({"type":"result","subtype":"success"}),
        json!({"type":"assistant","errors":["No conversation found"]}),
        json!({"type":"result","errors":["Rate limited"]}),
        json!({"type":"result","errors":[42]}),
        json!({"type":"result"}),
    ] {
        assert!(!is_missing_session(&other), "{other}");
    }
}

#[test]
fn reads_session_from_init() {
    let init = json!({"type":"system","subtype":"init","session_id":"abc"});
    assert_eq!(session_id_of_init(&init).as_deref(), Some("abc"));
    for other in [
        json!({"type":"system","subtype":"status"}),
        json!({"type":"system","subtype":"init"}),
        json!({"type":"result","subtype":"init","session_id":"x"}),
    ] {
        assert_eq!(session_id_of_init(&other), None, "{other}");
    }
}

#[test]
fn builds_cli_arguments() {
    let prompt = Path::new("/home/.slopslides/system-prompt.md");
    let mcp = Path::new("/home/.slopslides/sessions/1-ab/mcp.json");
    let session = Path::new("/home/.slopslides/sessions/1-ab");
    let base = build_args(prompt, mcp, session, None, None, None, PermissionMode::Ask);
    assert_eq!(
        base[..5],
        [
            "-p",
            "--input-format",
            "stream-json",
            "--output-format",
            "stream-json"
        ]
    );
    let after = |args: &[String], flag: &str| {
        args.iter()
            .position(|a| a == flag)
            .map(|i| args[i + 1].clone())
    };
    assert_eq!(
        after(&base, "--permission-mode").as_deref(),
        Some("acceptEdits")
    );
    assert!(
        base.contains(&"--allow-dangerously-skip-permissions".to_string()),
        "Full access can be granted while a turn runs"
    );
    assert_eq!(after(&base, "--tools").as_deref(), Some(TOOLS));
    assert_eq!(
        after(&base, "--allowedTools").as_deref(),
        Some("WebSearch,WebFetch,Skill,mcp__slopslide"),
        "the shell and files outside the workspace ask; the app's tools and skills never do"
    );
    assert_eq!(
        after(&base, "--permission-prompt-tool").as_deref(),
        Some("stdio")
    );
    assert_eq!(
        after(&base, "--mcp-config").as_deref(),
        Some("/home/.slopslides/sessions/1-ab/mcp.json")
    );
    assert_eq!(
        after(&base, "--append-system-prompt-file").as_deref(),
        Some("/home/.slopslides/system-prompt.md")
    );
    assert_eq!(
        after(&base, "--add-dir").as_deref(),
        Some("/home/.slopslides/sessions/1-ab"),
        "the agent reads sketches and templates in the session"
    );
    assert!(base.contains(&"--strict-mcp-config".to_string()));
    assert!(!base.contains(&"--model".to_string()));
    assert!(!base.contains(&"--resume".to_string()));
    assert!(!base.contains(&"--effort".to_string()));

    let full = build_args(
        prompt,
        mcp,
        session,
        Some("opus"),
        Some("high"),
        Some("s-1"),
        PermissionMode::FullAccess,
    );
    assert_eq!(
        after(&full, "--permission-mode").as_deref(),
        Some("bypassPermissions")
    );
    assert_eq!(after(&full, "--model").as_deref(), Some("opus"));
    assert_eq!(after(&full, "--effort").as_deref(), Some("high"));
    assert_eq!(after(&full, "--resume").as_deref(), Some("s-1"));
}

#[test]
fn shows_the_apps_tools_by_their_own_names() {
    let line = json!({"type":"assistant","message":{"content":[
        {"type":"tool_use","id":"t1","name":"mcp__slopslide__lint_deck","input":{}},
        {"type":"tool_use","id":"t2","name":"mcp__github__push","input":{}}
    ]}});
    let names: Vec<_> = parse_line(&line)
        .into_iter()
        .filter_map(|e| match e {
            AgentEvent::ToolUse { name, .. } => Some(name),
            _ => None,
        })
        .collect();
    assert_eq!(names, ["lint_deck", "mcp__github__push"]);
}

/// A session dir that is absolute on every platform (`/home/...` is not on Windows).
fn session_dir() -> PathBuf {
    std::env::temp_dir().join("sessions").join("1-ab")
}

#[test]
fn claude_reads_staged_templates_without_asking() {
    let dir = session_dir();
    let at = |rel: &str| format!("{}/{rel}", dir.display());
    let path = at("templates/ethereal.html");
    let request = can_use_tool("Read", json!({"file_path": path}));
    assert!(matches!(
        permission(&request, PermissionMode::Ask, &dir),
        Permission::Answer(Ok(r)) if r["behavior"] == "allow" && r["updatedInput"]["file_path"] == path.as_str()
    ));
    let other = format!("{}/2-cd/templates/x.html", dir.parent().unwrap().display());
    for (tool, input) in [
        ("Read", json!({"file_path": at("templates/../chat.json")})),
        ("Read", json!({"file_path": at("chat.json")})),
        ("Read", json!({"file_path": other})),
        ("Read", json!({"file_path": at("templates-x/a.html")})),
        ("Read", json!({"file_path":"templates/ethereal.html"})),
        ("Read", json!({})),
        ("Write", json!({"file_path": path})),
        ("Grep", json!({"path": at("templates"), "glob": "/etc/*"})),
    ] {
        assert!(
            matches!(
                permission(
                    &can_use_tool(tool, input.clone()),
                    PermissionMode::Ask,
                    &dir
                ),
                Permission::Ask(..)
            ),
            "{tool} {input} asks"
        );
    }
}

fn can_use_tool(tool: &str, input: Value) -> Value {
    json!({"subtype":"can_use_tool","tool_name":tool,"input":input,"permission_suggestions":[]})
}

#[test]
fn claude_runs_the_apps_tools_without_asking() {
    for tool in ["mcp__slopslide__lint_deck", "mcp__slopslide__open_file"] {
        let request = can_use_tool(tool, json!({"path":"deck.html"}));
        assert!(matches!(
            permission(&request, PermissionMode::Ask, &session_dir()),
            Permission::Answer(Ok(r)) if r["behavior"] == "allow" && r["updatedInput"]["path"] == "deck.html"
        ));
    }
}

#[test]
fn claude_asks_before_other_tools() {
    let cases = [
        (
            "Bash",
            json!({"command":"npm test","description":"Run tests"}),
            "Run a command",
            "npm test",
        ),
        (
            "Write",
            json!({"file_path":"/etc/hosts"}),
            "Change files",
            "/etc/hosts",
        ),
        (
            "Read",
            json!({"file_path":"/Users/me/.ssh/id"}),
            "Read files",
            "/Users/me/.ssh/id",
        ),
        (
            "WebFetch",
            json!({"url":"https://example.com"}),
            "Network access",
            "https://example.com",
        ),
        (
            "mcp__github__push",
            json!({"branch":"main"}),
            "Use a tool",
            "mcp__github__push",
        ),
    ];
    for (tool, input, title, details) in cases {
        let Permission::Ask(approval, choices) = permission(
            &can_use_tool(tool, input.clone()),
            PermissionMode::Ask,
            &session_dir(),
        ) else {
            panic!("{tool} asks");
        };
        assert_eq!(approval.title, title);
        assert!(approval.details.contains(details), "{}", approval.details);
        assert_eq!(
            approval.decisions,
            [Decision::Accept, Decision::Decline],
            "no rule offered"
        );
        assert_eq!(
            choices["accept"],
            json!({"behavior":"allow","updatedInput":input})
        );
        assert_eq!(choices["decline"]["behavior"], "deny");
    }
    let Permission::Ask(approval, _) = permission(
        &can_use_tool("Bash", json!({"command":"ls","description":"List files"})),
        PermissionMode::Ask,
        &session_dir(),
    ) else {
        panic!("asks");
    };
    assert_eq!(approval.reason.as_deref(), Some("List files"));
}

#[test]
fn claude_full_access_allows_everything() {
    let request = can_use_tool("Bash", json!({"command":"rm -rf build"}));
    assert!(matches!(
        permission(&request, PermissionMode::FullAccess, &session_dir()),
        Permission::Answer(Ok(r)) if r["behavior"] == "allow"
    ));
}

#[test]
fn claude_refuses_other_control_requests() {
    let request = json!({"subtype":"hook_callback"});
    assert!(matches!(
        permission(&request, PermissionMode::Ask, &session_dir()),
        Permission::Answer(Err(_))
    ));
    assert_eq!(
        control_response(&json!("r1"), Err("no")),
        json!({"type":"control_response","response":{"subtype":"error","request_id":"r1","error":"no"}})
    );
}

#[test]
fn mcp_config_runs_this_binary_for_the_workspace_and_the_turns_session() {
    let config: Value = serde_json::from_str(&mcp_config_json(
        Path::new("/Apps/SlopSlide"),
        Path::new("/decks"),
        Path::new("/home/sessions/s1"),
        &serde_json::Map::new(),
    ))
    .unwrap();
    let server = &config["mcpServers"]["slopslide"];
    assert_eq!(server["type"], "stdio");
    assert_eq!(server["command"], "/Apps/SlopSlide");
    assert_eq!(
        server["args"],
        json!(["--lint-mcp", "/decks", "/home/sessions/s1"]),
        "the session: a deck's chat is not the workspace's"
    );
}

#[test]
fn mcp_config_adds_the_users_servers_but_keeps_the_apps() {
    let servers = json!({"docs": {"url": "https://x/mcp"}, "slopslide": {"command": "evil"}});
    let config: Value = serde_json::from_str(&mcp_config_json(
        Path::new("/Apps/SlopSlide"),
        Path::new("/decks"),
        Path::new("/home/sessions/s1"),
        servers.as_object().unwrap(),
    ))
    .unwrap();
    assert_eq!(config["mcpServers"]["docs"]["url"], "https://x/mcp");
    assert_eq!(
        config["mcpServers"]["slopslide"]["command"],
        "/Apps/SlopSlide"
    );
}

#[test]
fn plugins_are_passed_as_plugin_dirs() {
    let plugins = [PathBuf::from("/p/a"), PathBuf::from("/p/b")];
    assert_eq!(
        plugin_args(&plugins),
        ["--plugin-dir", "/p/a", "--plugin-dir", "/p/b"]
    );
    assert!(plugin_args(&[]).is_empty());
}

#[test]
fn write_if_changed_replaces_only_different_contents() {
    let dir = TempDir::new("write");
    let path = dir.join("mcp.json");
    write_if_changed(&path, "one").unwrap();
    assert_eq!(std::fs::read_to_string(&path).unwrap(), "one");
    let written = std::fs::metadata(&path).unwrap().modified().unwrap();
    std::thread::sleep(std::time::Duration::from_millis(20));
    write_if_changed(&path, "one").unwrap();
    assert_eq!(
        std::fs::metadata(&path).unwrap().modified().unwrap(),
        written,
        "unchanged contents are not rewritten"
    );
    write_if_changed(&path, "two").unwrap();
    assert_eq!(std::fs::read_to_string(&path).unwrap(), "two");
    let leftovers = std::fs::read_dir(&dir).unwrap().count();
    assert_eq!(leftovers, 1, "no temporary files left behind");
}

#[test]
fn steers_claude_with_priority_now() {
    assert_eq!(
        steer_message("Bluer"),
        json!({"type": "user", "message": {"role": "user", "content": "Bluer"}, "priority": "now"})
    );
    assert!(is_steer_abort(
        &json!({"type": "result", "terminal_reason": "aborted_streaming"})
    ));
    assert!(is_steer_abort(
        &json!({"type": "result", "terminal_reason": "aborted_tools"})
    ));
    assert!(!is_steer_abort(
        &json!({"type": "result", "terminal_reason": "completed"})
    ));
    assert!(!is_steer_abort(&json!({"type": "result"})));
}
