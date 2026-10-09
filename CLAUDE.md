always generate test cases for changes

always run ./check.sh before finishing

whenever the deck structure changes (deck.html format, slide markup, runtime blocks, the rules in src-tauri/prompts/system.md), update the HTML linter in src-tauri/src/lint.rs (and its tests) to reflect the new structure

where files live:
- app content (system prompt, reference docs, runtime) is compiled into the app and injected, never copied into decks
- config shared by all decks (MCP config, user templates) goes in ~/.slopslides
- per-deck app state (chat, provider session ids, snapshots, sketches) goes in the deck's session, ~/.slopslides/sessions/<id> (src-tauri/src/sessions.rs)
- a deck folder holds only deck.html and assets/, nothing of the app's
