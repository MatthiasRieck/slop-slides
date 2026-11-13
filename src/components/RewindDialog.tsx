import { useState } from "react";
import { type RewindChoice, useApp } from "../store";
import { Button } from "./Button";
import { Dialog } from "./Dialog";

/**
 * Asks, once the deck changes of an agent turn were undone, whether the chat goes back to before
 * the turn's message too (the message returns to the composer) or keeps it, with the agent told
 * of the undo when the next message goes out.
 */
export function RewindDialog() {
  const entry = useApp((s) => s.rewindAsk);
  const message = useApp((s) => s.messages.find((m) => m.id === s.rewindAsk?.message));
  const [choice, setChoice] = useState<RewindChoice>("rewind");
  const [remember, setRemember] = useState(false);
  if (!entry || message?.role !== "user") return null;
  const answer = (picked: RewindChoice | null) => {
    void useApp.getState().answerRewind(picked, remember);
    setChoice("rewind");
    setRemember(false);
  };
  const option = (value: RewindChoice, title: string, detail: string) => (
    <label className="flex cursor-pointer gap-2 rounded-lg border p-3 has-[:checked]:border-primary/50 has-[:checked]:bg-primary/5">
      <input
        type="radio"
        name="rewind"
        className="mt-0.5 accent-primary"
        checked={choice === value}
        onChange={() => setChoice(value)}
      />
      <span className="flex flex-col gap-0.5">
        <span className="text-sm font-medium">{title}</span>
        <span className="text-xs text-muted-foreground">{detail}</span>
      </span>
    </label>
  );
  return (
    <Dialog
      label="Undo chat changes"
      onClose={() => answer(null)}
      className="flex w-[28rem] max-w-[90vw] flex-col gap-4 rounded-xl border bg-background p-5 text-foreground shadow-2xl outline-none"
      heading={
        <>
          <h2 className="text-base font-semibold">Undid the changes of a chat message</h2>
          <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">“{entry.label}”</p>
        </>
      }
    >
      <div className="flex flex-col gap-2">
        {option(
          "rewind",
          "Also rewind the chat",
          "The chat goes back to before this message, which returns to the message box.",
        )}
        {option(
          "deck",
          "Only undo the deck changes",
          "The chat keeps the message; the agent is told about the undo with your next message.",
        )}
      </div>
      <label className="flex items-center gap-2 text-xs text-muted-foreground">
        <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} />
        Don't ask again
      </label>
      <div className="flex justify-end gap-2">
        <Button variant="ghost" onClick={() => answer(null)}>
          Skip
        </Button>
        <Button variant="primary" onClick={() => answer(choice)}>
          Continue
        </Button>
      </div>
    </Dialog>
  );
}
