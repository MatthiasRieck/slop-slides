/* A small C face for the Qwen3-TTS engine (vendor/qwen3-tts), so narration.rs can call it
   without knowing the engine's context struct. Only the narration worker process uses it
   (see src/narration/engine.rs): the engine may exit the process on a broken model. */
#include "qwen_tts.h"
#include "qwen_tts_kernels.h"

#include <math.h>
#include <stdlib.h>

void *slop_tts_load(const char *model_dir, int threads) {
    if (threads > 0) qwen_set_threads(threads);
    return qwen_tts_load_ex(model_dir, 1, 0, 0);
}

/* Says `text` in `speaker`'s voice. 0 with `*audio` (malloc'd, 24 kHz mono) on success;
   -1 for an unknown speaker or language; -2 when generation failed, was cancelled, or ran
   past `max_frames` (12 a second) without finishing. */
int slop_tts_speak(void *handle, const char *text, const char *speaker, const char *language,
                   int max_frames, unsigned int seed, int (*cancel)(void *), void *user,
                   float **audio, int *samples) {
    qwen_tts_ctx_t *ctx = handle;
    *audio = NULL;
    *samples = 0;
    int id = qwen_tts_resolve_speaker(ctx, speaker);
    if (id < 0 || qwen_tts_language_id(language) < 0) return -1;
    qwen_tts_set_language(ctx, language);
    qwen_tts_set_speaker(ctx, id);
    /* The sampling SlopSlide's narration was tuned with (PR #70's worker). */
    ctx->temperature = 0.9f;
    ctx->top_k = 50;
    ctx->top_p = 1.0f;
    ctx->rep_penalty = 1.05f;
    ctx->max_tokens = max_frames;
    ctx->seed = seed;
    ctx->cancel_cb = cancel;
    ctx->cancel_cb_userdata = user;
    unsigned long long before = qwen_tts_frames_generated();
    int rc = qwen_tts_generate(ctx, text, audio, samples);
    unsigned long long frames = qwen_tts_frames_generated() - before;
    int ok = rc == 0 && *audio && *samples > 0 && frames < (unsigned long long)max_frames;
    for (int i = 0; ok && i < *samples; i++)
        if (!isfinite((*audio)[i])) ok = 0;
    if (!ok) {
        free(*audio);
        *audio = NULL;
        *samples = 0;
        return -2;
    }
    return 0;
}

void slop_tts_free_audio(float *audio) { free(audio); }

void slop_tts_unload(void *handle) { qwen_tts_unload(handle); }
