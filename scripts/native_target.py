"""The native helpers currently require a Mac matching the Tauri build target."""
import os
import platform


def native_macos_arch():
    host = platform.machine()
    target = os.environ.get("TAURI_ENV_TARGET_TRIPLE")
    expected = {"aarch64-apple-darwin": "arm64", "x86_64-apple-darwin": "x86_64"}
    if host not in expected.values() or (target and expected.get(target) != host):
        raise SystemExit(
            f"Native speech/video helpers cannot build target {target or host} on {host}. "
            "Build on a Mac with the matching architecture; universal/cross builds are unsupported."
        )
    return host
