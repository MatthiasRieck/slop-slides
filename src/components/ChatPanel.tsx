import { AlertTriangle, MessageSquareText, RotateCw, Settings, SquarePen } from "lucide-react";
import { Activity, useEffect, useState } from "react";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia } from "@/components/ui/empty";
import { Spinner } from "@/components/ui/spinner";
import { PROVIDERS, type Provider } from "../lib/models";
import { cn } from "../lib/utils";
import { chatProvider, openSettings, useApp } from "../store";
import { Composer } from "./chat/Composer";
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

/** The start of a chat, the same element each time: given it, the conversation has nothing new to render. */
const EMPTY_CHAT = <EmptyChat />;

/**
 * The chat with the agent, which stays as it is while the sidebar shows another tab (`active`
 * is off): the conversation where it was scrolled to, its tool calls unfolded, the draft and
 * what goes along with it. Out of view it does nothing at all: it follows neither the agent nor
 * the deck, counts no seconds, and listens for nothing (no files dropped on the window, no
 * microphone), until it is shown again and catches up.
 */
export function ChatPanel({ active = true }: { active?: boolean }) {
  return (
    <Activity mode={active ? "visible" : "hidden"}>
      <Chat />
    </Activity>
  );
}

/**
 * The chat's header, the conversation and the composer. The draft belongs to the conversation:
 * it starts empty in another one, and stays when the folder's chat becomes the chat of the deck
 * it made (the same conversation under another key). A new chat keeps it too: what is being
 * written is for the chat about to start.
 *
 * It knows of the conversation only whether there is one yet: the messages are the list's to
 * take, and the draft the composer's, so neither a key pressed nor an event of the agent's
 * renders it.
 */
function Chat() {
  const empty = useApp((s) => s.messages.length === 0);
  const provider = useApp((s) => s.selection.provider);
  const cliMissing = useApp((s) => s.providers?.find((p) => p.id === s.selection.provider)?.installed === false);
  // Goes up with every other conversation shown (see `loadChat`), not when the chat follows its deck.
  const revision = useApp((s) => s.chatRevision);
  // Goes up with it, but for a new chat, which keeps the composer and what is written in it.
  const composerRevision = useApp((s) => s.composerRevision);
  const [switching, setSwitching] = useState(false);

  return (
    <div className="flex h-full flex-col bg-background">
      <ThreadNavigation switching={switching} setSwitching={setSwitching} />
      <div
        className={cn("flex min-h-0 flex-1 flex-col transition-opacity duration-150", switching && "opacity-50")}
        inert={switching}
        aria-busy={switching || undefined}
      >
        {cliMissing && <MissingCli provider={provider} />}
        <MessageList key={revision}>{empty ? EMPTY_CHAT : null}</MessageList>
        <Composer key={`composer-${composerRevision}`} />
      </div>
    </div>
  );
}

/**
 * Says that the selected agent's CLI is not installed, with what to do about it: the command to
 * copy, a button that looks again (as does coming back to the window, say from a terminal), one
 * that opens the settings on the providers, where each agent's state is told in full, and the
 * way to another agent, which for a chat that belongs to this one is a new chat.
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
    <Alert className="mx-3 mt-2 mb-2 w-auto shrink-0 border-warning/30 bg-warning/10 text-xs text-warning">
      <AlertTriangle className="size-3.5" />
      <AlertTitle>{cli} is not installed.</AlertTitle>
      <AlertDescription className="flex min-w-0 flex-col gap-2 text-xs leading-relaxed text-warning">
        <p>
          <InstallHint text={install} />
        </p>
        <p>{locked ? "Start a new chat to use another agent." : "Or pick another model below."}</p>
        <div className="flex flex-wrap gap-1.5 text-foreground">
          <Button
            variant="outline"
            size="xs"
            disabled={checking}
            aria-busy={checking || undefined}
            onClick={() => void check()}
          >
            {checking ? <Spinner aria-hidden="true" data-icon="inline-start" /> : <RotateCw data-icon="inline-start" />}
            Check again
          </Button>
          <Button variant="outline" size="xs" onClick={() => openSettings("providers")}>
            <Settings data-icon="inline-start" />
            Open Providers
          </Button>
          {locked && (
            <Button
              variant="outline"
              size="xs"
              disabled={running}
              tooltip={running ? "Stop the current turn to start a new chat" : "New chat (files are kept)"}
              onClick={() => void useApp.getState().resetChat()}
            >
              <SquarePen data-icon="inline-start" />
              New chat
            </Button>
          )}
        </div>
      </AlertDescription>
    </Alert>
  );
}

/**
 * The start of a chat: what the agent can be asked, and requests to start from. Picking one puts
 * it in the composer, to be changed or sent.
 */
function EmptyChat() {
  const deckEmpty = useApp((s) => (s.deck?.slides.length ?? 0) === 0);
  const onSlide = useApp((s) => !!s.deck && !!s.selected);
  const suggestions = deckEmpty ? STARTERS : [...(onSlide ? [SLIDE_REQUEST] : []), ...DECK_REQUESTS];
  return (
    <Empty className="justify-start gap-3 px-1 pt-6 pb-0">
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <MessageSquareText />
        </EmptyMedia>
        <EmptyDescription>
          {deckEmpty
            ? "Ask the agent to create a presentation or work with files in this workspace."
            : "Ask for changes to the current slide or the whole deck."}
        </EmptyDescription>
      </EmptyHeader>
      <EmptyContent className="gap-1.5">
        {suggestions.map((text) => (
          <Button
            key={text}
            variant="outline"
            tooltip="Put this in the message box"
            onClick={() => useApp.getState().fillComposer(text)}
            className="h-auto w-full justify-start px-3 py-2 text-left text-xs leading-relaxed font-normal whitespace-normal text-muted-foreground"
          >
            {text}
          </Button>
        ))}
      </EmptyContent>
    </Empty>
  );
}
