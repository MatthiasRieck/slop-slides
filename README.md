# SlopSlide

A desktop slide editor you drive by chatting. Describe a presentation, and an agent writes
the slides. Keep talking to it to restyle, rewrite, split, or add slides while you watch them change.

- **View and Edit:** View changes nothing in the deck but its review (marks and comments):
  it shows the slides, plays them on the timeline and takes your comments. Edit changes the
  deck: the slide on the stage, the slides and sections in the list on the left, and the
  timing on the timeline. What changes the deck is off in View.
- **Left:** live thumbnails. In Edit, drag to reorder; hover to lock, hide, duplicate, or delete; `+`
  adds a slide. A locked slide (lock icon) can be changed by neither you nor the agent: it
  cannot be edited on the stage, deleted, or saved changed from the code view, and if the
  agent changes it anyway the app puts it back after the turn. Unlock it to change it.
  Sections group slides under a heading in this column (never in the presentation): the
  section button starts one at the selected slide; double-click a heading to rename it, drag
  it to move the whole section (every section folds to its heading while you do, and slides before
  the first section stay put), hover to remove it. Drag a slide across a heading to move the boundary. ⌘C copies the selected slide (in Edit, after a press in the slide list),
  and in Edit ⌘V pastes a copied slide after the selected one. A locked slide stays as it is in Edit too: the stage says so and offers to unlock it.
- **Middle:** the current slide on a fixed stage (1920×1080 unless the deck has another slide
  size), scaled to fit. Arrow keys navigate.
  The move button below it turns on edit mode: click an element to select it, drag it (or
  use the arrow keys) to move it, double-click (or press Enter) to edit its text (Enter
  starts a new line, Escape or ⌘Enter finishes), Escape to select the parent, Delete (or the trash button in the edit bar) to remove
  it, ⌘C / ⌘X / ⌘V to copy, cut and paste elements (also between slides), and ⌘Z / Ctrl+Z
  to undo (the deck's one history; see How it works). ⌘V also pastes images and text copied in other apps, like a browser. Pastes go
  on top of the slide, under the pointer (or in the middle of the view), without moving the
  layout. Right-click an element for these actions and its stacking order, to ask the agent
  about it, or to have the agent tidy just an element you added. `?` lists the shortcuts.
  Lines and arrows have a point at each end instead of a box: drag one to move that end,
  drag the small handle on the line to add a point that curves it, and double-click a point
  in between to remove it.
  The edit ribbon above the slide groups its tools in sections, which collapse to an icon that
  opens them when the window gets narrow. It styles text: font (the deck's fonts and system
  fonts), size (±, or type one), color, bold / italic / underline (⌘B / ⌘I / ⌘U),
  strikethrough, superscript and subscript, line height and letter spacing, bulleted and
  numbered lists (Enter starts a new item, Tab / Shift+Tab indent and outdent, Backspace at
  the start of an item or Enter on an empty one takes its bullet away), and links to
  web pages, email addresses or other slides. While typing, these apply to the selected words
  (a list, to the lines the selection is in, so plain lines and lists mix in one text);
  otherwise to the whole element. A text box or shape stays one element whatever its text
  holds: it is selected, moved and resized whole. A text box can shrink its text or grow to fit instead of
  overflowing. Pasting into text keeps bold, italic, links and line breaks (⌘⇧V pastes plain
  text). The search field in the View ribbon (⌘F) searches the text of all slides and their
  notes as you type: the slide list shows only the slides that contain it, the slide you pick
  highlights it, and the arrows (or Enter and ⇧Enter) go through the matches. The button next to
  it replaces them, leaving locked slides alone. Moved
  elements keep a
  temporary offset; **Tidy layout** then sends the agent a screenshot so it rebuilds the
  slide's layout around where you put things.
- **Git:** for a deck in a git repository, the Git tab shows what changed since the last commit,
  staged or not. Without a repository, or without `git` installed, there is no Git tab. The
  slide list marks each slide with an icon in the middle of its thumbnail: a green plus for
  added, an orange pen for modified, a red trash can for removed and a blue arrow for moved
  (with the number it used to have). A slide that was edited and moved shows both, and removed
  slides stay in the list where they used to be (the filter button leaves out the slides that
  did not change). Click a modified slide to compare its two versions: drag across the slide to
  move the divider, drag its round handle to rotate it (Shift for steps of 15°), and set Angle
  and Feather above the slide. A feather of 0 is a sharp edge, 50 fades from one version to the
  other over 50 slide pixels. Slides show the images of their own version. What a picture
  cannot show, like speaker notes, is named under the slide.
  Left of each of those icons, a button stages that change (or unstages it), and right of it a
  button restores it, so a slide's edit and its move go separately; a change to the deck's shared
  styles (CSS, fonts, anything outside the slides) gets a row of its own at the top of the list,
  and its buttons are above the slide too. Staging one slide leaves the others out of the next commit,
  and brings along the images it shows. Restoring puts that one change back as it was committed;
  ⌘Z takes it back. The box above the list commits what is staged, and its + and − buttons stage
  and unstage the whole deck (changes to sections only go in that way). Before a
  deck's first commit every slide is new; staging one puts the deck with just the staged slides in
  the next commit, restoring one takes it out of the deck, and the styles count as changed once
  they differ from what is staged.
- **Right:** chat with the agent. Every deck has a chat of its own, which comes on show with
  the deck; with no deck open, the chat is the folder's own (say, to have a deck made, which
  that chat then moves to). The agent works in the open folder either way, so it can read the
  other decks and files in it. Past chats lists the chats of every deck in the folder: picking
  a deck's opens that deck, and picking any other goes on with it here. Leaving a deck while
  the agent works on it asks whether to stop the agent first. It knows which slide you're on, and you can attach images
  (paperclip, or drop files anywhere on the window). The microphone button dictates: click to
  start, and what you say shows up at the cursor as you speak; click again to keep it (Esc
  discards it). On macOS the first use asks for microphone access (when running from a
  terminal or editor, macOS asks for that app instead). Speech is
  transcribed on your computer with [Whisper](https://github.com/ggml-org/whisper.cpp) (small,
  multilingual); its model (190 MB) is downloaded on first use to `~/.slopslides/models`.
- **Folders:** the start screen opens a folder, one opened before, or a deck (in the folder it
  is in). In a folder, the menu on the file's path at the top left opens another folder or
  closes this one, back to the start screen.
- **Windows:** File › New Window (⌘N; Ctrl+N on Windows and Linux) opens another window,
  each with a folder and a deck of its own. Two windows can have the same folder open, each
  with another of its decks, and the agent can work on both decks at once; a deck is open in
  one window at a time, and so is a folder with no deck open. On macOS, a double-click on the app in
  Finder or New Window in its Dock menu (right-click the icon) opens another window too, while
  a click on the Dock icon only brings the app back. A folder
  dropped on the app's icon or opened with it from Finder (Open With) opens in a window: one
  on the start screen, else a new one. A folder already open without a deck in one window is
  brought to the front instead of opening twice. Elements and whole slides copied in one
  window paste into another; the images they show are copied into the receiving deck's
  `assets/`. A pasted element keeps its size and text look, but styles that come from the
  other deck's CSS (its classes, its theme) do not come along.
- **Styles and layouts:** decks can follow a template, a deck of example layouts (title,
  section, bullets, split, stats, quote, closing) in one style, with its own entrance animation. 31 come
  with the app (Claymorphism, Swiss Design, Synthwave, Terminal Green, Wabi-Sabi, …); add your own as folders in
  `~/.slopslides/templates/<name>/deck.html`. Pick a style when creating a deck or in the
  Settings mode (it puts a restyle request in the chat; an empty deck
  takes it at once); the same page has **Save deck as template**, which copies the deck there
  with its text replaced by placeholder words. The rail's `+` shows a blank slide and every
  layout of the deck's style as thumbnails and adds the one you click; **Layout** below the
  slide asks the agent to rebuild the current slide on a layout.
- **Slide size:** the Settings mode sets every slide's canvas: landscape,
  portrait or square, a width and height in px, in or cm (96 px per inch), or a common size
  (16:9, 4:3, 4:5, 9:16, A4, US Letter). It is stored in deck.html as
  `<meta name="slopslide-size" content="1080x1350">`; for a deck with slides it puts a
  message in the chat asking the agent to lay them out again for the new size.
- **Present:** full-screen slideshow (arrows/space/click to advance, `Esc` to exit). With
  several screens attached, a picker shows them as they are arranged, each with a screenshot
  of what is on it (on macOS this needs the Screen Recording permission; without it the picker
  shows the arrangement alone, as it does on Linux), to choose where the slides and the
  presenter view go.
  The teleprompter button in the presenter view (N) listens to you and follows you through the
  slide's narration, or its notes when it has none: what you said fades and the text scrolls
  along, even when you paraphrase or jump to another part. Words you jump over stay as they
  are. It moves the script only; you still change the slides. Speech stays on your computer,
  transcribed with the same Whisper model as dictation.
  Two more buttons there record the narration while you talk through the deck. **Text** adds
  what you say to the narration of the slide on screen; **audio** adds your voice to that
  slide's narration audio, which then plays in place of the generated speech (in the show and in
  videos) until you delete it in the sidebar's Narration tab. Go back and forth through the slides as
  you like: what you say is always added to the end of the slide on screen, and going back
  to a slide starts a new paragraph. The raw text keeps every stutter; **Clean up** in the Narration
  tab (for one slide or all of them) puts a request in the chat for the agent to turn it into clean, fluent
  sentences. Text needs the Whisper model, and nothing is kept for locked slides. The
  microphone does one thing at a time: teleprompter, text or audio.
- **PowerPoint:** **Import PowerPoint…** turns a `.pptx` into a new deck: slides, layouts and
  themes, text, images, shapes, tables, speaker notes, sections and hidden slides. The deck is
  HTML from then on; the file itself is left as it is and never written back. Animations are
  dropped, charts arrive as tables of their data, and EMF/WMF images are left out (the import
  says what it changed). The **PowerPoint** export writes a new `.pptx` of native, editable
  shapes and text, with notes and sections. Transparency, linear gradients and shadows stay
  PowerPoint's own effects; an inline SVG (and a shape drawn with the editor) becomes a group of
  freeform shapes, lines with their arrowheads, and text boxes; backdrop blur is dropped;
  whatever PowerPoint cannot draw (filters, masks, 3D, canvases, an SVG that uses filters,
  masks, clips, patterns, radial gradients or pictures, or comes from an image file) becomes a
  transparent picture. Web fonts are not embedded, so install them
  where the file is opened.
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
  seconds become the least a slide is shown. Slides timed on the narration timeline keep to
  that instead.
- **View ribbon:** View mode's tools sit in a ribbon like the edit tools', in sections that
  collapse to an icon when the window gets narrow: Mark up, Review, Animations, Timeline and Find. Under
  Animations, **Play** runs a slide's animations whenever it is shown, and **Final state** shows
  every slide as it ends up, with no animations, as the slide list does.
- **Marks and comments:** the View ribbon has a pen, a highlighter and an eraser for
  marking up the slide, and the comment tool: click an element (or the slide) and write what
  should change. Comments show as numbered pins that follow their element; click a pin to change
  or delete it. Marks and comments are saved in the deck file and can be hidden together. The
  composer attaches the comments to your next message, either this slide's or all slides', and
  lists them so you can leave some out. Each goes out once, and again if you change it.
- **Notes and narration in Markdown:** both are written in Markdown, with a preview in their
  panels; the presenter view shows them formatted and narration is spoken without the marks.
- **Narration:** the sidebar's Narration tab holds what is said over each slide (open it, like Notes and the deck's HTML, from the sidebar's `+`). It is spoken
  by a hosted text-to-speech service, OpenAI (the default) or ElevenLabs, with your own API key
  (entered in the tab, or `OPENAI_API_KEY` / `ELEVENLABS_API_KEY` in the environment), in the
  voice and one of ten languages chosen per deck. Each slide's audio is
  `narration/<slide id>.wav` next to the deck; a slide whose narration, voice or language
  changed is spoken again, the rest never. The tab shows the slide's audio as a waveform above its text, with each word where it is said once the words are timed: press it to play from there. When presenting, the play button between the
  arrows runs the show by itself, speaking each slide's narration with the video export's
  timing. The timeline under the slide (Timeline in the ribbon, in View and in Edit) shows the slides above the audio. In Edit, drag the end of a
  slide to change how long it shows, and the slides after it follow, each narration keeping
  its place in its slide. Drag a narration to move it, up to the narration on either side, so
  it can run over into the next slide, with the slide changing mid-sentence; video
  exports and the self-running show follow it, and the slide keeps its timing in the deck
  (`data-duration`, `data-narration-start`). Play, pause and the step buttons (a tenth of a second; a second with Shift) are in the middle of its bar; paused, stepped or with the playhead moved on the ruler, the slide is frozen as it is at that moment, its animations that far in (in View; in Edit the slide stays the editor's, and only playing takes it). A comment made in View while the slide is held so is about that moment: it is marked on the timeline's ruler, where pressing the mark goes back to it, and the agent is told how many seconds into the slide it is.

Built with Tauri 2 (Rust) and React. It runs on macOS, Windows, and Linux.

## Requirements

- An installed, signed-in agent CLI: [Claude Code](https://claude.com/claude-code),
  [OpenAI Codex](https://developers.openai.com/codex/cli), or GitHub Copilot. Select its
  model in the chat composer. To use a binary outside your PATH, set
  `SLOPSLIDE_CLAUDE_PATH`, `SLOPSLIDE_CODEX_PATH`, or `SLOPSLIDE_COPILOT_PATH`.
- For development: Node 22+, pnpm, Rust (stable), CMake (to build whisper.cpp and libopus),
  and the [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/) for your OS; on
  Linux also `libasound2-dev` for the microphone.

## Development

On **Windows x64**, install the [Windows prerequisites](docs/windows-build.md)
once, then use PowerShell from the checkout:

```powershell
./start.ps1                 # set up native dependencies, then start dev mode
./start.ps1 -Mode release   # build and launch an optimized executable
./start.ps1 -Mode build     # build Windows installers
```

The launcher detects Visual Studio/LLVM/CMake and Rust;
`-Mode browser` previews the UI without native tools. Setup runs in the current
process and does not install system tools or change your permanent PATH.

On **macOS/Linux**, or in an already configured build environment:

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
  web pages, and uses SlopSlide's own tools (`lint_deck`, `open_file`, `render_slide`) without
  asking.
  Shell commands, files outside the workspace, and other tools ask first. (Codex runs
  commands inside its workspace sandbox and asks for anything beyond it.)
- **Approve for me** (Codex only): the same workspace boundary, with Codex's automatic
  reviewer handling eligible approval requests. Automatic reviews can consume additional
  subscription usage.
- **Full access**: no sandbox or approval prompts. Selecting it requires confirmation.
- **Custom** (Codex only): use the current Codex configuration, including sandbox, approval
  policy, and reviewer.

SlopSlide's own MCP tools never ask in any mode. The selection is remembered locally and
can change while the agent works: Claude Code and GitHub Copilot apply it to the requests that
follow, and switching to Full access also allows the requests waiting in chat. Codex fixes its
sandbox and approval policy when a turn starts, so it applies a change from the next message.
It is reapplied when resuming a conversation and never modifies
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
Silicon), Windows (MSI/NSIS), and Linux (AppImage/deb/rpm) installers into a
draft GitHub release. Code signing and notarization secrets are listed in the workflow.

To build a signed and notarized macOS app and DMG locally, copy
`scripts/signing.env.example` to `.signing.env` (git-ignored), fill in your certificate and
notarization credentials, then run `scripts/build-signed.sh` (`--no-notarize` to only sign,
`--check` to validate the settings without building). Signing uses the hardened runtime with `src-tauri/Entitlements.plist`, which grants
the microphone for dictation.

## How it works

```
src/                    React UI (Zustand store, Tailwind)
src-tauri/src/
  deck.rs               deck folders: load/normalize, slide operations, export
  history.rs            each deck's undo history: whole-file versions of every change
                        (edits, rail, review, narration, code view, agent, other apps)
  rewind.rs             takes an agent's conversation back to before a message
  sessions.rs           chat sessions in `~/.slopslides/sessions`, each tied to one deck (or folder)
  html.rs               finds the slide <section>s in deck.html and rewrites them;
                        installs the player runtime (assets/runtime.{css,js})
  size.rs               the deck's slide size (`slopslide-size` meta) and the stage CSS for it
  templates.rs          built-in and user templates (`~/.slopslides/templates`): listing,
                        new decks in a template's style, saving a deck as a template
  comments.rs           the user's comments on slide elements, in a managed block in deck.html
  find.rs               find and replace in the text on a deck's slides (never markup)
  lint.rs               HTML lint for deck.html: well-formed markup plus the deck format
                        rules; shown as the status button in the top bar
  mcp.rs                stdio MCP server (`slopslide --lint-mcp [workspace] [session]`) exposing the
                        linter to the agent as its `lint_deck` tool, and `render_slide`
  render.rs             renders slides in a hidden window for `render_slide`, answering
                        the MCP server through the session folder
  agent.rs              manages turns; normalizes provider events for the UI
  extensions.rs         the user's MCP servers, skills, plugins and AGENTS.md, passed to
                        every provider (see below)
  codex.rs              Codex app-server transport, permissions, and approval responses
  protocol.rs           `slop://` scheme serving deck files to the slide iframes;
                        adds the slide editor (assets/editor/) for edit mode
  video.rs              MP4 export: plays the deck frame by frame in a hidden window
                        (assets/video.js) and encodes it as AV1 with rav1e
  mp4.rs                the MP4 file video.rs writes: one AV1 track, held frames stored
                        once, and an Opus track for narration
  narration/            spoken narration: each deck's audio (`narration/` next to it) and
                        when it is out of date; cloud.rs has OpenAI or ElevenLabs say it
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
history/<key>/             one deck's undo history: journal.json and each version
                           of its HTML (assets are not kept), the newest 100
sessions/<session id>/     one chat about a deck, or about a folder: meta.json (the
                           deck file or the folder), chat.json, each provider's session id,
                           rewind.json, sketches/, templates staged for the agent,
                           and Claude Code's generated mcp.json and claude-plugins/
system-prompt.md           the system prompt file Claude Code reads
mcp.json                   your MCP servers, for every agent (see Extensions)
skills/<name>/SKILL.md     your skills
plugins/<name>/            your plugins
AGENTS.md                  your instructions, appended to the system prompt
```

A deck's newest session is its current chat (a folder's, the chat with no deck open); New chat
starts another and keeps the old one. `system-prompt.md` and the session's Claude Code files are rewritten by the app when
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
exported file all use the same player.

Every change to a deck goes into its undo history, whatever made it: one entry per edit
gesture, rail change, find and replace, code view save, setting, and agent turn (each deck
the turn changed gets one entry, labeled with the message); typing notes or narration and
drawing review marks close together make one entry. A change made in another app is noticed
the next time the app looks (opening the deck, a reload, before an undo) and becomes an
"Outside change" entry. ⌘Z / ⇧⌘Z and the top bar's buttons step through it, in any mode,
except while the agent works; a new change drops what could be redone. Undoing an agent
turn asks whether the chat goes back too: the message returns to the composer, and the
provider's conversation is cut back when the next turn starts (Claude Code resumes with
`--resume-session-at`, Codex reverts the thread, Copilot truncates its history), or, where
it cannot be, the next prompt says what was undone. Keeping the chat marks the message and
tells the agent with the next one.
The turn of a deck's chat answers for that deck alone (its locked slides, its history entry):
the chats of other decks in the folder may be at work beside it. The turn of a folder's own
chat answers for every deck in the folder, so it does not run beside theirs. Its safety scan
skips dot folders and is bounded to 10,000 entries and 64 MiB of HTML;
turns refuse to start if those limits are exceeded. Chats saved for a folder before decks had
their own stay the folder's, and are listed under Past chats.

Claude receives file tools (Read/Write/Edit/Glob/Grep plus web search/fetch), skills, the
app's `lint_deck`, `open_file` and `render_slide` tools and the MCP servers from Extensions. Codex uses its
configured tools and MCP servers, plus `lint_deck`, `open_file`, `render_slide` and the extensions, under the
selected permission mode. Copilot uses its
workspace-scoped read/write permission handler. You can also edit `deck.html` by hand in any
editor; the app picks up the changes.

The design guidance in the agent's prompt draws on
[frontend-slides](https://github.com/zarazhangrui/frontend-slides) (MIT). See
`src-tauri/prompts/THIRD_PARTY_NOTICES.md`.

## License

[MIT](LICENSE) © 2026 Matthias Rieck. Third-party notices are in
`src-tauri/prompts/THIRD_PARTY_NOTICES.md`.
