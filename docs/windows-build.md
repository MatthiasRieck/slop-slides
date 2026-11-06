# Building on Windows

End users install the packaged application and download the narration voice model
(about 80 MB) from its Narration tab. They need no compiler, Python or other runtime.

Narration runs [Kitten TTS](https://github.com/KittenML/KittenTTS) Mini 0.8 with ONNX
Runtime, which the build downloads prebuilt and links statically (the `ort` crate), so
Windows needs no narration-specific build tools.

## Prerequisites

Install these once:

- Git for Windows, Node.js 22+, pnpm, and stable Rust with the
  `x86_64-pc-windows-msvc` toolchain.
- Visual Studio Build Tools with **Desktop development with C++**, including the
  x64/x86 MSVC tools, a Windows SDK, and **C++ CMake tools for Windows** (CMake builds
  whisper.cpp and libopus).
- The remaining [Tauri Windows prerequisites](https://v2.tauri.app/start/prerequisites/#windows),
  including the WebView2 runtime.

## Building

From a 64-bit PowerShell in the repository root, run:

```powershell
./start.ps1                  # development with hot reload
./start.ps1 -Mode release    # optimized executable, then launch
./start.ps1 -Mode build      # Windows installers
```

The launcher activates the installed x64 Visual Studio environment, finds Rust and
CMake, pins Rust to Microsoft's linker (including when using Git Bash), and installs
JavaScript dependencies. It does not install system software or change permanent
environment settings. If a tool is missing, it stops with instructions. If local
PowerShell policy blocks scripts, use a process-only exception according to your
machine's policy, for example
`powershell -NoProfile -ExecutionPolicy Bypass -File ./start.ps1`.

To configure the build tools without launching, then run your own commands **in the
same PowerShell window**:

```powershell
./scripts/setup-windows.ps1
pnpm install --frozen-lockfile
pnpm tauri build --no-bundle
# Or run the repository checks using Git Bash from this configured shell:
bash ./check.sh
```

CI and releases call the same setup script through `.github/actions/windows-build`.
Run `./scripts/test-windows-build.ps1` for offline launcher regression tests; Windows
CI runs them first.

## Real-model narration smoke

Run the **Narration real-model smoke** workflow manually (macOS, Linux and Windows), or
run this on any machine with a built or installed executable and Python 3.11 or newer:

```powershell
python scripts/narration-smoke.py --exe 'C:/Program Files/SlopSlide/slopslide.exe' --download
```

This downloads the model to `narration smoke 空間/voice model 模型`, checking every file
against the app's pinned size and SHA-256, so the executable gets paths with spaces and
non-ASCII characters. It drives the narration worker directly: it renders three WAVs
(numbers and currency, a paragraph break, and a script longer than the model reads at
once), checks their rate, sample count and that they are not silent, checks that an
unknown voice fails, and checks a clean exit on stdin EOF. It writes the WAVs, the
worker's stderr and `measurements.json` (load time, wall and audio duration, real-time
factor and, on Windows, peak working set). Listen to the WAVs: sample checks alone do
not show that the speech is intelligible.
