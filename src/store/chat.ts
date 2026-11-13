import { type AgentEvent, api, type Deck, errorMessage } from "../lib/api";
import type { SlideComment } from "../lib/comments";
import { inkBounds, type Stroke } from "../lib/ink";
import type { Provider } from "../lib/models";
import { pixelsOf } from "../lib/slideSize";
import { applyReplyEvent, replyProvider } from "./agentEvents";
import { captureSlide } from "./capture";
import { editsSaved } from "./editQueue";
import { showErrorIn } from "./errors";
import { refreshHistory } from "./history";
import {
  type AssistantMessage,
  type ChatMessage,
  expireApprovals,
  newId,
  newReply,
  persistChat,
  type QueuedMessage,
  type ReadyMessage,
  type SendOptions,
  settleInterrupted,
  settleReply,
  type UserMessage,
} from "./messages";
import { followChatProvider, turnSettings } from "./models";
import { buildPrompt, withRevertNotes } from "./prompts";
import { commentsInScope, flushReview, heldComment } from "./review";
import type { AppState, AppStore, Slice } from "./types";

/**
 * The conversation with the agent on show: its messages, the turn running, and what waits for it.
 * Each deck has its own; a folder has one too, for when no deck is open.
 */
export interface ChatSlice {
  /**
   * What the chat is about, which the backend knows it by: the open deck's id, or the workspace
   * folder's path for the folder's own chat.
   */
  chatKey: string | null;
  /**
   * The folder's own chat is on show beside the open deck, which its running turn made and
   * showed: when the turn ends, the chat moves to the deck (see `followDeck`).
   */
  chatFollowsDeck: boolean;
  messages: ChatMessage[];
  /**
   * Messages sent while the agent works, in order. The first goes out when a turn finishes
   * cleanly; after a stop or an error they wait until steered or sent by hand.
   */
  queue: QueuedMessage[];
  sessionProvider: Provider | null;
  running: boolean;
  chatRevision: number;

  /** Sends a message to the agent; while it works, the message waits in `queue`. */
  send: (text: string, options: SendOptions) => Promise<void>;
  /**
   * Sends a message into the agent's running turn, to change what it does now rather than
   * after; without a turn, just sends it. If the turn ends first, it runs as the next turn.
   */
  steer: (text: string, options: SendOptions) => Promise<void>;
  /** Steers with a queued message (or, while the agent is idle, sends it). */
  steerQueued: (id: string) => Promise<void>;
  /** Takes a message out of the queue, returning it (to edit it in the composer). */
  takeQueued: (id: string) => QueuedMessage | null;
  /** Has the agent summarize the conversation so far, freeing up its context. */
  compact: () => Promise<void>;
  interrupt: () => void;
  resetChat: () => Promise<void>;
  /** Goes on with a past conversation: in its deck `deck`, which opens, else in the chat on show, where it moves. */
  selectChatThread: (thread: string, deck?: string | null) => Promise<void>;
}

export const COMPACT_COMMAND = "/compact";

/** Steered messages sent to the agent, until it reports taking them (see `steered`). */
const pendingSteers = new Map<string, UserMessage>();

export const createChatSlice: Slice<ChatSlice> = (set, get, app) => ({
  chatKey: null,
  chatFollowsDeck: false,
  messages: [],
  queue: [],
  sessionProvider: null,
  running: false,
  chatRevision: 0,

  send: async (text, options) => {
    const { chatKey: chat, running, selection } = get();
    if (!chat) return;
    if (running) return enqueue(app, text, options);
    // Typed as a message, the command still compacts rather than reaching the agent as text.
    if (text.trim() === COMPACT_COMMAND) return get().compact();
    const draft = draftMessage(get(), text, options);
    const assistant = newReply(selection.provider);
    set((s) => ({ messages: [...s.messages, draft.user, assistant], running: true }));
    const ready = await readyMessage(app, draft);
    if (get().chatKey !== chat) return;
    set((s) => ({ messages: s.messages.map((m) => (m.id === ready.user.id ? ready.user : m)) }));
    await startTurn(app, chat, assistant.id, ready.prompt, false, ready.user);
  },

  steer: async (text, options) => {
    const { chatKey: chat, running } = get();
    if (!chat) return;
    if (!running) return get().send(text, options);
    // A compaction is a turn of its own.
    if (text.trim() === COMPACT_COMMAND) return enqueue(app, text, options);
    const ready = await readyMessage(app, draftMessage(get(), text, options));
    if (get().chatKey !== chat) return;
    pendingSteers.set(ready.user.id, ready.user);
    // The chat shows the message when the agent reports taking it (the `steered` event).
    const delivered = await api.steerAgent(chat, ready.prompt, ready.user.id).catch(() => false);
    if (delivered) return;
    pendingSteers.delete(ready.user.id);
    if (get().chatKey !== chat) return;
    // The turn ended first: the message starts the next one.
    if (get().running) set((s) => ({ queue: [{ id: ready.user.id, text, options, ready }, ...s.queue] }));
    else await sendReady(app, chat, ready);
  },

  steerQueued: async (id) => {
    const item = get().takeQueued(id);
    if (!item) return;
    const { chatKey: chat } = get();
    if (item.ready && chat && !get().running) return sendReady(app, chat, item.ready);
    if (item.ready) {
      // Made ready already: it can only wait for the turn to end.
      set((s) => ({ queue: [item, ...s.queue] }));
      return;
    }
    await get().steer(item.text, item.options);
  },

  takeQueued: (id) => {
    const item = get().queue.find((q) => q.id === id) ?? null;
    if (item) set((s) => ({ queue: s.queue.filter((q) => q.id !== id) }));
    return item;
  },

  compact: async () => {
    const { chatKey: chat, running, selection } = get();
    if (!chat || running) return;
    const user: UserMessage = {
      id: newId(),
      role: "user",
      text: COMPACT_COMMAND,
      slide: null,
      attachments: [],
      command: "compact",
      createdAt: Date.now(),
    };
    const assistant = newReply(selection.provider);
    set((s) => ({ messages: [...s.messages, user, assistant], running: true }));
    await startTurn(app, chat, assistant.id, COMPACT_COMMAND, true);
  },

  interrupt: () => {
    const { chatKey } = get();
    if (chatKey) {
      updateLastAssistant(app, (m) => ({ ...m, parts: expireApprovals(m.parts) }));
      void api.interruptAgent(chatKey);
    }
  },

  selectChatThread: async (thread, deck = null) => {
    if (get().running) return;
    // A deck's conversation is gone on with in its deck.
    if (deck && deck !== get().chatKey) await get().openDeck(deck);
    const { chatKey: key, messages } = get();
    if (!key || (deck && deck !== key)) return;
    if (messages.length > 0) await api.saveChat(key, messages);
    const { chat, provider } = await api.selectChatThread(key, thread);
    if (get().chatKey !== key) return;
    restoreChat(app, key, chat, false, provider);
    set((s) => ({ chatRevision: s.chatRevision + 1, composerFill: null, rewindAsk: null, revertNotes: [] }));
  },

  resetChat: async () => {
    const { chatKey: key, running } = get();
    if (!key || running) return;
    await api.resetChat(key);
    if (get().chatKey !== key) return;
    set((s) => ({
      messages: [],
      queue: [],
      running: false,
      sessionProvider: null,
      composerFill: null,
      rewindAsk: null,
      revertNotes: [],
      chatRevision: s.chatRevision + 1,
    }));
  },
});

/**
 * Shows the chat about `key` (a deck's id, or a folder's path): loads it, and whether its agent
 * is still at work.
 */
export async function loadChat(app: AppStore, key: string) {
  if (app.getState().chatKey !== key) {
    // The chat before is gone from view at once, and nothing of it reaches this one.
    app.setState((s) => ({
      chatKey: key,
      chatFollowsDeck: false,
      messages: [],
      queue: [],
      running: false,
      sessionProvider: null,
      rewindAsk: null,
      revertNotes: [],
      chatRevision: s.chatRevision + 1,
    }));
  }
  const [chat, running, provider] = await Promise.all([
    api.loadChat(key),
    api.agentRunning(key),
    api.sessionProvider(key),
  ]);
  restoreChat(app, key, chat, running, provider);
}

/**
 * Before the chat on show gives way to another: stops its turn and saves it. The folder's chat
 * goes along with the deck it made, if it can.
 */
export async function leaveChat(app: AppStore) {
  const { chatKey, running, messages } = app.getState();
  if (!chatKey) return;
  try {
    if (running) await api.interruptAgent(chatKey);
    // An empty chat needs no session.
    if (messages.length > 0) await api.saveChat(chatKey, messages.map(settleInterrupted));
    if (madeTheDeck(app.getState())) await api.moveChatToDeck();
  } catch {
    // Its deck is gone (renamed, deleted), or its turn is still ending: leaving goes on.
  }
}

/** The folder's own chat is on show beside the deck its turn made, to move there. */
function madeTheDeck(state: AppState): boolean {
  return state.chatFollowsDeck && !!state.deck;
}

/**
 * Once the turn that made the open deck is over, the folder's chat moves to the deck: it is the
 * deck's chat from here on.
 */
async function followDeck(app: AppStore) {
  const state = app.getState();
  const { deck, chatKey: folder, messages } = state;
  if (!madeTheDeck(state) || !deck || !folder || state.running) return;
  try {
    await api.saveChat(folder, messages);
    await api.moveChatToDeck();
  } catch (error) {
    showErrorIn(app, error);
    return;
  }
  if (app.getState().chatKey === folder && app.getState().deck?.id === deck.id) {
    app.setState({ chatKey: deck.id, chatFollowsDeck: false });
  }
}

function restoreChat(app: AppStore, key: string, chat: unknown, running: boolean, provider: Provider | null) {
  if (app.getState().chatKey !== key) return;
  const messages = Array.isArray(chat) ? (chat as ChatMessage[]) : [];
  app.setState({
    messages: running ? messages : messages.map(settleInterrupted),
    // A queue belongs to the chat it was typed in.
    queue: [],
    running,
    sessionProvider: provider === "claude" || provider === "codex" || provider === "copilot" ? provider : null,
  });
  followChatProvider(app);
}

/**
 * Hands `prompt` to the selected agent, in chat `chat`; a failure to start lands on reply
 * `replyId`. `message` is the user's message the turn answers.
 */
async function startTurn(
  app: AppStore,
  chat: string,
  replyId: string,
  prompt: string,
  compact: boolean,
  message?: UserMessage,
) {
  try {
    const { workspace } = app.getState();
    if (!workspace) throw new Error("No folder is open.");
    await api.sendMessage(
      workspace.path,
      chat,
      prompt,
      turnSettings(app.getState()),
      compact,
      message ? { message: message.id, label: message.text } : null,
    );
  } catch (error) {
    updateAssistant(app, replyId, (m) => ({
      ...m,
      status: "error",
      thinking: false,
      error: errorMessage(error),
    }));
    app.setState({ running: false });
    persistChat(app);
  }
}

/** Puts a message at the end of the queue, keeping the slide it is about. */
function enqueue(app: AppStore, text: string, options: SendOptions) {
  const { selected, deck } = app.getState();
  const slide = options.slide !== undefined ? options.slide : deck && options.includeSlide ? selected : null;
  app.setState((s) => ({ queue: [...s.queue, { id: newId(), text, options: { ...options, slide } }] }));
}

/** Sends the first queued message, once a turn finished cleanly. */
function advanceQueue(app: AppStore) {
  const { queue, chatKey, running } = app.getState();
  const next = queue[0];
  if (!next || !chatKey || running) return;
  app.setState({ queue: queue.slice(1) });
  if (next.ready) void sendReady(app, chatKey, next.ready);
  else void app.getState().send(next.text, next.options);
}

/** Starts a turn for a message made ready before (a steer that came too late). */
async function sendReady(app: AppStore, chat: string, ready: ReadyMessage) {
  const assistant = newReply(app.getState().selection.provider);
  app.setState((s) => ({ messages: [...s.messages, ready.user, assistant], running: true }));
  await startTurn(app, chat, assistant.id, ready.prompt, false, ready.user);
}

/** A user's message as sent now, before what takes waiting (see `readyMessage`). */
interface DraftMessage {
  user: UserMessage;
  /** The marks on its slide, when they go along. */
  strokes: Stroke[];
  comments: SlideComment[];
}

function draftMessage(state: AppState, text: string, options: SendOptions): DraftMessage {
  const { deck, selected } = state;
  const { includeSlide, attachments, screenshot, element } = options;
  // A queued message's slide may be gone by the time it goes out.
  const kept = options.slide && deck?.slides.some((s) => s.id === options.slide) ? options.slide : null;
  const slide = !deck || !includeSlide ? null : options.slide !== undefined ? kept : selected;
  const strokes = slide ? (state.sketches[slide] ?? []) : [];
  // Marks go out once, while they are on show; they stay on the slide as a review.
  const unsent = !!slide && state.reviewVisible && strokes !== state.sketchesSent[slide];
  const bounds = unsent && deck ? inkBounds(strokes, pixelsOf(deck)) : null;
  const comments = commentsInScope(state).filter((c) => !heldComment(state, c));
  const user: UserMessage = {
    id: newId(),
    role: "user",
    text,
    slide,
    attachments,
    sketch: bounds ? { image: null, bounds } : null,
    ...(comments.length > 0 && { comments }),
    ...(screenshot && { screenshot }),
    ...(element && { element }),
    createdAt: Date.now(),
  };
  return { user, strokes: bounds ? strokes : [], comments };
}

/** Takes what goes along with `draft` (its sketch, its comments) and builds its prompt. */
async function readyMessage(app: AppStore, { user, strokes, comments }: DraftMessage): Promise<ReadyMessage> {
  // Sent, they are dealt with as far as the slides go: off they come, whatever the agent makes of them.
  app.getState().removeSentComments(comments);
  // Let any edit still being saved land first, so the agent sees the final version.
  await editsSaved();
  await flushReview(app);
  const { deck } = app.getState();
  const slide = user.slide;
  if (deck && slide && user.sketch) {
    // Screenshot the slide with the ink on it.
    const image = await captureSlide(deck.id);
    user = { ...user, sketch: { ...user.sketch, image } };
    app.setState((s) => ({ sketchesSent: { ...s.sketchesSent, [slide]: strokes } }));
  }
  const template = deck ? await stageDeckTemplate(deck) : null;
  const { workspace, openedFile, revertNotes } = app.getState();
  app.setState({ revertNotes: [] });
  return { user, prompt: withRevertNotes(revertNotes, buildPrompt(user, { workspace, deck, openedFile, template })) };
}

/**
 * A copy of the deck's template for the agent to take layouts from; null when the deck has
 * none or it is gone (there are just no layouts to read then).
 */
async function stageDeckTemplate(deck: Deck): Promise<string | null> {
  if (!deck.template) return null;
  try {
    return await api.stageTemplate(deck.id, deck.template);
  } catch {
    return null;
  }
}

function updateAssistant(
  app: AppStore,
  id: string,
  update: (m: AssistantMessage, state: AppState) => AssistantMessage,
) {
  app.setState((s) => ({
    messages: s.messages.map((m) => (m.id === id && m.role === "assistant" ? update(m, s) : m)),
  }));
}

function updateLastAssistant(app: AppStore, update: (m: AssistantMessage, state: AppState) => AssistantMessage) {
  const last = app.getState().messages.findLast((m) => m.role === "assistant");
  if (last) updateAssistant(app, last.id, update);
}

/** Follows an event of the chat's agent in the chat. */
export function applyAgentEvent(app: AppStore, event: AgentEvent) {
  switch (event.type) {
    case "openFile":
      void app.getState().openPath(event.path, { byAgent: true });
      return;
    case "started":
      return;
    case "steered": {
      const user = event.message ? pendingSteers.get(event.message) : undefined;
      if (!user) return;
      pendingSteers.delete(user.id);
      const { messages, selection } = app.getState();
      const last = messages.findLast((m) => m.role === "assistant");
      // The reply so far ends here; the steered message gets one of its own.
      updateLastAssistant(app, (m) => ({ ...m, ...settleReply(m), status: m.error ? "error" : "done" }));
      const reply = newReply(last?.role === "assistant" ? replyProvider(last, selection.provider) : selection.provider);
      app.setState((s) => ({ messages: [...s.messages, user, reply] }));
      persistChat(app);
      return;
    }
    case "finished": {
      let failed = false;
      updateLastAssistant(app, (m) => {
        failed = !!m.error;
        return { ...m, ...settleReply(m), status: event.interrupted ? "interrupted" : m.error ? "error" : "done" };
      });
      app.setState({ running: false });
      persistChat(app);
      // The turn's changes are in the decks' histories once it finished.
      void refreshHistory(app);
      const next = () => {
        if (!event.interrupted && !failed) advanceQueue(app);
      };
      // The deck this turn made takes the chat first; what is queued is said there.
      if (madeTheDeck(app.getState())) void followDeck(app).then(next);
      else next();
      return;
    }
    default:
      return updateLastAssistant(app, (m, s) =>
        applyReplyEvent(m, event, { messages: s.messages, provider: s.selection.provider }),
      );
  }
}
