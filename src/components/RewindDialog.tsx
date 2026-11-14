import { useState } from "react";
import { type RewindChoice, useApp } from "../store";
import { Button } from "./Button";
import { Dialog } from "./Dialog";

/**
 * Asks, once the deck changes of an agent turn were undone, what becomes of the chat: it goes
 * back to before the turn's message too (the message returns to the composer), or it stays, with
 * the agent told of the undo when the next message goes out. Each answer is a button that says
 * what it does; closing the dialog leaves the chat alone, the agent none the wiser.
 */
export function RewindDialog() {
  const entry = useApp((s) => s.rewindAsk);
  // Looked for only while the question is asked: the messages change with every event of the agent's.
  const message = useApp((s) => {
    const asked = s.rewindAsk;
    return asked ? s.messages.find((m) => m.id === asked.message) : undefined;
  });
  const [remember, setRemember] = useState(false);
  if (!entry || message?.role !== "user") return null;
  const answer = (picked: RewindChoice | null) => {
    void useApp.getState().answerRewind(picked, remember);
    setRemember(false);
  };
  return (
    <Dialog
      label="Undo chat changes"
      onClose={() => answer(null)}
      className="flex w-[28rem] max-w-[90vw] flex-col gap-4 rounded-xl border bg-background p-5 text-foreground shadow-2xl outline-none"
      heading={
        <>
          <h2 className="text-base font-semibold">You undid the agent's changes. What about the chat?</h2>
          <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">
            The deck is back to how it was before your message “{entry.label}”.
          </p>
        </>
      }
    >
      <div className="flex flex-col gap-2">
        <Choice
          primary
          label="Rewind the chat too"
          detail="The chat goes back to before this message, which returns to the message box. The agent forgets the turn."
          onClick={() => answer("rewind")}
        />
        <Choice
          label="Keep the chat, tell the agent"
          detail="The chat stays as it is. Your next message tells the agent that its changes were undone."
          onClick={() => answer("deck")}
        />
      </div>
      <label className="flex items-start gap-2 text-xs text-muted-foreground">
        <input type="checkbox" className="mt-0.5" checked={remember} onChange={(e) => setRemember(e.target.checked)} />
        <span>
          Don't ask again: always do what I pick here.
          <span className="block">You can change this in the app settings.</span>
        </span>
      </label>
      <div className="flex items-center justify-between gap-3 border-t pt-3">
        <p className="text-xs text-muted-foreground">
          Or leave the chat as it is, without telling the agent; it may not know its changes are gone.
        </p>
        <Button variant="ghost" size="xl" className="shrink-0" onClick={() => answer(null)}>
          Do nothing
        </Button>
      </div>
    </Dialog>
  );
}

/** One of the dialog's answers: a button with what it does written under its name. */
function Choice(props: { label: string; detail: string; primary?: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      data-autofocus={props.primary || undefined}
      onClick={props.onClick}
      className={
        props.primary
          ? "flex flex-col gap-0.5 rounded-lg bg-primary p-3 text-left text-primary-foreground hover:opacity-90"
          : "flex flex-col gap-0.5 rounded-lg border p-3 text-left hover:bg-accent"
      }
    >
      <span className="text-sm font-medium">{props.label}</span>
      <span className={props.primary ? "text-xs opacity-90" : "text-xs text-muted-foreground"}>{props.detail}</span>
    </button>
  );
}
