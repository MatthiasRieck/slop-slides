#!/usr/bin/env bash
# Start SlopSlide.
#
#   ./start.sh            desktop app in dev mode (hot reload)
#   ./start.sh --release  build an optimized app for this OS, then launch it
#   ./start.sh --browser  UI only in a browser at http://localhost:1420 (mocked, read-only)
set -euo pipefail
cd "$(dirname "$0")"

mode="${1:-dev}"
case "$mode" in
  dev | --dev | --release | --browser) ;;
  -h | --help)
    sed -n '2,6p' "$0" | sed 's/^# \{0,1\}//'
    exit 0
    ;;
  *)
    printf '\033[1;31merror:\033[0m Unknown option: %s (try --help)\n' "$mode" >&2
    exit 1
    ;;
esac

step() { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33mwarning:\033[0m %s\n' "$*"; }
die() { printf '\033[1;31merror:\033[0m %s\n' "$*" >&2; exit 1; }

command -v node >/dev/null || die "Node.js is required (https://nodejs.org)."
command -v pnpm >/dev/null || die "pnpm is required: corepack enable pnpm (or npm i -g pnpm)."
if [[ "$mode" != "--browser" ]]; then
  command -v cargo >/dev/null || die "Rust is required (https://rustup.rs)."
fi

if [[ -n "${SLOPSLIDE_CLAUDE_PATH:-}" ]]; then
  [[ -x "$SLOPSLIDE_CLAUDE_PATH" ]] || warn "SLOPSLIDE_CLAUDE_PATH=$SLOPSLIDE_CLAUDE_PATH is not executable."
elif ! command -v claude >/dev/null; then
  warn "Claude Code ('claude') not found on PATH; chat will not work until it is installed."
fi

# Install dependencies on first run or when the lockfile changed.
if [[ ! -d node_modules || pnpm-lock.yaml -nt node_modules/.modules.yaml ]]; then
  step "Installing dependencies"
  pnpm install --frozen-lockfile
fi

if lsof -nP -iTCP:1420 -sTCP:LISTEN >/dev/null 2>&1 && [[ "$mode" != "--release" ]]; then
  die "Port 1420 is already in use (another SlopSlide dev server?). Stop it and retry."
fi

case "$mode" in
  dev | --dev)
    step "Starting SlopSlide (dev)"
    exec pnpm app:dev
    ;;
  --release)
    step "Building SlopSlide (release)"
    case "$(uname -s)" in
      Darwin)
        pnpm tauri build --bundles app
        app="src-tauri/target/release/bundle/macos/SlopSlide.app"
        step "Launching $app"
        open "$app"
        ;;
      *)
        pnpm tauri build --no-bundle
        step "Launching src-tauri/target/release/slopslide"
        exec src-tauri/target/release/slopslide
        ;;
    esac
    ;;
  --browser)
    step "Serving UI at http://localhost:1420"
    exec pnpm dev
    ;;
esac
