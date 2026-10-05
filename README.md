# SlopSlide

A desktop slide editor you drive by chatting. Describe a presentation, and an agent writes
the slides. Keep talking to it to restyle, rewrite, split, or add slides while you watch them change.

- **Left:** live thumbnails. Drag to reorder; hover to duplicate or delete; `+` adds a blank slide.
  Sections group slides under a heading in this column (never in the presentation): the
  section button starts one at the selected slide; double-click a heading to rename it, drag
  it to move the boundary, hover to remove it.
- **Middle:** the current slide on a fixed 1920×1080 stage, scaled to fit. Arrow keys navigate.
- **Right:** chat with the agent. It knows which slide you're on, and you can attach images
  (paperclip, or drop files anywhere on the window).
- **Present:** full-screen slideshow (arrows/space/click to advance, `Esc` to exit).
- **Export:** saves the deck as **one self-contained HTML file** (attached images embedded)
  that plays in any browser: arrows/space/click to navigate, `F` for full screen, `#slide-id`
  links, print to PDF.

Built with Tauri 2 (Rust) and React. It runs on macOS, Windows, and Linux.

## Requirements

- [Claude Code](https://claude.com/claude-code), installed and signed in (`claude` works in a
  terminal). SlopSlide runs it headless for each chat turn. To use a binary outside your
  PATH, set `SLOPSLIDE_CLAUDE_PATH`.
- For development: Node 22+, pnpm, Rust (stable), and the
  [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/) for your OS.

## Development

```sh
pnpm install
pnpm app:dev        # desktop app with hot reload
pnpm app:build      # installers for the current OS → src-tauri/target/release/bundle
```

`pnpm dev` alone serves the UI at http://localhost:1420 in a plain browser, with mocked IPC
and read-only access to your deck library (`dev/browserPreview.ts`). This is handy for
UI work. Chat and editing need the desktop app.

Checks: `pnpm typecheck`, `cargo test --manifest-path src-tauri/Cargo.toml`.

The top bar shows whether `deck.html` passes the HTML lint. When it does not, clicking the
status puts fix instructions into the chat composer; the agent then fixes the issues and
re-checks with its `lint_deck` tool.

## Releases

Push a tag such as `v0.1.0`. `.github/workflows/release.yml` then builds macOS (Apple
Silicon and Intel), Windows (MSI/NSIS), and Linux (AppImage/deb/rpm) installers into a
draft GitHub release. Code signing and notarization secrets are listed in the workflow.

## How it works

```
src/                    React UI (Zustand store, Tailwind)
src-tauri/src/
  deck.rs               deck folders: load/normalize, slide operations, export, snapshots
  html.rs               finds the slide <section>s in deck.html and rewrites them;
                        installs the player runtime (assets/runtime.{css,js})
  lint.rs               HTML lint for deck.html: well-formed markup plus the deck format
                        rules; shown as the status button in the top bar
  mcp.rs                stdio MCP server (`slopslide --lint-mcp <deck>`) exposing the
                        linter to the agent as its `lint_deck` tool
  agent.rs              runs `claude -p --output-format stream-json` per turn, resumes the
                        deck's session, normalizes the stream into `agent-event`s
  protocol.rs           `slop://` scheme serving deck files to the slide iframes
  watcher.rs            file watcher → `deck-changed` events, so edits stream into the UI
src-tauri/prompts/      the agent's system prompt and design references
```

Each deck is a plain folder under `~/Documents/SlopSlide/<deck>/`:

```
deck.html        the whole presentation: <section class="slide" id="…"> per slide,
                 optional <div class="deck-section" data-title="…"> markers between them
                 that start a section, shared styles, and the embedded player runtime
assets/          attached images and media (inlined on export)
.slopslide/      chat history, agent session, reference docs, snapshots (app-managed)
```

`deck.html` already plays standalone in a browser. The editor renders individual slides of
it in sandboxed iframes (`deck.html?embed&slide=<id>`), so the thumbnails, stage, and
exported file all use the same player. Before every agent turn and slide deletion, a copy is
saved to `.slopslide/snapshots/` (last 30 kept).

The agent only gets file tools (Read/Write/Edit/Glob/Grep plus web search/fetch) and the
app's own `lint_deck` tool. It has no shell access and loads no other MCP servers. You can also edit `deck.html` by hand in any editor;
the app picks up the changes.

The design guidance in the agent's prompt draws on
[frontend-slides](https://github.com/zarazhangrui/frontend-slides) (MIT). See
`src-tauri/prompts/THIRD_PARTY_NOTICES.md`.
