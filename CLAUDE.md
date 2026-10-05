always generate test cases for changes

always run ./check.sh before finishing

whenever the deck structure changes (deck.html format, slide markup, runtime blocks, the rules in src-tauri/prompts/system.md), update the HTML linter in src-tauri/src/lint.rs (and its tests) to reflect the new structure
