import { ArrowUp, CornerDownRight, ListEnd, Paperclip, PowerOff, Settings, Square } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupTextarea } from "@/components/ui/input-group";
import { Kbd } from "@/components/ui/kbd";
import { Separator } from "@/components/ui/separator";
import { Spinner } from "@/components/ui/spinner";
import { formatKeys } from "../../lib/keys";
import { hasOpenLayer } from "../../lib/layers";
import { PROVIDERS } from "../../lib/models";
import { slideNumber as slideNumberOf } from "../../lib/slideNumbers";
import { cn } from "../../lib/utils";
import { openSettings, turnedOffProvider, useApp } from "../../store";
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
const SEND_TIP = (
  <>
    Send <Kbd>{formatKeys("enter")}</Kbd> · New line <Kbd>{formatKeys("shift+enter")}</Kbd>
  </>
);

/**
 * Where the user writes (or dictates) to the agent, with what goes along with the message: the
 * slide, attachments, the sketch and comments. Enter sends; while the agent works it queues, and
 * with the modifier it steers the turn. A chat whose provider the settings have turned off takes
 * no message: the composer says so, with the way to the settings, and sends nothing. A message sent while an attachment is still being saved
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
  /** The provider this chat's next message would go to, when it is turned off: nothing can be sent. */
  const turnedOff = useApp(turnedOffProvider);
  const [includeSlide, setIncludeSlide] = useState(true);
  const attachments = useAttachments();
  const { images, screenshot, element } = attachments;
  const [gridOpen, setGridOpen] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  /** What the composer stands in, which the grid of attached images opens over. */
  const surface = useRef<HTMLDivElement>(null);
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
    // Unsent, the draft stays for when the provider is back on.
    if (!text || turnedOff) return;
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
    if (turnedOff || dictation.dictating || held || !draft.trim()) return;
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

  const sendTip = turnedOff
    ? `${PROVIDERS[turnedOff].cli} is turned off.`
    : dictation.dictating
      ? "Stop and send"
      : held
        ? "Sends once the attachment is saved"
        : attachments.pending > 0
          ? "Send (waits for the attachment being saved)"
          : SEND_TIP;

  return (
    <div className="mx-auto w-full max-w-3xl shrink-0 px-3 pb-3">
      <QueuedMessages onEdit={editQueued} />
      <div ref={surface} className="relative">
        {workspacePath &&
          images.length > 0 &&
          (gridOpen ? (
            <ImageGrid
              anchor={surface}
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
        {/* A press on the composer's own padding puts the keyboard in the message input. */}
        <InputGroup
          data-testid="composer"
          onClick={(e) => {
            if (e.target === e.currentTarget) textareaRef.current?.focus();
          }}
          className={cn(
            "relative z-10 h-auto flex-col items-stretch rounded-2xl bg-card shadow-composer dark:bg-card",
            attachments.dragging && "border-primary ring-2 ring-primary/30",
          )}
        >
          {turnedOff && (
            <InputGroupAddon
              align="block-start"
              role="status"
              data-testid="provider-turned-off"
              className="order-none cursor-default border-b px-3.5 py-2 text-xs font-normal"
            >
              <PowerOff aria-hidden="true" className="size-3.5 shrink-0" />
              <span className="min-w-0 flex-1">{PROVIDERS[turnedOff].cli} is turned off.</span>
              <Button variant="outline" size="xs" onClick={() => openSettings("providers")} className="shrink-0">
                <Settings data-icon="inline-start" />
                Open Providers
              </Button>
            </InputGroupAddon>
          )}
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
          <InputGroupTextarea
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
            // Its height is set by hand (see `fitInput`): it neither sizes itself nor takes the room left over.
            className="block max-h-[max(64px,60vh)] min-h-16 flex-none px-3.5 pt-3 pb-0 leading-relaxed placeholder:text-muted-foreground/70"
          />
          {/* Drawn at the top, but after the input for the keyboard: Tab goes to the text first. */}
          <InputResizeHandle
            textarea={textareaRef}
            height={inputHeight}
            onResize={setInputHeight}
            className="order-first"
          />
          <InputGroupAddon
            align="block-end"
            onClick={(e) => {
              if (e.target === e.currentTarget) textareaRef.current?.focus();
            }}
            className="@container block px-2 pt-2 pb-2"
          >
            <div className="relative flex flex-nowrap items-center gap-1">
              {/* While dictating, the waveform that VoiceInput shows takes the place of the options. */}
              {!dictation.dictating && (
                <>
                  <ModelPicker />
                  <Separator orientation="vertical" className="mx-0.5 data-vertical:h-4 data-vertical:self-center" />
                  <EffortPicker />
                  <PermissionPicker />
                  <div className="min-w-0 flex-1" />
                </>
              )}
              <VoiceInput ref={voiceInput} {...dictation.handlers} />
              {!dictation.dictating && (
                <InputGroupButton
                  size="icon-sm"
                  onClick={attachments.pickFiles}
                  aria-label="Attach images or files"
                  tooltip="Attach images or files"
                  className="shrink-0 rounded-full text-muted-foreground"
                >
                  <Paperclip />
                </InputGroupButton>
              )}
              {running && !dictation.dictating && draft.trim() && (
                <>
                  <InputGroupButton
                    size="icon-sm"
                    onClick={() => submit(true)}
                    aria-label="Steer"
                    tooltip="Steer: send into the agent's turn now"
                    shortcut="mod+enter"
                    className="shrink-0 rounded-full text-muted-foreground"
                  >
                    <CornerDownRight />
                  </InputGroupButton>
                  <InputGroupButton
                    size="icon-sm"
                    onClick={() => submit()}
                    aria-label="Queue"
                    tooltip="Queue: send when the agent finishes"
                    shortcut="enter"
                    className="shrink-0 rounded-full text-muted-foreground"
                  >
                    <ListEnd />
                  </InputGroupButton>
                </>
              )}
              {running ? (
                <InputGroupButton
                  variant="default"
                  size="icon-sm"
                  onClick={() => useApp.getState().interrupt()}
                  aria-label="Stop"
                  tooltip={
                    <>
                      Stop <Kbd>{formatKeys("escape")}</Kbd> in the empty message box
                    </>
                  }
                  className="shrink-0 rounded-full"
                >
                  <Square className="size-3 fill-current" />
                </InputGroupButton>
              ) : (
                <InputGroupButton
                  variant="default"
                  size="icon-sm"
                  onClick={() => (dictation.dictating ? voiceInput.current?.finishAndSend() : submit())}
                  disabled={turnedOff !== null || (!dictation.dictating && (!draft.trim() || held !== null))}
                  aria-label={dictation.dictating ? "Stop and send" : "Send"}
                  aria-busy={held !== null || undefined}
                  tooltip={sendTip}
                  className="shrink-0 rounded-full"
                >
                  {held ? <Spinner aria-hidden="true" /> : <ArrowUp />}
                </InputGroupButton>
              )}
            </div>
          </InputGroupAddon>
          {attachments.dragging && (
            <div
              data-testid="drop-overlay"
              className="pointer-events-none absolute inset-0 z-20 flex items-center justify-center gap-2 rounded-2xl bg-card/90 text-sm font-medium text-primary"
            >
              <Paperclip className="size-4" />
              Drop to attach
            </div>
          )}
        </InputGroup>
      </div>
    </div>
  );
}
