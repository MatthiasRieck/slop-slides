always generate test cases for changes

always run ./check.sh before finishing

whenever the deck structure changes (deck.html format, slide markup, runtime blocks, the rules in src-tauri/prompts/system.md), update the HTML linter in src-tauri/src/lint.rs (and its tests) to reflect the new structure

where files live:
- app content (system prompt, reference docs, runtime) is compiled into the app and injected, never copied into decks
- config shared by all decks (MCP config, user templates) goes in ~/.slopslides
- workspace app state (chat, provider session ids, sketches) goes in the workspace's session, ~/.slopslides/sessions/<id> (src-tauri/src/sessions.rs); a session is one chat
- each deck's undo history (whole-file versions of every change, whatever made it) goes in ~/.slopslides/history/<key of the deck's path> (src-tauri/src/history.rs), as it outlives chats
- a workspace may hold many decks and other files; new decks use <name>/deck.html with assets/ next to the deck file
