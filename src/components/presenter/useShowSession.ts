import { type NarrationRecorder, useNarrationRecorder } from "../NarrationRecorder";
import { useTeleprompter } from "../Teleprompter";
import { type ShowTimer, useShowTimer } from "./useShowTimer";

/**
 * What a show keeps going whether or not its presenter view is open: its clocks, the teleprompter
 * and the narration recorder. They live with the show (or with the presenter view's own window),
 * so closing the panel beside the slide neither resets a clock nor turns the microphone off.
 */
export interface ShowSession {
  timer: ShowTimer;
  teleprompter: ReturnType<typeof useTeleprompter>;
  recorder: NarrationRecorder;
}

/** The session of the show of `deck` (its id; empty without one), with `slide` on screen. */
export function useShowSession(deck: string, slide: string | null): ShowSession {
  return {
    timer: useShowTimer(slide),
    teleprompter: useTeleprompter(),
    recorder: useNarrationRecorder(deck, slide),
  };
}
