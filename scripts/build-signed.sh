#!/usr/bin/env bash
# Build a signed (and notarized) SlopSlide for macOS: SlopSlide.app and a .dmg.
#
#   scripts/build-signed.sh                 sign and notarize for this Mac's architecture
#   scripts/build-signed.sh --universal     one build for Apple Silicon and Intel
#   scripts/build-signed.sh --no-notarize   sign only (e.g. with an Apple Development cert)
#   scripts/build-signed.sh --check         validate the signing settings, do not build
#
# Settings come from the environment or from .signing.env in the repo root (git-ignored;
# set SLOPSLIDE_SIGNING_ENV to use another file). See scripts/signing.env.example.
set -euo pipefail
cd "$(dirname "$0")/.."

universal=0
notarize=1
check_only=0
for arg in "$@"; do
  case "$arg" in
    --universal) universal=1 ;;
    --no-notarize) notarize=0 ;;
    --check) check_only=1 ;;
    -h | --help)
      sed -n '2,10p' "$0" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *)
      printf '\033[1;31merror:\033[0m Unknown option: %s (try --help)\n' "$arg" >&2
      exit 1
      ;;
  esac
done

step() { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33mwarning:\033[0m %s\n' "$*"; }
die() { printf '\033[1;31merror:\033[0m %s\n' "$*" >&2; exit 1; }

[[ "$(uname -s)" == Darwin ]] || die "Signed builds are only set up for macOS."

env_file="${SLOPSLIDE_SIGNING_ENV:-.signing.env}"
if [[ -f "$env_file" ]]; then
  step "Loading signing settings from $env_file"
  set -a
  # shellcheck disable=SC1090
  source "$env_file"
  set +a
fi

identity="${APPLE_SIGNING_IDENTITY:-}"
[[ -n "$identity" ]] ||
  die "APPLE_SIGNING_IDENTITY is not set. Copy scripts/signing.env.example to .signing.env and fill it in."

identities="$(security find-identity -v -p codesigning)"
# The identity is a certificate name or its SHA-1 hash, which tells apart several
# certificates with the same name.
name="$identity"
if [[ "$identity" =~ ^[0-9A-Fa-f]{40}$ && -z "${APPLE_CERTIFICATE:-}" ]]; then
  name="$({ grep -i "$identity" <<<"$identities" || true; } | sed -n 's/^[^"]*"\(.*\)"$/\1/p' | head -1)"
  [[ -n "$name" ]] || die "No signing certificate with hash $identity in your keychain."
fi

if ((notarize)); then
  [[ "$name" == "Developer ID Application:"* ]] ||
    die "Notarization needs a \"Developer ID Application\" certificate, not \"$name\". Use --no-notarize to only sign."

  if [[ -n "${APPLE_API_KEY:-}" || -n "${APPLE_API_ISSUER:-}" || -n "${APPLE_API_KEY_PATH:-}" ]]; then
    [[ -n "${APPLE_API_KEY:-}" && -n "${APPLE_API_ISSUER:-}" && -n "${APPLE_API_KEY_PATH:-}" ]] ||
      die "An App Store Connect API key needs APPLE_API_KEY, APPLE_API_ISSUER and APPLE_API_KEY_PATH."
    [[ -f "$APPLE_API_KEY_PATH" ]] || die "APPLE_API_KEY_PATH does not exist: $APPLE_API_KEY_PATH"
    unset APPLE_ID APPLE_PASSWORD
  elif [[ -n "${APPLE_ID:-}" || -n "${APPLE_PASSWORD:-}" ]]; then
    [[ -n "${APPLE_ID:-}" && -n "${APPLE_PASSWORD:-}" && -n "${APPLE_TEAM_ID:-}" ]] ||
      die "Notarizing with an Apple ID needs APPLE_ID, APPLE_PASSWORD (app-specific) and APPLE_TEAM_ID."
  else
    die "No notarization credentials: set APPLE_API_KEY/APPLE_API_ISSUER/APPLE_API_KEY_PATH or APPLE_ID/APPLE_PASSWORD/APPLE_TEAM_ID (or pass --no-notarize)."
  fi
else
  # Tauri notarizes whenever these are set.
  unset APPLE_ID APPLE_PASSWORD APPLE_API_KEY APPLE_API_ISSUER APPLE_API_KEY_PATH
fi

# APPLE_CERTIFICATE (a base64 .p12, as in CI) is imported by Tauri into a temporary keychain;
# otherwise the identity has to be in the login keychain already.
if [[ -z "${APPLE_CERTIFICATE:-}" && "$name" == "$identity" ]]; then
  matches="$(grep -Fc "\"$identity\"" <<<"$identities" || true)"
  ((matches > 0)) ||
    die "Signing identity \"$identity\" was not found in your keychain (see: security find-identity -v -p codesigning)."
  ((matches == 1)) ||
    die "$matches certificates are named \"$identity\"; set APPLE_SIGNING_IDENTITY to the SHA-1 hash of one (see: security find-identity -v -p codesigning)."
elif [[ -n "${APPLE_CERTIFICATE:-}" && -z "${APPLE_CERTIFICATE_PASSWORD:-}" ]]; then
  die "APPLE_CERTIFICATE is set but APPLE_CERTIFICATE_PASSWORD is not."
fi

command -v pnpm >/dev/null || die "pnpm is required: corepack enable pnpm (or npm i -g pnpm)."
command -v cargo >/dev/null || die "Rust is required (https://rustup.rs)."
if ((notarize)); then
  xcrun --find notarytool >/dev/null 2>&1 || die "xcrun notarytool is missing; install the Xcode command line tools."
fi

if ((check_only)); then
  step "Signing settings look good (identity: $name, notarize: $([[ $notarize == 1 ]] && echo yes || echo no))"
  exit 0
fi

if [[ ! -d node_modules || pnpm-lock.yaml -nt node_modules/.modules.yaml ]]; then
  step "Installing dependencies"
  pnpm install --frozen-lockfile
fi

args=(--bundles app,dmg)
bundle_dir=src-tauri/target/release/bundle
if ((universal)); then
  rustup target add aarch64-apple-darwin x86_64-apple-darwin
  args+=(--target universal-apple-darwin)
  bundle_dir=src-tauri/target/universal-apple-darwin/release/bundle
fi

step "Building SlopSlide (signed with \"$name\")"
pnpm tauri build "${args[@]}"

app="$bundle_dir/macos/SlopSlide.app"
[[ -d "$app" ]] || die "Build finished but $app is missing."

step "Verifying the signature"
codesign --verify --deep --strict --verbose=2 "$app"
codesign --display --entitlements - "$app" 2>/dev/null | grep -q com.apple.security.device.audio-input ||
  die "$app is missing the microphone entitlement (src-tauri/Entitlements.plist)."

if ((notarize)); then
  step "Checking notarization and Gatekeeper"
  xcrun stapler validate "$app"
  spctl --assess --type execute --verbose=2 "$app"
fi

step "Done:"
ls -1d "$app" "$bundle_dir"/dmg/*.dmg 2>/dev/null | sed 's/^/  /'
