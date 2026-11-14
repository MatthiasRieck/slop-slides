import { ArrowUp, CornerDownRight, ListEnd, Loader2, Paperclip, Pencil, Square, X } from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

import { formatKeys } from "../../lib/keys";
import { hasOpenLayer } from "../../lib/layers";
import { slideNumber as slideNumberOf } from "../../lib/slideNumbers";
import { cn } from "../../lib/utils";
import { useApp } from "../../store";
import { keepDraft, keptDraft } from "../../store/composer";
import { lastSentText } from "../../store/messages";
import { EffortPicker, ModelPicker } from "../ModelPicker";
import { COMPOSER_INPUT_ATTR, PermissionPicker } from "../Permissions";
import { VoiceInput, type VoiceInputHandle } from "../VoiceInput";
import { ComposerChips } from "./ComposerChips";
import { ContextMeter } from "./ContextMeter";
import { appendDraft } from "./draft";
import { ImageFan, ImageGrid } from "./ImageAttachments";
import { fitInput, showCaret } from "./inputLayout";
import { MentionMenu } from "./MentionMenu";
import { type Mention, type MentionItem, mentionAt, withoutMention } from "./mentions";
import { QueuedMessages } from "./QueuedMessages";
import { useAttachments } from "./useAttachments";
import { useComposerDraft } from "./useComposerDraft";
import { useDictation } from "./useDictation";

/** The key that steers the agent with the composer's message. */
const STEER_KEY = formatKeys("mod+enter");
/** What the send button says it does, with the keys of the message input. */
export const SEND_TITLE = `Send (${formatKeys("enter")}) · New line (${formatKeys("shift+enter")})`;

/** No slides: what the rail's picks are while it has one slide or none picked. */
const NONE: string[] = [];

/**
 * Where the user writes (or dictates) to the agent, with what goes along with the message: the
 * slide (or the slides picked in the rail), slides and files referred to with "@", attachments,
 * the sketch and comments. Enter sends; while the agent works it queues, and with the modifier it
 * steers the turn. A message sent while an attachment is still being saved waits for it. Escape
 * in the empty input stops the agent's turn, and the up arrow brings back the last message sent.
 * A sent message handed back to be edited (see `UserBubble`) is sent in its own place.
 *
 * The draft is its own (see `useComposerDraft`), so that a key pressed renders the composer and
 * nothing else of the chat. Of the deck, which changes with every save, it takes only what it
 * shows: the number of the selected slide. What is being written stays with its chat when another
 * is shown, and is there again on coming back (see `keepDraft`).
 */
export function Composer() {
  const chatKey = useApp((s) => s.chatKey);
  // What was being written in this chat when it was last on show, read once as the composer starts.
  const [kept] = useState(() => keptDraft(useApp.getState().chatKey));
  const { draft, setDraft, editing, cancelEdit, endEdit } = useComposerDraft(kept?.text ?? "");
  const workspacePath = useApp((s) => s.workspace?.path);
  const selected = useApp((s) => s.selected);
  const slideNumber = useApp((s) => slideNumberOf(s.deck, s.selected));
  const running = useApp((s) => s.running);
  const stopping = useApp((s) => s.stopping);
  // The other slides picked in the rail beside the selected one, which go along with it.
  const picked = useApp((s) => (s.railSelected.length > 1 ? s.railSelected : NONE));
  const [includeSlide, setIncludeSlide] = useState(kept?.includeSlide ?? true);
  /** The slides referred to with "@", by id. */
  const [mentioned, setMentioned] = useState<string[]>(kept?.slides ?? []);
  const attachments = useAttachments(kept);
  const { images, screenshot, element } = attachments;
  const [gridOpen, setGridOpen] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  /** A message sent while attachments were being saved: it goes out once they are, if none failed. */
  const [held, setHeld] = useState<{ steer: boolean; failures: number } | null>(null);
  /** The "@" being typed at the caret, while its menu is open. */
  const [mention, setMention] = useState<Mention | null>(null);
  const [mentionActive, setMentionActive] = useState(0);
  const mentionItems = useRef<MentionItem[]>([]);
  const onMentionItems = useCallback((items: MentionItem[]) => {
    mentionItems.current = items;
    setMentionActive((at) => Math.min(at, Math.max(0, items.length - 1)));
  }, []);

  // What is written here goes with this chat when another is shown (or the app goes on without
  // the chat), to be there again when it is back. The chat the composer is for is the one it was
  // last shown with: the folder's chat that becomes its deck's stays the same conversation.
  // Kept as it changes, not as the composer goes: the composer of the chat shown next starts
  // before this one is gone.
  useEffect(() => {
    if (!chatKey) return;
    keepDraft(chatKey, {
      text: draft,
      attachments: attachments.attachments,
      unsent: attachments.unsent,
      screenshot: attachments.screenshot,
      element: attachments.element,
      includeSlide,
      slides: mentioned,
    });
  }, [
    chatKey,
    draft,
    includeSlide,
    mentioned,
    attachments.attachments,
    attachments.unsent,
    attachments.screenshot,
    attachments.element,
  ]);

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
    const withSlide = includeSlide && slideNumber > 0;
    const slides = [...(withSlide ? picked.filter((id) => id !== selected) : []), ...mentioned];
    const options = {
      includeSlide: withSlide,
      attachments: attachments.attachments,
      ...(slides.length > 0 && { slides }),
      ...(screenshot && { screenshot }),
      ...(element && { element }),
    };
    const app = useApp.getState();
    if (editing) void app.editMessage(editing.id, text, options);
    else void (steer && running ? app.steer(text, options) : app.send(text, options));
    endEdit();
    setDraft("");
    setMentioned([]);
    attachments.clear();
    setGridOpen(false);
  };

  const dictation = useDictation({ draft, setDraft, textarea: textareaRef, send });
  const voiceInput = useRef<VoiceInputHandle>(null);
  const shownDraft = dictation.shownDraft;

  // The input is as tall as its text, up to a point, then its text scrolls. It doesn't have the
  // focus while dictating, so it doesn't follow the words coming in: the end of what was said is
  // kept in view.
  // biome-ignore lint/correctness/useExhaustiveDependencies: follows the shown text
  useLayoutEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    fitInput(el, shownDraft);
    if (dictation.caret !== null) showCaret(el, dictation.caret);
  }, [shownDraft]);

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
  // A prepared message may say which slides go along with it, as a sent message being edited does.
  useEffect(() => {
    if (!composerFill) return;
    if (composerFill.includeSlide !== undefined) setIncludeSlide(composerFill.includeSlide);
    if (composerFill.edit) setMentioned(composerFill.slides ?? []);
    else if (composerFill.slides) setMentioned((was) => [...new Set([...was, ...(composerFill.slides ?? [])])]);
  }, [composerFill]);

  // The held message goes out once its attachments are saved; one that failed keeps it back.
  // biome-ignore lint/correctness/useExhaustiveDependencies: runs as the attachments settle
  useEffect(() => {
    if (!held || attachments.pending > 0) return;
    setHeld(null);
    if (attachments.failures === held.failures) send(draft, held.steer);
  }, [held, attachments.pending]);

  const submit = (steer = false) => {
    // An edited message takes the place of one the running turn may still be answering.
    if (dictation.dictating || held || !draft.trim() || (editing && running)) return;
    if (attachments.pending > 0) setHeld({ steer, failures: attachments.failures });
    else send(draft, steer);
  };

  /** Gives up editing a sent message: what was written and attached before comes back. */
  const giveUpEdit = () => {
    cancelEdit();
    attachments.restore();
    setMentioned(kept?.slides ?? []);
    textareaRef.current?.focus();
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
    if (options.slides) setMentioned((was) => [...new Set([...was, ...(options.slides ?? [])])]);
    setIncludeSlide(options.includeSlide);
    textareaRef.current?.focus();
  };

  /** Follows the caret for an "@" being typed, which opens the menu of slides and files. */
  const followMention = (input: HTMLTextAreaElement) => {
    const found = input.selectionStart === input.selectionEnd ? mentionAt(input.value, input.selectionStart) : null;
    setMention((was) => (found?.start === was?.start && found?.query === was?.query ? was : found));
    if (found?.query !== mention?.query) setMentionActive(0);
  };

  /** Refers to what was picked in the "@" menu: a slide as a chip, a file as an attachment. */
  const pickMention = (item: MentionItem) => {
    const input = textareaRef.current;
    if (!mention || !input) return;
    const caret = input.selectionStart;
    const next = withoutMention(draft, mention, caret);
    setDraft(next.text);
    setMention(null);
    if (item.kind === "slide") {
      // The slide on show already goes along with its own chip.
      if (!(includeSlide && item.id === selected))
        setMentioned((was) => (was.includes(item.id) ? was : [...was, item.id]));
    } else {
      attachments.add([item.path]);
    }
    requestAnimationFrame(() => {
      input.focus();
      input.setSelectionRange(next.caret, next.caret);
    });
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (mention && !e.nativeEvent.isComposing) {
      const items = mentionItems.current;
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        const step = e.key === "ArrowDown" ? 1 : -1;
        setMentionActive((at) => (items.length === 0 ? 0 : (at + step + items.length) % items.length));
        return;
      }
      if ((e.key === "Enter" || e.key === "Tab") && !e.shiftKey && items[mentionActive]) {
        e.preventDefault();
        pickMention(items[mentionActive]!);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        setMention(null);
        return;
      }
    }
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      submit(e.metaKey || e.ctrlKey);
      return;
    }
    if (e.key === "Escape" && editing && !hasOpenLayer()) {
      e.preventDefault();
      giveUpEdit();
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
        : editing
          ? running
            ? "Send the edited message once the agent finishes"
            : `Send the edited message (${formatKeys("enter")})`
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
        {mention && (
          <MentionMenu
            query={mention.query}
            active={mentionActive}
            onItems={onMentionItems}
            onPick={pickMention}
            onHover={setMentionActive}
          />
        )}
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
            editing && "border-primary/50",
          )}
        >
          {editing && (
            <div className="flex items-center gap-1.5 px-3.5 pt-2.5 text-xs text-primary">
              <Pencil className="size-3 shrink-0" />
              <span className="min-w-0 flex-1 truncate">
                {running ? "Editing your message: send it once the agent finishes" : "Editing your message"}
              </span>
              <button
                type="button"
                onClick={giveUpEdit}
                title={`Keep the message as it was (${formatKeys("escape")})`}
                className="flex items-center gap-1 rounded px-1 text-muted-foreground hover:text-foreground"
              >
                <X className="size-3" />
                Cancel
              </button>
            </div>
          )}
          <ComposerChips
            slideNumber={slideNumber}
            picked={picked}
            includeSlide={includeSlide}
            onToggleSlide={() => setIncludeSlide((v) => !v)}
            mentioned={mentioned}
            onDropMentioned={(id) => setMentioned((was) => was.filter((m) => m !== id))}
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
            onChange={(e) => {
              setDraft(e.target.value);
              followMention(e.target);
            }}
            onSelect={(e) => followMention(e.currentTarget)}
            onBlur={() => setMention(null)}
            onPaste={attachments.onPaste}
            onKeyDown={onKeyDown}
            aria-label="Message"
            aria-controls={mention ? "composer-mentions" : undefined}
            aria-activedescendant={mention ? `composer-mention-${mentionActive}` : undefined}
            aria-autocomplete="list"
            placeholder={
              dictation.dictating
                ? "Listening…"
                : running
                  ? `Queue a message, or ${STEER_KEY} to steer the agent now…`
                  : "Ask for changes… @ to name a slide or file"
            }
            className="block max-h-[max(64px,60vh)] min-h-16 w-full resize-none bg-transparent px-3.5 pt-3 text-sm leading-relaxed outline-none placeholder:text-muted-foreground/70"
          />
          <div className="@container px-2 pt-2 pb-2">
            <div className="relative flex flex-nowrap items-center gap-0.5">
              {/* While dictating, the waveform that VoiceInput shows takes the place of the options. */}
              {!dictation.dictating && (
                <>
                  <ModelPicker />
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
                  aria-label="Attach images or files"
                  className="flex size-8 shrink-0 items-center justify-center rounded-full text-muted-foreground hover:bg-accent hover:text-foreground"
                >
                  <Paperclip className="size-4" />
                </button>
              )}
              {running && !dictation.dictating && draft.trim() && !editing && (
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
                  disabled={stopping}
                  title={stopping ? "Stopping…" : `Stop (${formatKeys("escape")} in the empty message box)`}
                  aria-label={stopping ? "Stopping" : "Stop"}
                  aria-busy={stopping || undefined}
                  className="flex size-8 shrink-0 items-center justify-center rounded-full bg-foreground text-background hover:opacity-80 disabled:opacity-60"
                >
                  {stopping ? <Loader2 className="size-4 animate-spin" /> : <Square className="size-3 fill-current" />}
                </button>
              ) : (
                <button
                  type="button"
                  onClick={() => (dictation.dictating ? voiceInput.current?.finishAndSend() : submit())}
                  disabled={!dictation.dictating && (!draft.trim() || held !== null || (!!editing && running))}
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
