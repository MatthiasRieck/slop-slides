import { Timer } from "lucide-react";
import { useRef, useState } from "react";

import { MAX_PAUSE, MAX_SECONDS, MIN_SECONDS, pauseProblem, secondsProblem } from "../../lib/video";
import { deckVideoOptions, useNarration } from "../../narrationStore";
import { Button, type ButtonSize } from "../Button";
import { NumberField } from "../Field";
import { Popover } from "../Popover";
import { useDeckVideoOptions } from "./useVideoOptions";

/**
 * The times the deck `deck` is laid out with wherever it plays by itself: on the timeline, in the
 * show's Play and in a video. How long a slide without narration shows, and the pauses before and
 * after a slide's narration. They are the deck's own, kept with its narration (see
 * `DeckNarrationSettings`), so the deck is as long on every computer; a deck that never set them
 * starts from what this computer last used. Saved as they are typed, all three once each is a
 * time the backend takes; what is not says why.
 */
export function TimingSettings({ deck }: { deck: string }) {
  const [initial] = useState(() => deckVideoOptions(deck));
  const [seconds, setSeconds] = useState(String(initial.secondsPerSlide));
  const [before, setBefore] = useState(String(initial.pauseBefore));
  const [after, setAfter] = useState(String(initial.pauseAfter));
  const problem = secondsProblem(seconds) ?? pauseProblem(before) ?? pauseProblem(after);

  /** Keeps what was typed, and saves the three once they are times that can be used. */
  const change = (set: (text: string) => void, key: "seconds" | "before" | "after") => (text: string) => {
    set(text);
    const typed = { seconds, before, after, [key]: text };
    if (secondsProblem(typed.seconds) ?? pauseProblem(typed.before) ?? pauseProblem(typed.after)) return;
    void useNarration.getState().setTiming(deck, {
      secondsPerSlide: Number(typed.seconds),
      pauseBefore: Number(typed.before),
      pauseAfter: Number(typed.after),
    });
  };

  return (
    <div className="flex flex-col gap-3 p-3 text-xs">
      <div className="text-sm font-medium">Timing</div>
      <NumberField
        label="Seconds per slide without narration"
        aria-label="Seconds per slide without narration"
        min={MIN_SECONDS}
        max={MAX_SECONDS}
        value={seconds}
        onChange={change(setSeconds, "seconds")}
      />
      <div className="flex gap-2">
        <NumberField
          label="Pause before (s)"
          aria-label="Pause before narration"
          min={0}
          max={MAX_PAUSE}
          value={before}
          onChange={change(setBefore, "before")}
        />
        <NumberField
          label="Pause after (s)"
          aria-label="Pause after narration"
          min={0}
          max={MAX_PAUSE}
          value={after}
          onChange={change(setAfter, "after")}
        />
      </div>
      <p role={problem ? "alert" : undefined} className={problem ? "text-destructive" : "text-muted-foreground"}>
        {problem ??
          "Kept with this deck, and used by the timeline, the show's Play and a video. A slide timed on the timeline keeps its own length."}
      </p>
    </div>
  );
}

/** The deck's times in a line: "5 s per slide without narration, pauses 0.5 s before and 1 s after". */
export function timingSummary(options: { secondsPerSlide: number; pauseBefore: number; pauseAfter: number }): string {
  return `${options.secondsPerSlide} s per slide without narration, pauses ${options.pauseBefore} s before and ${options.pauseAfter} s after`;
}

/** The timeline's button for the deck's times: it opens `TimingSettings` above it. */
export function TimingButton(props: { deck: string; size?: ButtonSize }) {
  const [open, setOpen] = useState(false);
  const anchor = useRef<HTMLButtonElement>(null);
  return (
    <>
      <Button
        ref={anchor}
        size={props.size ?? "xs"}
        aria-label="Timing…"
        aria-haspopup="dialog"
        aria-expanded={open}
        title="How long a slide without narration shows, and the pauses around narration"
        onClick={() => setOpen((o) => !o)}
      >
        <Timer />
        <span className="hidden @[40rem]:inline">Timing…</span>
      </Button>
      {open && (
        <Popover
          anchor={anchor}
          placement="above"
          align="end"
          width={280}
          portal
          label="Timing"
          onClose={() => setOpen(false)}
        >
          <TimingSettings deck={props.deck} />
        </Popover>
      )}
    </>
  );
}

/**
 * The deck's times as they stand, with a button that unfolds `TimingSettings` in place: what a
 * dialog (a video's) shows instead of fields of its own, so the times are set in one place.
 */
export function TimingLine({ deck }: { deck: string }) {
  const options = useDeckVideoOptions(deck);
  const [open, setOpen] = useState(false);
  return (
    <div className="flex flex-col gap-1 text-xs">
      <div className="flex items-center justify-between gap-2">
        <span data-testid="timing-summary" className="min-w-0 text-muted-foreground">
          {timingSummary(options)}
        </span>
        <Button
          size="md"
          aria-expanded={open}
          title="How long a slide without narration shows, and the pauses around narration: the deck's own times"
          onClick={() => setOpen((o) => !o)}
        >
          <Timer />
          {open ? "Done" : "Timing…"}
        </Button>
      </div>
      {open && (
        <div className="-mx-3 border-y bg-muted/30">
          <TimingSettings deck={deck} />
        </div>
      )}
    </div>
  );
}
