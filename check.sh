#!/usr/bin/env bash
# Run every check CI runs. Exits non-zero if any fail.
#
#   ./check.sh          all checks
#   ./check.sh --fix    format and autofix TypeScript and Rust first, then check
set -uo pipefail
cd "$(dirname "$0")"

if [[ ! -d node_modules || pnpm-lock.yaml -nt node_modules/.modules.yaml ]]; then
  pnpm install --frozen-lockfile || exit 1
fi

if ! command -v cargo-audit >/dev/null; then
  cargo install --locked cargo-audit || exit 1
fi

if [[ "${1:-}" == "--fix" ]]; then
  pnpm -s fix
  cargo fmt --manifest-path src-tauri/Cargo.toml
fi

failed=()
run() {
  local name="$1"
  shift
  printf '\033[1;34m==>\033[0m %s\n' "$name"
  if "$@"; then
    printf '\033[1;32m  ok\033[0m\n'
  else
    printf '\033[1;31m  FAILED\033[0m\n'
    failed+=("$name")
  fi
}

manifest=src-tauri/Cargo.toml
run "TypeScript lint (biome)"  pnpm -s lint
run "TypeScript typecheck"     pnpm -s typecheck
run "Frontend tests"           pnpm -s test
run "Frontend build"           pnpm -s exec vite build --logLevel warn
run "Rust format"              cargo fmt --manifest-path "$manifest" --check
run "Rust lint (clippy)"       cargo clippy --manifest-path "$manifest" --all-targets --quiet -- -D warnings
run "Rust tests"               cargo test --manifest-path "$manifest" --quiet
run "npm dependency audit"     pnpm audit
run "Rust dependency audit"    cargo audit --file src-tauri/Cargo.lock

echo
if ((${#failed[@]})); then
  printf '\033[1;31m%d check(s) failed:\033[0m %s\n' "${#failed[@]}" "${failed[*]}"
  [[ " ${failed[*]} " == *"format"* ]] && echo "Tip: ./check.sh --fix formats and autofixes the code."
  exit 1
fi
printf '\033[1;32mAll checks passed.\033[0m\n'
