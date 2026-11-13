import { AlertTriangle, RotateCw, SquarePen } from "lucide-react";
import { useEffect, useState } from "react";

import { PROVIDERS, type Provider } from "../lib/models";
import { cn } from "../lib/utils";
import { chatProvider, useApp } from "../store";
import { Button } from "./Button";
import { Composer } from "./chat/Composer";
import { appendDraft } from "./chat/draft";
import { InstallHint } from "./chat/InstallHint";
import { MessageList } from "./chat/MessageList";
import { ThreadNavigation } from "./chat/ThreadNavigation";

/** What to ask for with nothing made yet. */
const STARTERS = [
  "A 6-slide pitch for a neighborhood tool-sharing app, bold and warm",
  "Teach the basics of compound interest to teenagers in 8 slides",
  "Quarterly engineering update: shipped, in progress, risks, asks",
];

/** What to ask about a deck that has slides; the first is about the slide on show. */
const SLIDE_REQUEST = "Tighten the text on this slide: fewer words, same message.";
const DECK_REQUESTS = [
  "Add speaker notes to every slide that has none.",
  "Make the deck consistent: the same fonts, colors, spacing and heading style on every slide.",
  "Review the flow of the deck and tell me what to cut, add or reorder.",
];

/**
 * The chat with the agent: its header, the conversation and the composer. The draft belongs to
 * the conversation: it starts empty in another one, and stays when the folder's chat becomes the
 * chat of the deck it made (the same conversation under another key).
 */
export function ChatPanel() {
  const messages = useApp((s) => s.messages);
  const running = useApp((s) => s.running);
  const provider = useApp((s) => s.selection.provider);
  const cliMissing = useApp((s) => s.providers?.find((p) => p.id === s.selection.provider)?.installed === false);
  const deckEmpty = useApp((s) => (s.deck?.slides.length ?? 0) === 0);
  const onSlide = useApp((s) => !!s.deck && !!s.selected);
  const composerFill = useApp((s) => s.composerFill);
  const [draft, setDraft] = useState("");
  // Goes up with every other conversation shown (see `loadChat`), not when the chat follows its deck.
  const revision = useApp((s) => s.chatRevision);
  const [switching, setSwitching] = useState(false);
  // biome-ignore lint/correctness/useExhaustiveDependencies: each conversation starts with its own empty draft
  useEffect(() => {
    setDraft("");
  }, [revision]);

  // Other parts of the app (e.g. the lint status) can hand the composer a prepared message,
  // which goes after what is typed already. Taken, it is the composer's: it does not come again
  // when the chat is shown the next time.
  useEffect(() => {
    if (!composerFill) return;
    if (composerFill.text) setDraft((typed) => appendDraft(typed, composerFill.text));
    useApp.getState().clearComposerFill();
  }, [composerFill]);

  return (
    <div className="flex h-full flex-col bg-background">
      <ThreadNavigation switching={switching} setSwitching={setSwitching} />
      <div
        className={cn("flex min-h-0 flex-1 flex-col transition-opacity", switching && "opacity-50")}
        inert={switching}
        aria-busy={switching || undefined}
      >
        {cliMissing && <MissingCli provider={provider} />}
        <MessageList key={revision} messages={messages} running={running}>
          {messages.length === 0 && (
            <EmptyChat
              deckEmpty={deckEmpty}
              onSlide={onSlide}
              onPick={(text) => useApp.getState().fillComposer(text)}
            />
          )}
        </MessageList>
        <Composer key={`composer-${revision}`} draft={draft} setDraft={setDraft} />
      </div>
    </div>
  );
}

/**
 * Says that the selected agent's CLI is not installed, with what to do about it: the command to
 * copy, a button that looks again (as does coming back to the window, say from a terminal), and
 * the way to another agent, which for a chat that belongs to this one is a new chat.
 */
function MissingCli({ provider }: { provider: Provider }) {
  const { cli, install } = PROVIDERS[provider];
  const locked = useApp((s) => chatProvider(s) === provider);
  const running = useApp((s) => s.running);
  const [checking, setChecking] = useState(false);
  const check = async () => {
    setChecking(true);
    await useApp.getState().refreshProviders({ quiet: true });
    setChecking(false);
  };
  useEffect(() => {
    const onFocus = () => void useApp.getState().refreshProviders({ quiet: true });
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, []);
  return (
    <div
      role="alert"
      className="mx-3 mt-2 mb-2 flex gap-2 rounded-lg border border-warning/30 bg-warning/10 p-2.5 text-xs leading-relaxed text-warning"
    >
      <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
      <div className="flex min-w-0 flex-col gap-2">
        <p>
          <span className="font-medium">{cli} is not installed.</span> <InstallHint text={install} />
        </p>
        <p>{locked ? "Start a new chat to use another agent." : "Or pick another model below."}</p>
        <div className="flex flex-wrap gap-1.5 text-foreground">
          <Button busy={checking} onClick={() => void check()} className="bg-background">
            {!checking && <RotateCw />}
            Check again
          </Button>
          {locked && (
            <Button
              disabled={running}
              title={running ? "Stop the current turn to start a new chat" : "New chat (files are kept)"}
              onClick={() => void useApp.getState().resetChat()}
              className="bg-background"
            >
              <SquarePen />
              New chat
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * The start of a chat: what the agent can be asked, and requests to start from. Picking one puts
 * it in the composer, to be changed or sent.
 */
function EmptyChat(props: { deckEmpty: boolean; onSlide: boolean; onPick: (text: string) => void }) {
  const { deckEmpty, onSlide, onPick } = props;
  const suggestions = deckEmpty ? STARTERS : [...(onSlide ? [SLIDE_REQUEST] : []), ...DECK_REQUESTS];
  return (
    <div className="flex flex-col gap-3 px-1 pt-6">
      <p className="text-sm text-muted-foreground">
        {deckEmpty
          ? "Ask the agent to create a presentation or work with files in this workspace."
          : "Ask for changes to the current slide or the whole deck."}
      </p>
      <div className="flex flex-col gap-1.5">
        {suggestions.map((text) => (
          <button
            key={text}
            type="button"
            title="Put this in the message box"
            onClick={() => onPick(text)}
            className="rounded-lg border px-3 py-2 text-left text-xs leading-relaxed text-muted-foreground hover:bg-accent hover:text-foreground"
          >
            {text}
          </button>
        ))}
      </div>
    </div>
  );
}
