import { AlertTriangle } from "lucide-react";
import { useEffect, useState } from "react";

import { PROVIDERS, type Provider } from "../lib/models";
import { useApp } from "../store";
import { Composer } from "./chat/Composer";
import { MessageList } from "./chat/MessageList";
import { ThreadNavigation } from "./chat/ThreadNavigation";

const SUGGESTIONS = [
  "A 6-slide pitch for a neighborhood tool-sharing app, bold and warm",
  "Teach the basics of compound interest to teenagers in 8 slides",
  "Quarterly engineering update: shipped, in progress, risks, asks",
];

export function ChatPanel() {
  const messages = useApp((s) => s.messages);
  const running = useApp((s) => s.running);
  const provider = useApp((s) => s.selection.provider);
  const cliMissing = useApp((s) => s.providers?.find((p) => p.id === s.selection.provider)?.installed === false);
  const deckEmpty = useApp((s) => (s.deck?.slides.length ?? 0) === 0);
  const composerFill = useApp((s) => s.composerFill);
  const [draft, setDraft] = useState("");
  const revision = useApp((s) => s.chatRevision);
  const workspacePath = useApp((s) => s.workspace?.path);
  const [switching, setSwitching] = useState(false);
  // biome-ignore lint/correctness/useExhaustiveDependencies: each conversation starts with its own empty draft
  useEffect(() => {
    setDraft("");
  }, [revision, workspacePath]);

  // Other parts of the app (e.g. the lint status) can hand the composer a prepared message.
  useEffect(() => {
    if (composerFill?.text) setDraft(composerFill.text);
  }, [composerFill]);

  return (
    <div className="flex h-full flex-col bg-background">
      <ThreadNavigation switching={switching} setSwitching={setSwitching} />
      <div className="flex min-h-0 flex-1 flex-col" inert={switching}>
        {cliMissing && <MissingCli provider={provider} />}
        <MessageList key={`${workspacePath}-${revision}`} messages={messages} running={running}>
          {messages.length === 0 && <EmptyChat deckEmpty={deckEmpty} onPick={(text) => setDraft(text)} />}
        </MessageList>
        <Composer key={`composer-${workspacePath}-${revision}`} draft={draft} setDraft={setDraft} />
      </div>
    </div>
  );
}
function MissingCli({ provider }: { provider: Provider }) {
  const { cli, install } = PROVIDERS[provider];
  return (
    <div className="mx-3 mb-2 flex gap-2 rounded-lg border border-warning/30 bg-warning/10 p-2.5 text-xs leading-relaxed text-warning ">
      <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
      <span>
        {cli} is not installed. {install} Or pick another model below.
      </span>
    </div>
  );
}

function EmptyChat({ deckEmpty, onPick }: { deckEmpty: boolean; onPick: (text: string) => void }) {
  return (
    <div className="flex flex-col gap-3 px-1 pt-6">
      <p className="text-sm text-muted-foreground">
        {deckEmpty
          ? "Ask the agent to create a presentation or work with files in this workspace."
          : "Ask for changes to the current slide or the whole deck."}
      </p>
      {deckEmpty && (
        <div className="flex flex-col gap-1.5">
          {SUGGESTIONS.map((text) => (
            <button
              key={text}
              type="button"
              onClick={() => onPick(text)}
              className="rounded-lg border px-3 py-2 text-left text-xs leading-relaxed text-muted-foreground hover:bg-accent hover:text-foreground"
            >
              {text}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
