// Shared stand-ins for the Tauri APIs. src/test/setup.ts mocks the
// @tauri-apps modules with these for every test file; tests import them from
// here to script answers (`invoke.mockImplementation(...)`) and assert calls.
// Call history is cleared after each test; implementations persist until a
// test replaces or resets them.
import { type Mock, vi } from "vitest";

/** `@tauri-apps/api/core` */
export const invoke: Mock = vi.fn();
export class Channel {
  constructor(public onmessage: () => void) {}
}

/** `@tauri-apps/api/event`; `listen` resolves to a no-op unlisten. */
export const listen: Mock = vi.fn(async () => () => {});
export const emit: Mock = vi.fn(async () => {});

/** What the app asked to be told of before its window closes (see `requestClose`). */
type CloseHandler = (event: { preventDefault: () => void }) => void | Promise<void>;
const closeHandlers = new Set<CloseHandler>();

/** `@tauri-apps/api/window`: the window the app runs in. */
export const appWindow = {
  setTitle: vi.fn(async (_title: string) => {}),
  setFullscreen: vi.fn(async (_fullscreen: boolean) => {}),
  isFullscreen: vi.fn(async () => false),
  requestUserAttention: vi.fn(async (_type: number | null) => {}),
  onCloseRequested: vi.fn(async (handler: CloseHandler) => {
    closeHandlers.add(handler);
    return () => void closeHandlers.delete(handler);
  }),
};
export const getCurrentWindow: Mock = vi.fn(() => appWindow);

/** Asks the window to close, as its close button does; true when nothing kept it open. */
export async function requestClose(): Promise<boolean> {
  let prevented = false;
  const event = {
    preventDefault: () => {
      prevented = true;
    },
  };
  for (const handler of [...closeHandlers]) await handler(event);
  return !prevented;
}

/** `@tauri-apps/plugin-dialog` */
export const ask: Mock = vi.fn();
export const save: Mock = vi.fn();
export const open: Mock = vi.fn();

/** The questions of one copy of ../store/confirm.ts (a store module loaded afresh has its own). */
type Questions = typeof import("../store/confirm").useConfirmQuestion;
const answered = new Set<Questions>();

/**
 * Answers the in-app yes-or-no questions of `questions` as the native dialog was answered before
 * them: by what `ask`, called with the message and the dialog's title and labels, resolves to.
 * While `ask` gives no answer (its default), a question stays open for the test to answer.
 */
export function answerQuestionsWithAsk(questions: Questions) {
  if (answered.has(questions)) return;
  answered.add(questions);
  questions.subscribe(({ question }, previous) => {
    if (!question || question === previous.question) return;
    const { title, message, confirmLabel, cancelLabel } = question;
    const reply: unknown = ask(message, {
      title,
      kind: "warning",
      okLabel: confirmLabel,
      ...(cancelLabel !== undefined && { cancelLabel }),
    });
    void Promise.resolve(reply).then(
      (confirmed) => typeof confirmed === "boolean" && question.answer(confirmed),
      () => {},
    );
  });
}

/** Says no to every question still open, so none outlives its test. */
export function dropOpenQuestions() {
  for (const questions of answered) {
    for (let open = questions.getState().question; open; open = questions.getState().question) open.answer(false);
  }
}

/** `@tauri-apps/plugin-opener` */
export const revealItemInDir: Mock = vi.fn(async () => {});
export const openUrl: Mock = vi.fn(async () => {});

export const tauriMocks = [
  invoke,
  listen,
  emit,
  ask,
  save,
  open,
  revealItemInDir,
  openUrl,
  getCurrentWindow,
  appWindow.requestUserAttention,
  appWindow.setTitle,
  appWindow.setFullscreen,
  appWindow.isFullscreen,
  appWindow.onCloseRequested,
];

/** Answers a backend command, given its arguments. */
export type Handler = (args: Record<string, unknown>) => unknown;

/** Answers `invoke(command, args)` from a table; unknown commands resolve to undefined. */
export function backend(handlers: Record<string, Handler>) {
  invoke.mockImplementation(async (command: string, args?: Record<string, unknown>) => handlers[command]?.(args ?? {}));
}

/** The arguments of every call of `command`, in order. */
export const calls = (command: string) =>
  invoke.mock.calls.filter(([c]) => c === command).map(([, args]) => args as Record<string, unknown>);
