# Building on Windows

End users install the packaged application; they need no compiler or other tools.

Source builds target x64 Windows with the MSVC toolchain and need these tools
installed once:

- Git for Windows, Node.js 22+, pnpm, and stable Rust with the
  `x86_64-pc-windows-msvc` toolchain.
- Visual Studio Build Tools with **Desktop development with C++**, including the
  x64/x86 MSVC tools, a Windows SDK, and **C++ CMake tools for Windows**.
- LLVM (for example **C++ Clang tools for Windows** in Visual Studio Installer, or a
  standalone installation in `Program Files/LLVM`): bindgen loads its libclang to
  generate the bindings of whisper.cpp, which transcribes voice input.
- The remaining [Tauri Windows prerequisites](https://v2.tauri.app/start/prerequisites/#windows),
  including the WebView2 runtime.

From a 64-bit PowerShell in the repository root, run:

```powershell
./start.ps1                  # development with hot reload
./start.ps1 -Mode release    # optimized executable, then launch
./start.ps1 -Mode build      # Windows installers
```

The launcher activates the installed x64 Visual Studio environment, finds Rust,
CMake and LLVM, pins Rust to Microsoft's linker (including when using Git Bash), and
installs JavaScript dependencies. It does not install system software or change
permanent environment settings. If a tool is missing, it stops with instructions.
If local PowerShell policy blocks scripts, use a process-only exception according
to your machine's policy, for example
`powershell -NoProfile -ExecutionPolicy Bypass -File ./start.ps1`.

To configure the build tools without launching, then run your own commands
**in the same PowerShell window**:

```powershell
./scripts/setup-windows.ps1
pnpm install --frozen-lockfile
pnpm tauri build --no-bundle
# Or run the repository checks using Git Bash from this configured shell:
bash ./check.sh
```

CI and releases call the same setup script through `.github/actions/windows-build`,
exporting the linker and CMake paths for later build steps. Run
`./scripts/test-windows-build.ps1` for offline setup regression tests; Windows CI
runs them before setup.
