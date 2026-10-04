# SlopSlide

A desktop slide editor you drive by chatting. Describe a presentation, and an agent writes
the slides. Keep talking to it to restyle, rewrite, split, or add slides while you watch them change.

- **Left:** live thumbnails. Drag to reorder; hover to duplicate or delete; `+` adds a blank slide.
- **Middle:** the current slide on a fixed 1920×1080 stage, scaled to fit. Arrow keys navigate.
- **Right:** chat with the agent. It knows which slide you're on, and you can attach images
  (paperclip, or drop files anywhere on the window).
- **Present:** full-screen slideshow (arrows/space/click to advance, `Esc` to exit).

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

## Releases

Push a tag such as `v0.1.0`. `.github/workflows/release.yml` then builds macOS (Apple
Silicon and Intel), Windows (MSI/NSIS), and Linux (AppImage/deb/rpm) installers into a
draft GitHub release. Code signing and notarization secrets are listed in the workflow.

## How it works

```
src/                    React UI (Zustand store, Tailwind)
src-tauri/src/
  deck.rs               deck folders: manifest, slides, assets, chat, session
  agent.rs              runs `claude -p --output-format stream-json` per turn, resumes the
                        deck's session, normalizes the stream into `agent-event`s
  protocol.rs           `slop://` scheme serving deck files to slide iframes, injecting
                        the stage CSS (1920×1080 canvas, reveal animations) and key forwarding
  watcher.rs            file watcher → `deck-changed` events, so edits stream into the UI
src-tauri/prompts/      the agent's system prompt and design references
```

Each deck is a plain folder under `~/Documents/SlopSlide/<deck>/`:

```
deck.json        {"title": "...", "slides": ["slides/01-title.html", ...]}   ← order
theme.css        shared design system
slides/*.html    one standalone HTML document per slide, authored at 1920×1080
assets/          attached images and media
.slopslide/      chat history, agent session, reference docs, trash (app-managed)
```

The agent only gets file tools (Read/Write/Edit/Glob/Grep plus web search/fetch). It has no
shell access and loads no MCP servers. Slides render in sandboxed iframes, so you can also
edit the files by hand in any editor and the app picks up the changes.

The design guidance in the agent's prompt draws on
[frontend-slides](https://github.com/zarazhangrui/frontend-slides) (MIT). See
`src-tauri/prompts/THIRD_PARTY_NOTICES.md`.
