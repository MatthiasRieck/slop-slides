import { ArrowUp, CornerDownRight, ListEnd, Paperclip, Square } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";

import { formatKeys } from "../../lib/keys";
import { cn } from "../../lib/utils";
import { useApp } from "../../store";
import { EffortPicker, ModelPicker } from "../ModelPicker";
import { PermissionPicker } from "../Permissions";
import { VoiceInput, type VoiceInputHandle } from "../VoiceInput";
import { ComposerChips } from "./ComposerChips";
import { ContextMeter } from "./ContextMeter";
import { ImageFan, ImageGrid } from "./ImageAttachments";
import { InputResizeHandle, MIN_INPUT_HEIGHT } from "./InputResizeHandle";
import { QueuedMessages } from "./QueuedMessages";
import { useAttachments } from "./useAttachments";
import { useDictation } from "./useDictation";

/** The key that steers the agent with the composer's message. */
const STEER_KEY = formatKeys("mod+enter");

/**
 * Where the user writes (or dictates) to the agent, with what goes along with the message: the
 * slide, attachments, the sketch and comments. Enter sends; while the agent works it queues, and
 * with the modifier it steers the turn.
 */
export function Composer(props: { draft: string; setDraft: (text: string) => void }) {
  const { draft, setDraft } = props;
  const deck = useApp((s) => s.deck);
  const workspace = useApp((s) => s.workspace);
  const selected = useApp((s) => s.selected);
  const running = useApp((s) => s.running);
  const [includeSlide, setIncludeSlide] = useState(true);
  const attachments = useAttachments();
  const { images, screenshot, element } = attachments;
  const [gridOpen, setGridOpen] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [inputHeight, setInputHeight] = useState<number | null>(null);
  const maxInputHeight = Math.max(MIN_INPUT_HEIGHT, Math.min(240, window.innerHeight * 0.4));

  const slideNumber = selected && deck ? deck.slides.findIndex((s) => s.id === selected) + 1 : 0;
  // Marks go out once while on show (see `send`); they stay on the slide as a review.
  const unsentSketch = useApp((s) => {
    const marks = selected ? s.sketches[selected] : undefined;
    return !!selected && !!marks?.length && s.reviewVisible && marks !== s.sketchesSent[selected];
  });
  const sendsSketch = unsentSketch && includeSlide && slideNumber > 0;

  /** Sends the message, or while the agent works queues it; `steer` sends it into the turn. */
  const send = (message: string, steer = false) => {
    const text = message.trim();
    if (!text) return;
    const options = {
      includeSlide: includeSlide && slideNumber > 0,
      attachments: attachments.attachments,
      ...(screenshot && { screenshot }),
      ...(element && { element }),
    };
    const app = useApp.getState();
    void (steer && running ? app.steer(text, options) : app.send(text, options));
    setDraft("");
    attachments.clear();
    setGridOpen(false);
  };

  const dictation = useDictation({ draft, setDraft, textarea: textareaRef, send });
  const voiceInput = useRef<VoiceInputHandle>(null);
  const shownDraft = dictation.shownDraft;

  useLayoutEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    if (inputHeight !== null) {
      el.style.height = `${inputHeight}px`;
      return;
    }
    // An empty composer stays at its smallest; measuring the placeholder while the panel
    // is still opening (and narrow) would otherwise make it start out tall.
    if (!shownDraft) {
      el.style.height = "64px";
      return;
    }
    el.style.height = "auto";
    el.style.height = `${Math.min(Math.max(el.scrollHeight, 64), 240)}px`;
  }, [shownDraft, inputHeight]);

  // The textarea doesn't have focus while dictating, so it doesn't follow the words coming in:
  // keep the end of the dictated text in view, measured as the height of the text up to it.
  // biome-ignore lint/correctness/useExhaustiveDependencies: follows the shown text
  useLayoutEffect(() => {
    const el = textareaRef.current;
    const caret = dictation.caret;
    if (!el || caret === null) return;
    const value = el.value;
    el.value = value.slice(0, caret);
    const bottom = el.scrollHeight;
    el.value = value;
    if (bottom > el.scrollTop + el.clientHeight || bottom < el.scrollTop) {
      el.scrollTop = Math.max(0, bottom - el.clientHeight);
    }
  }, [shownDraft, inputHeight]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: refocus when the draft is sent or cleared
  useEffect(() => {
    textareaRef.current?.focus();
  }, [draft === ""]);

  // A prepared message (see `useAttachments` for what it brings along) is ready to send.
  const composerFill = useApp((s) => s.composerFill);
  // biome-ignore lint/correctness/useExhaustiveDependencies: focuses each time a message is prepared
  useEffect(() => {
    textareaRef.current?.focus();
  }, [composerFill]);

  const submit = (steer = false) => {
    if (!dictation.dictating) send(draft, steer);
  };

  /** Takes a queued message back into the composer, after what is there. */
  const editQueued = (id: string) => {
    const item = useApp.getState().takeQueued(id);
    if (!item) return;
    setDraft(draft.trim() ? `${draft.trimEnd()}\n\n${item.text}` : item.text);
    const { options } = item;
    attachments.add(options.attachments);
    if (options.screenshot) attachments.setScreenshot(options.screenshot);
    if (options.element) attachments.setElement(options.element);
    setIncludeSlide(options.includeSlide);
    textareaRef.current?.focus();
  };

  return (
    <div className="mx-auto w-full max-w-3xl shrink-0 px-3 pb-3">
      <QueuedMessages onEdit={editQueued} />
      <div className="relative">
        {workspace &&
          images.length > 0 &&
          (gridOpen ? (
            <ImageGrid
              workspacePath={workspace.path}
              images={images}
              onRemove={(path) => {
                attachments.remove(path);
                if (images.length === 1) setGridOpen(false);
              }}
              onClose={() => setGridOpen(false)}
            />
          ) : (
            <ImageFan workspacePath={workspace.path} images={images} onOpen={() => setGridOpen(true)} />
          ))}
        <ContextMeter />
        {/* biome-ignore lint/a11y/noNoninteractiveElementInteractions: clicking padding focuses the keyboard-accessible textarea. */}
        {/* biome-ignore lint/a11y/noStaticElementInteractions: this is a focus convenience, not a separate control. */}
        {/* biome-ignore lint/a11y/useKeyWithClickEvents: keyboard users can tab directly to the textarea. */}
        <div
          onClick={(e) => {
            if (e.target === e.currentTarget) textareaRef.current?.focus();
          }}
          className={cn(
            "relative z-10 rounded-2xl border bg-card/95 shadow-composer backdrop-blur-xl transition-colors focus-within:border-ring/50",
            attachments.dragging && "border-primary ring-2 ring-primary/30",
          )}
        >
          <InputResizeHandle
            textarea={textareaRef}
            height={inputHeight}
            max={maxInputHeight}
            onResize={setInputHeight}
          />
          <ComposerChips
            slideNumber={slideNumber}
            includeSlide={includeSlide}
            onToggleSlide={() => setIncludeSlide((v) => !v)}
            element={element}
            onDropElement={() => attachments.setElement(null)}
            sendsSketch={sendsSketch}
            selected={selected}
            files={attachments.files}
            onRemove={attachments.remove}
          />
          <textarea
            ref={textareaRef}
            value={dictation.shownDraft}
            rows={1}
            readOnly={dictation.dictating}
            onChange={(e) => setDraft(e.target.value)}
            onPaste={attachments.onPaste}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                submit(e.metaKey || e.ctrlKey);
              }
            }}
            placeholder={
              dictation.dictating
                ? "Listening…"
                : running
                  ? `Queue a message, or ${STEER_KEY} to steer the agent now…`
                  : "Ask for slides or changes…"
            }
            className="block max-h-[max(64px,min(240px,40vh))] min-h-16 w-full resize-none bg-transparent px-3.5 pt-3 text-sm leading-relaxed outline-none placeholder:text-muted-foreground/70"
          />
          <div className="@container px-2 pt-2 pb-2">
            <div className="relative flex flex-nowrap items-center gap-1">
              {/* While dictating, the waveform that VoiceInput shows takes the place of the options. */}
              {!dictation.dictating && (
                <>
                  <ModelPicker />
                  <div className="mx-0.5 h-4 w-px bg-border" />
                  <EffortPicker />
                  <PermissionPicker />
                  <div className="min-w-0 flex-1" />
                </>
              )}
              <VoiceInput ref={voiceInput} {...dictation.handlers} />
              {!dictation.dictating && (
                <button
                  type="button"
                  onClick={attachments.pickFiles}
                  title="Attach images or files"
                  className="flex size-8 shrink-0 items-center justify-center rounded-full text-muted-foreground hover:bg-accent hover:text-foreground"
                >
                  <Paperclip className="size-4" />
                </button>
              )}
              {running && !dictation.dictating && draft.trim() && (
                <>
                  <button
                    type="button"
                    onClick={() => submit(true)}
                    title={`Steer: send into the agent's turn now (${STEER_KEY})`}
                    aria-label="Steer"
                    className="flex size-8 shrink-0 items-center justify-center rounded-full text-muted-foreground hover:bg-accent hover:text-foreground"
                  >
                    <CornerDownRight className="size-4" />
                  </button>
                  <button
                    type="button"
                    onClick={() => submit()}
                    title="Queue: send when the agent finishes (↵)"
                    aria-label="Queue"
                    className="flex size-8 shrink-0 items-center justify-center rounded-full text-muted-foreground hover:bg-accent hover:text-foreground"
                  >
                    <ListEnd className="size-4" />
                  </button>
                </>
              )}
              {running ? (
                <button
                  type="button"
                  onClick={() => useApp.getState().interrupt()}
                  title="Stop"
                  className="flex size-8 shrink-0 items-center justify-center rounded-full bg-foreground text-background hover:opacity-80"
                >
                  <Square className="size-3 fill-current" />
                </button>
              ) : (
                <button
                  type="button"
                  onClick={() => (dictation.dictating ? voiceInput.current?.finishAndSend() : submit())}
                  disabled={!dictation.dictating && !draft.trim()}
                  title={dictation.dictating ? "Stop and send" : "Send"}
                  className="flex size-8 shrink-0 items-center justify-center rounded-full bg-foreground text-background hover:opacity-90 disabled:opacity-40"
                >
                  <ArrowUp className="size-4" />
                </button>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
