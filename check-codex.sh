#!/usr/bin/env bash
# Optional, no-login protocol compatibility gate. Requires Codex and Python jsonschema 4.x.
set -euo pipefail
cd "$(dirname "$0")"
contract_tmp=$(mktemp -d)
trap 'rm -rf "$contract_tmp"' EXIT
export SLOPSLIDE_CONTRACT_OUT="$contract_tmp/cases.json"
codex --version
cargo test --manifest-path src-tauri/Cargo.toml export_codex_protocol_contracts -- --ignored
codex app-server generate-json-schema --experimental --out "$contract_tmp/schemas"
python3 -m unittest discover -s scripts -p 'test_codex_contracts.py'
python3 scripts/check_codex_contracts.py "$contract_tmp/schemas" "$SLOPSLIDE_CONTRACT_OUT"
