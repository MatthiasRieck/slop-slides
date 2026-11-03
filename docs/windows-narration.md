# Windows local narration

Windows x64 MSVC builds can run the same Qwen3-TTS CustomVoice model, voices,
languages, cache, playback and narrated-video exporter as macOS/Linux. AVX2 and FMA
are required; the Rust worker checks these before calling the native engine.
ARM64 Windows and GNU Windows targets currently build with an explicit unavailable
message. `SLOPSLIDE_NO_NARRATION_ENGINE=1` still disables the engine on every platform.

## Building

End users install the packaged application and download the model from its Narration
tab. They do not need WSL, a compiler, OpenBLAS, Python or a pthread DLL.

Source builds need these tools installed once:

- Git for Windows, Node.js 22+, pnpm, and stable Rust with the
  `x86_64-pc-windows-msvc` toolchain.
- Visual Studio Build Tools with **Desktop development with C++**, including the
  x64/x86 MSVC tools, a Windows SDK, and **C++ CMake tools for Windows**.
- **C++ Clang tools for Windows** in Visual Studio Installer, or a standalone LLVM
  installation containing `clang-cl.exe` (the standard `Program Files/LLVM/bin`
  location is detected automatically).
- The remaining [Tauri Windows prerequisites](https://v2.tauri.app/start/prerequisites/#windows),
  including the WebView2 runtime.

The engine uses C11 atomics,
GNU C extensions and SIMD intrinsics that cl.exe cannot compile. Only the narration
C sources use clang-cl; other native Rust dependencies retain their own compiler.

From a 64-bit PowerShell in the repository root, run:

```powershell
./start.ps1                  # development with hot reload
./start.ps1 -Mode release    # optimized executable, then launch
./start.ps1 -Mode build      # Windows installers
```

The launcher activates the installed x64 Visual Studio environment, finds Rust,
Clang and CMake, pins Rust to Microsoft's linker (including when using Git Bash),
installs JavaScript dependencies, and prepares narration. It does
not install system software or change permanent environment settings. If a tool
is missing, it stops with instructions. If local PowerShell policy blocks scripts,
use a process-only exception according to your machine's policy, for example
`powershell -NoProfile -ExecutionPolicy Bypass -File ./start.ps1`.

The first narration setup downloads the pinned vcpkg revision
`bcd3a4fa5419dbe6bfb23f7610062621b3f596f2` and builds
`openblas[threads]:x64-windows-narration` under the git-ignored
`.vcpkg-narration/` directory. This needs internet access and can take several
minutes. Subsequent runs validate and reuse that installation. An existing checkout
at a different revision or with tracked changes is reported without overwriting it.
To use an existing compatible static installation, set `SLOPSLIDE_OPENBLAS_DIR`
before starting; an invalid override is reported rather than silently replaced.

To configure native dependencies without launching, then run your own commands
**in the same PowerShell window**:

```powershell
./scripts/setup-windows.ps1
pnpm install --frozen-lockfile
pnpm tauri build --no-bundle
# Or run the repository checks using Git Bash from this configured shell:
bash ./check.sh
```

Both scripts require narration by default and clear a stale
`SLOPSLIDE_NO_NARRATION_ENGINE` in the process. To deliberately build without it,
use `./start.ps1 -NoNarration` (or `./scripts/setup-windows.ps1 -NoNarration` for
custom build commands). This skips OpenBLAS and the Clang requirement. Start a new
shell to discard the process environment changes. Direct Cargo/pnpm builds still
allow the existing fallback unless `SLOPSLIDE_REQUIRE_NARRATION_ENGINE` is set.

CI and releases call this same setup script through
`.github/actions/windows-narration`, caching the installed dependency and exporting
the required paths for later build steps. Run `./scripts/test-windows-build.ps1`
for offline setup regression tests; Windows CI runs them before dependency setup.

After launching the built app, download the approximately 2.5 GB Qwen3-TTS
0.6B CustomVoice model from the Narration tab, then generate and play a slide.
macOS uses the same model and engine with Apple's Accelerate framework, linked
automatically by `build.rs`; it does not require OpenBLAS. Linux uses its system
OpenBLAS package.

`SLOPSLIDE_OPENBLAS_DIR` must contain `include/openblas/cblas.h`, `lib/openblas.lib` and
`share/openblas/copyright`. Use the checked-in narration triplet, not a DLL/import library. It statically
links OpenBLAS with the dynamic MSVC CRT and fixes its CPU target to GENERIC (portable C). The MSVC port does not support
OpenBLAS's GNU assembly kernels or dynamic-architecture feature. Qwen's own
AVX2/FMA kernels remain enabled; BLAS-heavy operations may be slower than on
platforms with optimized OpenBLAS kernels. Measure this before release.
Without the variable, developer builds retain the unavailable-engine fallback;
CI/release sets `SLOPSLIDE_REQUIRE_NARRATION_ENGINE=1` to make this a hard error.
An explicitly disabled engine takes precedence over the requirement variable.

OpenBLAS is statically linked, with no Fortran/LAPACK or OpenMP runtime dependency.
It uses the same dynamic MSVC CRT as the Rust/Tauri app. The dependency's complete
BSD redistribution notice is embedded in the application and can be obtained with
`slopslide.exe --narration-license` (redirect stdout when running the GUI executable
from a terminal). The Qwen/ingot MIT and LZ4 BSD notices remain in the vendored sources.

## Port boundaries and automated coverage

`native/windows` supplies only the POSIX subset used by this engine: read-only
file mappings, 64-bit file sizes and positional reads, UTF-8-to-wide file/directory
APIs, monotonic timers, aligned allocation, and pthread-style Win32 locks,
conditions, threads and once initialization. Cache-discard hints are no-ops.
All engine allocation/free calls use the aligned CRT allocation family together.
The shim itself and external libraries use their own ordinary CRT allocations.

`QWEN_USE_PTHREADS` selects the upstream pool that serializes simultaneous
submissions from the talker and decoder; the upstream Win32 pool does not support
that concurrency. Rust owns process cancellation and WAV/cache publication. A
successful batch closes stdin and waits for a clean worker exit; dropping a worker
on cancellation or error kills it. Only completed `.wav.part` files are renamed and
entered in the manifest. Existing cached audio remains valid only for its recorded
text, voice, language, model and engine fingerprint.

Normal Windows CI builds the enabled engine and runs the existing cache,
checksum, audio/pause and export tests, plus native regressions for:

- spaces/non-ASCII characters in directory and model filenames;
- reading and mapping a sparse file beyond 4 GiB;
- compatible aligned allocation, reallocation and freeing;
- simultaneous thread-pool submissions and once initialization;
- starting the actual worker with an invalid model and receiving a failure.

## Real-model smoke and measurements

Run the **Windows narration real-model smoke** workflow manually, or run this on a
Windows machine with a built/installed executable and Python 3.11 or newer:

```powershell
python scripts/windows-narration-smoke.py --exe 'C:/Program Files/SlopSlide/slopslide.exe' --download
```

This downloads roughly 2.5 GB to `narration smoke 空間/voice model 模型`, checking every
file against the app's pinned size and SHA-256 before publishing it. Subsequent runs
verify and reuse the model. The executable receives paths with spaces and Unicode.
It renders English/Ryan and German/Aiden WAVs, checks their rate/sample count and
nonzero audio, checks invalid-voice failure, and verifies a clean exit on stdin EOF.
The workflow uploads WAVs, native stderr and `measurements.json` (model load time,
wall/audio duration, real-time factor, CPU description and peak working-set bytes).
Listen to both WAVs: sample validation alone does not establish intelligibility.

Before accepting a Windows release, also test the installed application:

1. Download the model in the Narration tab under a Windows profile with spaces and
   non-ASCII characters; cancel/retry a download and confirm checksum failures do
   not publish a completed file.
2. Render two slides; play both. Render again and confirm cache reuse. Change text,
   voice, then language individually and confirm regeneration.
3. Cancel during rendering, retry, and verify no child process remains after the
   cancellation settles and no partial result appears as ready. Repeat with a
   damaged model and confirm useful failure reporting.
4. Export a narrated MP4 and listen/watch in a player. Check both slide transitions,
   minimum slide duration, and leading/trailing pauses, including a short narration
   and a narration longer than the requested slide duration.
5. Run the smoke script against that installed executable and retain the report,
   machine CPU/RAM, app commit, and listening/export results with the release.

Validation recorded during this implementation: all native translation units were
cross-compiled to Windows COFF objects against Microsoft SDK headers on macOS.
Windows execution, installer playback/export, and representative Windows performance
measurements are **not yet recorded**; run the workflow and installed-app checklist
above. Cross-compilation is not evidence of Windows runtime acceptance.
