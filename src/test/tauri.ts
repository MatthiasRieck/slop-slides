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

/** `@tauri-apps/plugin-opener` */
export const revealItemInDir: Mock = vi.fn(async () => {});

export const tauriMocks = [
  invoke,
  listen,
  emit,
  ask,
  save,
  open,
  revealItemInDir,
  getCurrentWindow,
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
