import { ArrowUp, CornerDownRight, ListEnd, Loader2, Paperclip, Square } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";

import { formatKeys } from "../../lib/keys";
import { hasOpenLayer } from "../../lib/layers";
import { slideNumber as slideNumberOf } from "../../lib/slideNumbers";
import { cn } from "../../lib/utils";
import { useApp } from "../../store";
import { lastSentText } from "../../store/messages";
import { EffortPicker, ModelPicker } from "../ModelPicker";
import { COMPOSER_INPUT_ATTR, PermissionPicker } from "../Permissions";
import { VoiceInput, type VoiceInputHandle } from "../VoiceInput";
import { ComposerChips } from "./ComposerChips";
import { ContextMeter } from "./ContextMeter";
import { appendDraft } from "./draft";
import { ImageFan, ImageGrid } from "./ImageAttachments";
import { InputResizeHandle } from "./InputResizeHandle";
import { fitInput, showCaret } from "./inputLayout";
import { QueuedMessages } from "./QueuedMessages";
import { useAttachments } from "./useAttachments";
import { useComposerDraft } from "./useComposerDraft";
import { useDictation } from "./useDictation";

/** The key that steers the agent with the composer's message. */
const STEER_KEY = formatKeys("mod+enter");
/** What the send button says it does, with the keys of the message input. */
export const SEND_TITLE = `Send (${formatKeys("enter")}) · New line (${formatKeys("shift+enter")})`;

/**
 * Where the user writes (or dictates) to the agent, with what goes along with the message: the
 * slide, attachments, the sketch and comments. Enter sends; while the agent works it queues, and
 * with the modifier it steers the turn. A message sent while an attachment is still being saved
 * waits for it. Escape in the empty input stops the agent's turn, and the up arrow brings back
 * the last message sent.
 *
 * The draft is its own (see `useComposerDraft`), so that a key pressed renders the composer and
 * nothing else of the chat. Of the deck, which changes with every save, it takes only what it
 * shows: the number of the selected slide.
 */
export function Composer() {
  const [draft, setDraft] = useComposerDraft();
  const workspacePath = useApp((s) => s.workspace?.path);
  const selected = useApp((s) => s.selected);
  const slideNumber = useApp((s) => slideNumberOf(s.deck, s.selected));
  const running = useApp((s) => s.running);
  const [includeSlide, setIncludeSlide] = useState(true);
  const attachments = useAttachments();
  const { images, screenshot, element } = attachments;
  const [gridOpen, setGridOpen] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [inputHeight, setInputHeight] = useState<number | null>(null);
  /** A message sent while attachments were being saved: it goes out once they are, if none failed. */
  const [held, setHeld] = useState<{ steer: boolean; failures: number } | null>(null);

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

  // The input is as tall as its text, or as the user made it. It doesn't have the focus while
  // dictating, so it doesn't follow the words coming in: the end of what was said is kept in view.
  // biome-ignore lint/correctness/useExhaustiveDependencies: follows the shown text
  useLayoutEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    fitInput(el, shownDraft, inputHeight);
    if (dictation.caret !== null) showCaret(el, dictation.caret);
  }, [shownDraft, inputHeight]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: refocus when the draft is sent or cleared
  useEffect(() => {
    textareaRef.current?.focus();
  }, [draft === ""]);

  // A prepared message (see `useAttachments` for what it brings along) is ready to send, and the
  // app can ask for the focus (see `focusComposer`).
  const composerFill = useApp((s) => s.composerFill);
  const composerFocus = useApp((s) => s.composerFocus);
  // biome-ignore lint/correctness/useExhaustiveDependencies: focuses each time a message is prepared or the focus is asked for
  useEffect(() => {
    textareaRef.current?.focus();
  }, [composerFill, composerFocus]);

  // The held message goes out once its attachments are saved; one that failed keeps it back.
  // biome-ignore lint/correctness/useExhaustiveDependencies: runs as the attachments settle
  useEffect(() => {
    if (!held || attachments.pending > 0) return;
    setHeld(null);
    if (attachments.failures === held.failures) send(draft, held.steer);
  }, [held, attachments.pending]);

  const submit = (steer = false) => {
    if (dictation.dictating || held || !draft.trim()) return;
    if (attachments.pending > 0) setHeld({ steer, failures: attachments.failures });
    else send(draft, steer);
  };

  /** Takes a queued message back into the composer, after what is there. */
  const editQueued = (id: string) => {
    const item = useApp.getState().takeQueued(id);
    if (!item) return;
    setDraft(appendDraft(draft, item.text));
    const { options } = item;
    attachments.add(options.attachments);
    if (options.screenshot) attachments.setScreenshot(options.screenshot);
    if (options.element) attachments.setElement(options.element);
    setIncludeSlide(options.includeSlide);
    textareaRef.current?.focus();
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      submit(e.metaKey || e.ctrlKey);
      return;
    }
    const plain = !e.shiftKey && !e.altKey && !e.metaKey && !e.ctrlKey && !e.nativeEvent.isComposing;
    if (!plain || draft !== "" || dictation.dictating) return;
    if (e.key === "Escape") {
      // What is open over the app (a menu, the dictation) takes the key first; see lib/layers.ts.
      if (hasOpenLayer() || !running) return;
      e.preventDefault();
      useApp.getState().interrupt();
    } else if (e.key === "ArrowUp") {
      const last = lastSentText(useApp.getState().messages);
      if (last === null) return;
      e.preventDefault();
      setDraft(last);
    }
  };

  const sendTitle = dictation.dictating
    ? "Stop and send"
    : held
      ? "Sends once the attachment is saved"
      : attachments.pending > 0
        ? "Send (waits for the attachment being saved)"
        : SEND_TITLE;

  return (
    <div className="mx-auto w-full max-w-3xl shrink-0 px-3 pb-3">
      <QueuedMessages onEdit={editQueued} />
      <div className="relative">
        {workspacePath &&
          images.length > 0 &&
          (gridOpen ? (
            <ImageGrid
              workspacePath={workspacePath}
              images={images}
              onRemove={(path) => {
                attachments.remove(path);
                if (images.length === 1) setGridOpen(false);
              }}
              onClose={() => setGridOpen(false)}
            />
          ) : (
            <ImageFan
              workspacePath={workspacePath}
              images={images}
              onOpen={() => setGridOpen(true)}
              onRemove={attachments.remove}
            />
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
            "relative z-10 flex flex-col rounded-2xl border bg-card shadow-composer transition-colors focus-within:border-ring/50",
            attachments.dragging && "border-primary ring-2 ring-primary/30",
          )}
        >
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
            pending={attachments.pending}
          />
          <textarea
            ref={textareaRef}
            {...{ [COMPOSER_INPUT_ATTR]: "" }}
            value={dictation.shownDraft}
            rows={1}
            readOnly={dictation.dictating}
            onChange={(e) => setDraft(e.target.value)}
            onPaste={attachments.onPaste}
            onKeyDown={onKeyDown}
            placeholder={
              dictation.dictating
                ? "Listening…"
                : running
                  ? `Queue a message, or ${STEER_KEY} to steer the agent now…`
                  : "Ask for slides or changes…"
            }
            className="block max-h-[max(64px,60vh)] min-h-16 w-full resize-none bg-transparent px-3.5 pt-3 text-sm leading-relaxed outline-none placeholder:text-muted-foreground/70"
          />
          {/* Drawn at the top, but after the input for the keyboard: Tab goes to the text first. */}
          <InputResizeHandle
            textarea={textareaRef}
            height={inputHeight}
            onResize={setInputHeight}
            className="order-first"
          />
          <div className="@container px-2 pt-2 pb-2">
            <div className="relative flex flex-nowrap items-center gap-1">
              {/* While dictating, the waveform that VoiceInput shows takes the place of the options. */}
              {!dictation.dictating && (
                <>
                  <ModelPicker />
                  <div className="mx-0.5 h-4 w-px shrink-0 bg-border" />
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
                    title={`Queue: send when the agent finishes (${formatKeys("enter")})`}
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
                  title={`Stop (${formatKeys("escape")} in the empty message box)`}
                  aria-label="Stop"
                  className="flex size-8 shrink-0 items-center justify-center rounded-full bg-foreground text-background hover:opacity-80"
                >
                  <Square className="size-3 fill-current" />
                </button>
              ) : (
                <button
                  type="button"
                  onClick={() => (dictation.dictating ? voiceInput.current?.finishAndSend() : submit())}
                  disabled={!dictation.dictating && (!draft.trim() || held !== null)}
                  title={sendTitle}
                  aria-label={dictation.dictating ? "Stop and send" : "Send"}
                  aria-busy={held !== null || undefined}
                  className="flex size-8 shrink-0 items-center justify-center rounded-full bg-foreground text-background hover:opacity-90 disabled:opacity-40"
                >
                  {held ? <Loader2 className="size-4 animate-spin" /> : <ArrowUp className="size-4" />}
                </button>
              )}
            </div>
          </div>
          {attachments.dragging && (
            <div
              data-testid="drop-overlay"
              className="pointer-events-none absolute inset-0 z-20 flex items-center justify-center gap-2 rounded-2xl bg-card/90 text-sm font-medium text-primary"
            >
              <Paperclip className="size-4" />
              Drop to attach
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
