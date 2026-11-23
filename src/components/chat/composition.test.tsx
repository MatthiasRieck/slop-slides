// How the chat's messages are put together from the parts they are made of: the one footer of a
// message, the trace of its tool calls, the fold of a long message, the chips of the composer.
import { fireEvent, render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";

import { type AssistantMessage, type ChatPart, type UserMessage, useApp } from "../../store";
import { AssistantBlock } from "./AssistantBlock";
import { QueuedMessages } from "./QueuedMessages";
import { UserBubble } from "./UserBubble";

const said = (text: string, patch: Partial<UserMessage> = {}): UserMessage => ({
  id: "u",
  role: "user",
  text,
  slide: null,
  attachments: [],
  createdAt: 0,
  ...patch,
});

const reply = (parts: ChatPart[], patch: Partial<AssistantMessage> = {}): AssistantMessage => ({
  id: "a",
  role: "assistant",
  parts,
  status: "done",
  thinking: false,
  error: null,
  costUsd: null,
  durationMs: null,
  createdAt: 0,
  ...patch,
});

const text = (value: string): ChatPart => ({ kind: "text", text: value });
const tool = (id: string): ChatPart => ({ kind: "tool", id, name: "Read", input: { file_path: id }, status: "done" });

const slots = (name: string, within: ParentNode = document) => [
  ...within.querySelectorAll<HTMLElement>(`[data-slot=${name}]`),
];

beforeEach(() => {
  useApp.setState({ workspace: null, deck: null, running: false, queue: [] });
});

describe("a long message of the user's", () => {
  const long = "word ".repeat(200);

  it("is folded to its start, with a trigger under it that unfolds it and folds it again", () => {
    render(<UserBubble message={said(long)} />);
    const trigger = screen.getByRole("button", { name: "Show full message" });
    expect(trigger.dataset.slot).toBe("collapsible-trigger");
    expect(trigger.closest("[data-slot=collapsible]")).not.toBeNull();
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    // The whole text is there either way, cut off by its height alone.
    const words = document.getElementById(trigger.getAttribute("aria-controls")!)!;
    expect(words.textContent).toBe(long);
    expect(words.className).toContain("max-h-44");

    fireEvent.click(trigger);
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    expect(trigger.textContent).toBe("Show less");
    expect(words.className).not.toContain("max-h-44");

    fireEvent.click(trigger);
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    expect(trigger.textContent).toBe("Show full message");
    expect(words.className).toContain("max-h-44");
  });

  it("is one of many lines as well as one of many letters", () => {
    render(<UserBubble message={said(Array.from({ length: 13 }, (_, i) => `line ${i}`).join("\n"))} />);
    expect(screen.getByRole("button", { name: "Show full message" })).toBeTruthy();
  });

  it("is not what a short message is: that has nothing to unfold", () => {
    render(<UserBubble message={said("Make the title bigger")} />);
    expect(screen.queryByRole("button", { name: /^Show/ })).toBeNull();
    expect(slots("collapsible")).toHaveLength(0);
    expect(screen.getByText("Make the title bigger").className).not.toContain("max-h-44");
  });
});

describe("what is under a message", () => {
  it("says what went along with a message of the user's in a footer of the message", () => {
    render(<UserBubble message={said("Hi", { screenshot: "shots/1.png", reverted: true })} />);
    const along = screen.getByText("· with screenshot").parentElement!;
    expect(along.dataset.slot).toBe("message-footer");
    expect(along.textContent).toBe("changes undone ·· with screenshot");
    // Its actions are a footer of their own, above it.
    expect(slots("message-footer")).toHaveLength(2);
    expect(within(slots("message-footer")[0]!).getByRole("button", { name: "Copy message" })).toBeTruthy();
  });

  it("holds a reply's actions and how its turn went in one footer", () => {
    render(<AssistantBlock message={reply([text("Done.")], { durationMs: 3420, costUsd: 0.1234 })} retry />);
    const [footer, ...more] = slots("message-footer");
    expect(more).toHaveLength(0);
    expect(within(footer!).getByRole("button", { name: "Copy message" })).toBeTruthy();
    expect(within(footer!).getByRole("button", { name: "Retry" })).toBeTruthy();
    expect(within(footer!).getByText("3.4s · $0.123")).toBeTruthy();
  });

  it("says in that footer that a reply was stopped, with nothing to copy when it has no text", () => {
    render(<AssistantBlock message={reply([tool("a")], { status: "interrupted" })} retry={false} />);
    const [footer, ...more] = slots("message-footer");
    expect(more).toHaveLength(0);
    expect(footer!.textContent).toBe("Stopped");
    expect(screen.queryByRole("button", { name: "Copy message" })).toBeNull();
  });

  it("has no footer under a reply still coming in", () => {
    render(<AssistantBlock message={reply([text("So far")], { status: "streaming" })} retry={false} />);
    expect(slots("message-footer")).toHaveLength(0);
  });
});

describe("the trace of a reply's tool calls", () => {
  /** The traces of the reply that hold tool calls, each as the files its rows read. */
  const traces = () =>
    slots("trace")
      .filter((trace) => trace.querySelector(":scope > [data-slot=trace-collapsible]"))
      .map((trace) =>
        [...trace.querySelectorAll(":scope > [data-slot=trace-collapsible]")].map(
          (row) => row.querySelector("[data-slot=trace-title]")!.textContent,
        ),
      );

  it("holds the tool calls that follow one another as rows of one trace while the reply comes in", () => {
    const parts = [text("First"), tool("a"), tool("b"), tool("c"), text("Then"), tool("d")];
    const { rerender } = render(<AssistantBlock message={reply(parts, { status: "streaming" })} retry={false} />);
    expect(traces()).toEqual([["Read a", "Read b", "Read c"], ["Read d"]]);

    // A tool call more is a row more of the same trace: the rows before it stay the elements they were.
    const rows = slots("trace-collapsible");
    rerender(<AssistantBlock message={reply([...parts, tool("e")], { status: "streaming" })} retry={false} />);
    expect(traces()).toEqual([
      ["Read a", "Read b", "Read c"],
      ["Read d", "Read e"],
    ]);
    expect(slots("trace-collapsible").slice(0, 4)).toEqual(rows);
  });

  it("folds them into one line of steps once the reply is done, which unfolds into a trace of its own", () => {
    render(<AssistantBlock message={reply([tool("a"), tool("b"), text("Done."), tool("c")])} retry={false} />);
    expect(traces()).toEqual([["2 steps"], ["Read c"]]);
    fireEvent.click(screen.getByRole("button", { name: /2 steps/ }));
    const inner = slots("trace-collapsible-content-inner")[0]!;
    // The steps are the rows of a trace within the row that was unfolded.
    expect(inner.children).toHaveLength(1);
    expect((inner.firstElementChild as HTMLElement).dataset.slot).toBe("trace");
    expect(traces()).toEqual([["2 steps"], ["Read a", "Read b"], ["Read c"]]);
  });

  it("lists what waits for the agent as a list, with no trace around it that would lay nothing out", () => {
    useApp.setState({
      running: true,
      queue: [
        { id: "q1", text: "Later", options: { includeSlide: false, attachments: [], slide: null } },
        { id: "q2", text: "Later still", options: { includeSlide: false, attachments: [], slide: null } },
      ],
    });
    render(<QueuedMessages onEdit={() => {}} />);
    const queued = screen.getByRole("region", { name: "Queued messages" });
    expect(slots("trace", queued)).toHaveLength(0);
    const items = within(queued).getAllByRole("listitem");
    expect(
      items.map((item) => item.querySelector("[data-slot=trace-line] [data-slot=trace-title]")!.textContent),
    ).toEqual(["Later", "Later still"]);
    expect(items[0]!.parentElement!.tagName).toBe("UL");
  });
});
