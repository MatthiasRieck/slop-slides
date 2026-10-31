# SlopSlide

A desktop slide editor you drive by chatting. Describe a presentation, and an agent writes
the slides. Keep talking to it to restyle, rewrite, split, or add slides while you watch them change.

- **Left:** live thumbnails. Drag to reorder; hover to lock, hide, duplicate, or delete; `+`
  adds a slide. A locked slide (lock icon) can be changed by neither you nor the agent: it
  cannot be edited on the stage, deleted, or saved changed from the code view, and if the
  agent changes it anyway the app puts it back after the turn. Unlock it to change it.
  Sections group slides under a heading in this column (never in the presentation): the
  section button starts one at the selected slide; double-click a heading to rename it, drag
  it to move the boundary, hover to remove it. Out of edit mode, ⌘C copies the selected slide
  and ⌘V pastes a copied slide after the selected one.
- **Middle:** the current slide on a fixed stage (1920×1080 unless the deck has another slide
  size), scaled to fit. Arrow keys navigate.
  The move button below it turns on edit mode: click an element to select it, drag it (or
  use the arrow keys) to move it, double-click (or press Enter) to edit its text, Escape to
  select the parent, Delete (or the trash button in the edit bar) to remove
  it, ⌘C / ⌘X / ⌘V to copy, cut and paste elements (also between slides), and ⌘Z / Ctrl+Z
  to undo. ⌘V also pastes images and text copied in other apps, like a browser. Pastes go
  on top of the slide, under the pointer (or in the middle of the view), without moving the
  layout. Right-click an element for these actions and its stacking order, to ask the agent
  about it, or to have the agent tidy just an element you added. `?` lists the shortcuts.
  The edit toolbar above the slide styles text: font (the deck's fonts and system
  fonts), size (±, or type one), color, bold / italic / underline (⌘B / ⌘I / ⌘U),
  strikethrough, superscript and subscript, line height and letter spacing, bulleted and
  numbered lists (Enter starts a new item, Tab / Shift+Tab indent and outdent), and links to
  web pages, email addresses or other slides. While typing, these apply to the selected words;
  otherwise to the whole element. A text box can shrink its text or grow to fit instead of
  overflowing. Pasting into text keeps bold, italic, links and line breaks (⌘⇧V pastes plain
  text). The search field in the View toolbar (⌘F) searches the text of all slides and their
  notes as you type: the slide list shows only the slides that contain it, the slide you pick
  highlights it, and the arrows (or Enter and ⇧Enter) go through the matches. The button next to
  it replaces them, leaving locked slides alone. Moved
  elements keep a
  temporary offset; **Tidy layout** then sends the agent a screenshot so it rebuilds the
  slide's layout around where you put things.
- **Right:** chat with the agent. It knows which slide you're on, and you can attach images
  (paperclip, or drop files anywhere on the window). The microphone button dictates: click to
  start, and what you say shows up at the cursor as you speak; click again to keep it (Esc
  discards it). On macOS the first use asks for microphone access (when running from a
  terminal or editor, macOS asks for that app instead). Speech is
  transcribed on your computer with [Whisper](https://github.com/ggml-org/whisper.cpp) (small,
  multilingual); its model (190 MB) is downloaded on first use to `~/.slopslides/models`.
- **Windows:** File › New Window (⌘N; Ctrl+N on Windows and Linux) opens another window,
  each with a folder of its own and its own chat. On macOS, a double-click on the app in
  Finder or New Window in its Dock menu (right-click the icon) opens another window too, while
  a click on the Dock icon only brings the app back. A folder
  dropped on the app's icon or opened with it from Finder (Open With) opens in a window: one
  on the start screen, else a new one. A folder already open in one window is brought to the
  front instead of opening twice. Elements and whole slides copied in one
  window paste into another; the images they show are copied into the receiving deck's
  `assets/`. A pasted element keeps its size and text look, but styles that come from the
  other deck's CSS (its classes, its theme) do not come along.
- **Styles and layouts:** decks can follow a template, a deck of example layouts (title,
  section, bullets, split, stats, quote, closing) in one style, with its own entrance animation. 31 come
  with the app (Claymorphism, Swiss Design, Synthwave, Terminal Green, Wabi-Sabi, …); add your own as folders in
  `~/.slopslides/templates/<name>/deck.html`. Pick a style when creating a deck or with the
  palette button above the slide rail (it puts a restyle request in the chat; an empty deck
  takes it at once); the same menu has **Save deck as template**, which copies the deck there
  with its text replaced by placeholder words. The rail's `+` shows a blank slide and every
  layout of the deck's style as thumbnails and adds the one you click; **Layout** below the
  slide asks the agent to rebuild the current slide on a layout.
- **Slide size:** the size button in the top bar sets every slide's canvas: landscape,
  portrait or square, a width and height in px, in or cm (96 px per inch), or a common size
  (16:9, 4:3, 4:5, 9:16, A4, US Letter). It is stored in deck.html as
  `<meta name="slopslide-size" content="1080x1350">`; for a deck with slides it puts a
  message in the chat asking the agent to lay them out again for the new size.
- **Present:** full-screen slideshow (arrows/space/click to advance, `Esc` to exit).
- **Export:** saves the deck as **one self-contained HTML file** (attached images embedded)
  that plays in any browser: arrows/space/click to navigate, `F` for full screen, `#slide-id`
  links, print to PDF. The same menu saves a **PDF** or **PNG images** (one per slide, in a
  new folder). The PDF has one page per shown slide, sized to the slide canvas, each slide as
  it looks once its animations finish, with real, selectable text: the system webview prints
  the deck straight to the file. On Windows and Linux everything in it is vector. macOS
  WebKit cannot print transparency, so there each slide's decor (backgrounds, shapes, images)
  goes in as one image under the text. A **video** export saves an MP4 (AV1, a royalty-free
  codec; the slide size up to 4K, 24, 30 or 60 fps) with each shown slide on screen for a set
  number of seconds. Entrance animations, slide fades and hero morphs play as they do when presenting,
  or each slide can be a still of its final frame. The deck plays in a hidden window whose
  animations follow the video's clock, so every frame is exact however long capturing it takes.
  With **Speak narration**, each slide's narration is said over it (an Opus audio track) after
  a short pause, and the slide stays until the narration and a pause after it end; the set
  seconds become the least a slide is shown.
- **Narration:** the Narration mode holds what is said over each slide. It is spoken
  on your computer by [Qwen3-TTS](https://github.com/QwenLM/Qwen3-TTS) 0.6B CustomVoice, in
  one of its nine voices and ten languages, chosen per deck. Its model (2.5 GB, all voices
  included) is downloaded on request to `~/.slopslides/models`. Each slide's audio is
  `narration/<slide id>.wav` next to the deck; a slide whose narration, voice or language
  changed is spoken again, the rest never. When presenting, the play button between the
  arrows runs the show by itself, speaking each slide's narration with the video export's
  timing. Speaking needs macOS or Linux (with OpenBLAS); Windows builds can write narration
  but not speak it yet.

Built with Tauri 2 (Rust) and React. It runs on macOS, Windows, and Linux.

## Requirements

- An installed, signed-in agent CLI: [Claude Code](https://claude.com/claude-code),
  [OpenAI Codex](https://developers.openai.com/codex/cli), or GitHub Copilot. Select its
  model in the chat composer. To use a binary outside your PATH, set
  `SLOPSLIDE_CLAUDE_PATH`, `SLOPSLIDE_CODEX_PATH`, or `SLOPSLIDE_COPILOT_PATH`.
- For development: Node 22+, pnpm, Rust (stable), CMake (to build whisper.cpp and libopus),
  and the [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/) for your OS; on
  Linux also `libasound2-dev` for the microphone and `libopenblas-dev` for narration.

## Development

```sh
pnpm install
pnpm app:dev        # desktop app with hot reload
pnpm app:build      # installers for the current OS → src-tauri/target/release/bundle
```

`pnpm dev` alone serves the UI at http://localhost:1420 in a plain browser, with mocked IPC
and read-only access to your deck library (`dev/browserPreview.ts`). This is handy for
UI work. Chat and editing need the desktop app.

Run `./check.sh` for Biome linting/formatting, typechecking, frontend tests/build, Rust
formatting, clippy, Rust tests, and dependency audits (`pnpm audit`, `cargo audit`); run
`./check.sh --fix` to format and autofix first. Every tool comes from `package.json` or
`src-tauri/Cargo.toml`, except `cargo-audit`, which the script installs on first run. CI runs this same script on macOS, Linux, and Windows, including approval
routing and cancellation tests against a mock Codex app-server built into the Rust test
binary. The full chat approval flow is tested through events, the store, UI, IPC
responses, and transcript persistence.

Biome enables the recommended accessibility rules and `noNoninteractiveElementInteractions`.
`noAutofocus` is disabled because desktop dialogs, rename fields, and model pickers
intentionally focus their input when opened. Scoped suppressions explain supplemental
mouse shortcuts, the input resize handle, and iframe load handlers.

The Rust tests also validate every request and approval response we send to Codex against
protocol schemas pinned from Codex **0.147.0** (the tested baseline) in
`fixtures/codex-schemas/`. This catches protocol drift, including changes to MCP approval
shapes, without an account, credentials, or model inference. To check a newer Codex
release, run `scripts/update-codex-schemas.sh <version>` and then `./check.sh`. Live
behavior tests below remain opt-in; schema validation cannot detect every behavioral
change in an external CLI.

The top bar shows whether the open deck file passes the HTML lint. When it does not, clicking the
status puts fix instructions into the chat composer; the agent then fixes the issues and
re-checks with its `lint_deck` tool.

## Permissions

The composer shows a permissions picker for every agent. Each agent remembers its own mode:

- **Ask for approval** (default): the agent reads and edits files in the workspace, fetches
  web pages, and uses SlopSlide's own tools (`lint_deck`, `open_file`) without asking.
  Shell commands, files outside the workspace, and other tools ask first. (Codex runs
  commands inside its workspace sandbox and asks for anything beyond it.)
- **Approve for me** (Codex only): the same workspace boundary, with Codex's automatic
  reviewer handling eligible approval requests. Automatic reviews can consume additional
  subscription usage.
- **Full access**: no sandbox or approval prompts. Selecting it requires confirmation.
- **Custom** (Codex only): use the current Codex configuration, including sandbox, approval
  policy, and reviewer.

SlopSlide's own MCP tools never ask in any mode. The selection is remembered locally and
cannot change during a turn. It is reapplied when resuming a conversation and never modifies
the agent's own configuration (`~/.codex/config.toml`, Claude Code settings). Codex modes
unavailable in the installed CLI or disallowed by managed requirements are omitted; Codex
remains responsible for enforcing the effective policy.

Requests appear in chat with the command, proposed file changes, network destination, or
requested permissions. Choose **Allow once**, **Deny**, or **Stop**; **Allow for session** is
shown when the agent offers it (Claude Code's session rules are kept for the session only,
never saved to settings). Codex's additional permission grants are limited to the current
turn. Automatic reviews show their status and rationale. Requests close when their turn ends.
Leaving a deck stops its active turn and saves the interrupted transcript, so an approval
cannot remain waiting in a hidden deck.
Codex MCP tool approval confirmations use the same cards. Structured input forms, URL
authentication, and device verification are not supported yet and receive an explicit error
instead of being automatically approved.

Codex chat uses `codex app-server` with your existing CLI login. ChatGPT sign-in uses your
subscription; API-key sign-in uses API billing. Update an older CLI with `codex update` if
permission discovery fails. Claude and Copilot retain their existing permission behavior.

Checks include an offline mock app-server. An optional live test makes two tiny inference
requests, verifies streaming and resume, and requests no file changes:

```sh
cargo test --manifest-path src-tauri/Cargo.toml real_codex_smoke_test -- --ignored
```

To inspect the installed server's effective permission presets without model inference:

```sh
cargo test --manifest-path src-tauri/Cargo.toml real_codex_permission_modes_test -- --ignored
```

The live MCP regression test approves only `slopslide/lint_deck` on a temporary deck
and makes one model request:

```sh
cargo build --manifest-path src-tauri/Cargo.toml
cargo test --manifest-path src-tauri/Cargo.toml real_codex_lint_approval_test -- --ignored
```

## Releases

Push a tag such as `v0.1.0`. `.github/workflows/release.yml` then builds macOS (Apple
Silicon and Intel), Windows (MSI/NSIS), and Linux (AppImage/deb/rpm) installers into a
draft GitHub release. Code signing and notarization secrets are listed in the workflow.

To build a signed and notarized macOS app and DMG locally, copy
`scripts/signing.env.example` to `.signing.env` (git-ignored), fill in your certificate and
notarization credentials, then run `scripts/build-signed.sh` (`--universal` for Apple Silicon
and Intel in one app, `--no-notarize` to only sign, `--check` to validate the settings without
building). Signing uses the hardened runtime with `src-tauri/Entitlements.plist`, which grants
the microphone for dictation.

## How it works

```
src/                    React UI (Zustand store, Tailwind)
src-tauri/src/
  deck.rs               deck folders: load/normalize, slide operations, export, snapshots
  sessions.rs           chat sessions in `~/.slopslides/sessions`, each tied to one workspace
  html.rs               finds the slide <section>s in deck.html and rewrites them;
                        installs the player runtime (assets/runtime.{css,js})
  size.rs               the deck's slide size (`slopslide-size` meta) and the stage CSS for it
  templates.rs          built-in and user templates (`~/.slopslides/templates`): listing,
                        new decks in a template's style, saving a deck as a template
  find.rs               find and replace in the text on a deck's slides (never markup)
  lint.rs               HTML lint for deck.html: well-formed markup plus the deck format
                        rules; shown as the status button in the top bar
  mcp.rs                stdio MCP server (`slopslide --lint-mcp [deck]`) exposing the
                        linter to the agent as its `lint_deck` tool
  agent.rs              manages turns and snapshots; normalizes provider events for the UI
  extensions.rs         the user's MCP servers, skills, plugins and AGENTS.md, passed to
                        every provider (see below)
  codex.rs              Codex app-server transport, permissions, and approval responses
  protocol.rs           `slop://` scheme serving deck files to the slide iframes;
                        adds the slide editor (assets/editor.js) for edit mode
  video.rs              MP4 export: plays the deck frame by frame in a hidden window
                        (assets/video.js) and encodes it as AV1 with rav1e
  mp4.rs                the MP4 file video.rs writes: one AV1 track, held frames stored
                        once, and an Opus track for narration
  narration/            spoken narration: the voice model's download, each deck's audio
                        (`narration/` next to it) and when it is out of date; engine.rs
                        runs Qwen3-TTS (vendor/qwen3-tts, built by build.rs) in a worker
                        process (`slopslide --narration-worker`)
  watcher.rs            file watcher → `deck-changed` events, so edits stream into the UI
src-tauri/prompts/      the agent's system prompt and design references, compiled into the
                        app and injected into every session
src-tauri/templates/    the built-in templates, one deck.html each (served with the runtime)
```

Each deck is a plain folder under `~/Documents/SlopSlide/<deck>/`:

```
deck.html        the whole presentation: <section class="slide" id="…"> per slide,
                 optional <div class="deck-section" data-title="…"> markers between them
                 that start a section, shared styles, the embedded player runtime, and
                 optionally <meta name="slopslide-template" content="…"> naming its template
assets/          attached images and media (inlined on export)
```

Nothing else, so a deck folder can be shared or committed as it is. The app keeps
everything else in `~/.slopslides/`:

```
templates/<name>/          user templates
sessions/<session id>/     one chat about a workspace: meta.json (its workspace
                           folder), chat.json, each provider's session id,
                           snapshots/<relative deck path>/, sketches/, templates staged for the agent,
                           and Claude Code's generated mcp.json and claude-plugins/
system-prompt.md           the system prompt file Claude Code reads
mcp.json                   your MCP servers, for every agent (see Extensions)
skills/<name>/SKILL.md     your skills
plugins/<name>/            your plugins
AGENTS.md                  your instructions, appended to the system prompt
```

A workspace's newest session is its current chat; New chat starts another and keeps the old
one. `system-prompt.md` and the session's Claude Code files are rewritten by the app when
they change.

### Extensions

Every agent gets the same MCP servers, skills, plugins and instructions, from
`~/.slopslides` and from the workspace:

| | `~/.slopslides` | workspace |
|---|---|---|
| MCP servers | `mcp.json` | `.mcp.json` |
| skills | `skills/<name>/SKILL.md` | `.agents/skills/<name>/SKILL.md` |
| plugins | `plugins/<name>/` | `.agents/plugins/<name>/` |
| instructions | `AGENTS.md` | `AGENTS.md` |

MCP files use Claude Code's `.mcp.json` format (`{"mcpServers": {"name": {"command": …}}}`
or `{"url": …, "headers": …}`); the workspace's servers win over yours of the same name, and
`slopslide` is reserved for the app. Plugins use the Claude Code plugin layout
(`.claude-plugin/plugin.json`, `skills/`, `agents/`, `hooks/`, `.mcp.json`). Each agent gets
them its own way:

| | Claude Code | Codex | Copilot |
|---|---|---|---|
| MCP servers | session `mcp.json`, with plugins' servers | `-c mcp_servers.<name>=…` | `mcpServers` |
| skills | a generated `slopslides` plugin | `skills/extraRoots/set` (finds `.agents/skills` itself) | `skillDirectories` |
| plugins | `--plugin-dir` | skills and MCP servers only | `pluginDirectories` |
| `~/.slopslides/AGENTS.md` | appended to the system prompt | `developerInstructions` | `systemMessage` |

Every agent reads the workspace's `AGENTS.md` itself. MCP tools other than the app's ask
for approval as the permission mode says; loading a skill never asks. The agents' own setup
(`~/.claude`, `~/.codex`, `~/.copilot`) is mostly left out: Copilot loads none of it,
Claude Code none of its MCP servers, but Claude Code and Codex still load their own skills
and plugins, and Codex its MCP servers.

`deck.html` already plays standalone in a browser. The editor renders individual slides of
it in sandboxed iframes (`deck.html?embed&slide=<id>`), so the thumbnails, stage, and
exported file all use the same player. Before every agent turn and slide deletion, a copy is
saved for every deck to the session's `snapshots/<relative deck path>/` (last 30 kept per file).
The safety scan skips dot folders and is bounded to 10,000 entries and 64 MiB of HTML;
turns refuse to start if those limits are exceeded. Legacy per-deck sessions remain on
disk; opening their workspace starts a fresh conversation.

Claude receives file tools (Read/Write/Edit/Glob/Grep plus web search/fetch), skills, the
app's `lint_deck` and `open_file` tools and the MCP servers from Extensions. Codex uses its
configured tools and MCP servers, plus `lint_deck`, `open_file` and the extensions, under the
selected permission mode. Copilot uses its
workspace-scoped read/write permission handler. You can also edit `deck.html` by hand in any
editor; the app picks up the changes.

The design guidance in the agent's prompt draws on
[frontend-slides](https://github.com/zarazhangrui/frontend-slides) (MIT). See
`src-tauri/prompts/THIRD_PARTY_NOTICES.md`.

## License

[MIT](LICENSE) © 2026 Matthias Rieck. Third-party notices are in
`src-tauri/prompts/THIRD_PARTY_NOTICES.md`.
