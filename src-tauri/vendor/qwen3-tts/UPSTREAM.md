# Qwen3-TTS in C

The text-to-speech engine narration runs (see `src/narration/engine.rs` and `build.rs`).

- Upstream: <https://github.com/gabriele-mastrapasqua/qwen3-tts>
- Revision: `ef339be58a778b062e1c14382347964552eae007`
- License: MIT (`LICENSE`); its safetensors and GGUF reader, ingot, is MIT too
  (`third_party/ingot/LICENSE`); LZ4 is BSD-2-Clause (`vendor/lz4.h`).

Only the sources the CPU engine needs are kept: no command line, HTTP server, Metal,
CUDA or KleidiAI kernels, tests or tools. Local Windows patches:
- `qwen_tts_dispatch.c`: rename `yn` to avoid the Windows CRT Bessel-function name.
- `qwen_tts_kernels.c`: Windows CPU count and strong OpenBLAS thread-control symbols.

The Win32 POSIX subset is isolated in `native/windows`, force-included only into the
engine's Windows compilation. `QWEN_USE_PTHREADS` selects the concurrent-submission
pool with our SRW-lock/condition-variable shim. To update, retain these patches, check out the
new revision and copy the same files again (the list is `ENGINE` in `build.rs`, plus the
headers they include), then bump `ENGINE_REVISION` in `src/narration/mod.rs` so every deck's
narration is spoken again by the new engine.

The model it runs, Qwen3-TTS-12Hz-0.6B-CustomVoice (Apache-2.0), is not here: the app
downloads it on request (`MODEL_FILES` in `src/narration/mod.rs`).
