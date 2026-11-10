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

/** `@tauri-apps/plugin-dialog` */
export const ask: Mock = vi.fn();
export const save: Mock = vi.fn();
export const open: Mock = vi.fn();

/** `@tauri-apps/plugin-opener` */
export const revealItemInDir: Mock = vi.fn(async () => {});

export const tauriMocks = [invoke, listen, emit, ask, save, open, revealItemInDir];

/** Answers a backend command, given its arguments. */
export type Handler = (args: Record<string, unknown>) => unknown;

/** Answers `invoke(command, args)` from a table; unknown commands resolve to undefined. */
export function backend(handlers: Record<string, Handler>) {
  invoke.mockImplementation(async (command: string, args?: Record<string, unknown>) => handlers[command]?.(args ?? {}));
}

/** The arguments of every call of `command`, in order. */
export const calls = (command: string) =>
  invoke.mock.calls.filter(([c]) => c === command).map(([, args]) => args as Record<string, unknown>);
