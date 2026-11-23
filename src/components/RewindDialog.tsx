import { useId, useRef, useState } from "react";

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Checkbox } from "@/components/ui/checkbox";
import { Field, FieldContent, FieldDescription, FieldLabel } from "@/components/ui/field";
import { type RewindChoice, useApp } from "../store";
import { QUIET_LABEL } from "./styles";

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
  const rememberId = useId();
  const rewind = useRef<HTMLButtonElement>(null);
  if (!entry || message?.role !== "user") return null;
  const answer = (picked: RewindChoice | null) => {
    void useApp.getState().answerRewind(picked, remember);
    setRemember(false);
  };
  return (
    <AlertDialog
      open
      onOpenChange={(open) => {
        if (!open) answer(null);
      }}
    >
      <AlertDialogContent initialFocus={rewind} className="data-[size=default]:sm:max-w-md">
        <AlertDialogHeader>
          <AlertDialogTitle>You undid the agent's changes. What about the chat?</AlertDialogTitle>
          <AlertDialogDescription className="line-clamp-2 text-xs">
            The deck is back to how it was before your message “{entry.label}”.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <div className="flex flex-col gap-2">
          <Choice
            ref={rewind}
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
        <Field orientation="horizontal" className="items-start">
          <Checkbox id={rememberId} checked={remember} onCheckedChange={setRemember} className="mt-0.5" />
          <FieldContent className="gap-0.5">
            <FieldLabel htmlFor={rememberId} className={QUIET_LABEL}>
              Don't ask again: always do what I pick here.
            </FieldLabel>
            <FieldDescription className="text-xs">You can change this in Settings › General.</FieldDescription>
          </FieldContent>
        </Field>
        <AlertDialogFooter className="items-center sm:justify-between">
          <p className="text-xs text-muted-foreground">
            Or leave the chat as it is, without telling the agent; it may not know its changes are gone.
          </p>
          <AlertDialogCancel variant="ghost" size="sm" className="shrink-0">
            Do nothing
          </AlertDialogCancel>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

/** One of the dialog's answers: a button with what it does written under its name. */
function Choice(props: {
  ref?: React.Ref<HTMLButtonElement>;
  label: string;
  detail: string;
  primary?: boolean;
  onClick: () => void;
}) {
  return (
    <AlertDialogAction
      ref={props.ref}
      variant={props.primary ? "default" : "outline"}
      onClick={props.onClick}
      className="h-auto flex-col items-start gap-0.5 p-3 text-left whitespace-normal"
    >
      <span className="text-sm font-medium">{props.label}</span>
      <span className={props.primary ? "text-xs font-normal opacity-90" : "text-xs font-normal text-muted-foreground"}>
        {props.detail}
      </span>
    </AlertDialogAction>
  );
}
