// The comment panels by themselves: the composer's chip and the deck's overview. The pins and the
// comment's editor are tested on the stage (Stage.test.tsx), where they live.
import { fireEvent, render, screen } from "@testing-library/react";
import { useRef, useState } from "react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { useApp } from "../store";
import { DECK_HTML, deckFor } from "../test/fixtures";
import { settle, tooltipOf } from "../test/ui";
import { CommentsOverview, ComposerComments } from "./Comments";

const comment = (id: string, text: string) => ({ id, text, x: 0.5, y: 0.5 });
const comments = { intro: [comment("a", "Bigger"), comment("b", "Remove this")], outro: [comment("c", "Add a chart")] };

beforeEach(() =>
  useApp.setState({
    deck: deckFor(DECK_HTML),
    selected: "intro",
    comments,
    commentScope: "slide",
    commentsHeld: {},
    commentAsked: null,
    reviewVisible: true,
  }),
);
afterEach(() => useApp.setState({ comments: {}, commentScope: "slide", commentsHeld: {}, commentAsked: null }));

/** A press with the pointer where a popover listens for one outside it. */
const press = (element: Element) => {
  fireEvent.pointerDown(element, { pointerType: "mouse", button: 0 });
  fireEvent.click(element);
};

describe("the composer's comments", () => {
  const count = (name: string) => screen.getByRole("button", { name });

  it("is a group of two choices, one of which is always on", () => {
    render(<ComposerComments />);
    const group = screen.getByRole("group", { name: "Which comments to send" });
    const choice = (name: string) => screen.getByRole("button", { name });
    expect(group.contains(choice("This slide"))).toBe(true);
    expect(choice("This slide").getAttribute("aria-pressed")).toBe("true");
    expect(choice("All slides").getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(choice("All slides"));
    expect(useApp.getState().commentScope).toBe("deck");
    expect(choice("All slides").getAttribute("aria-pressed")).toBe("true");
    // Pressing the one that is on does not turn both off.
    fireEvent.click(choice("All slides"));
    expect(useApp.getState().commentScope).toBe("deck");
    expect(choice("All slides").getAttribute("aria-pressed")).toBe("true");
  });

  it("says in tooltips what its parts do", () => {
    render(<ComposerComments />);
    expect(tooltipOf(count("2 comments"))).toBe("Show the comments that go out with your message");
    expect(tooltipOf(count("This slide"))).toBe("Send the comments on this slide");
    expect(tooltipOf(count("All slides"))).toBe("Send the comments of the whole presentation");
    expect(tooltipOf(count("Don't send comments"))).toBe(
      "Don't send these comments; they stay on the slides until they are sent",
    );
  });

  it("lists the comments in a panel that takes the focus, and gives it back on Escape", async () => {
    render(<ComposerComments />);
    const chip = count("2 comments");
    chip.focus();
    fireEvent.click(chip);
    expect(chip.getAttribute("aria-expanded")).toBe("true");
    const list = screen.getByRole("dialog", { name: "Comments to send" });
    await settle();
    expect(list.contains(document.activeElement)).toBe(true);
    fireEvent.click(screen.getByRole("checkbox", { name: "Send: Bigger" }));
    expect(useApp.getState().commentsHeld).toEqual({ a: "Bigger" });
    expect(count("1 comment")).toBeTruthy();
    fireEvent.keyDown(document.activeElement!, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
    await settle();
    expect(document.activeElement).toBe(count("1 comment"));
  });

  it("closes the list on a press beside it, and on its own button", () => {
    render(
      <>
        <ComposerComments />
        <p>Elsewhere</p>
      </>,
    );
    fireEvent.click(count("2 comments"));
    expect(screen.getByRole("dialog", { name: "Comments to send" })).toBeTruthy();
    press(screen.getByText("Elsewhere"));
    expect(screen.queryByRole("dialog")).toBeNull();
    fireEvent.click(count("2 comments"));
    fireEvent.click(count("2 comments"));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("says so when the slide has no comment to list", () => {
    useApp.setState({ selected: "#2" });
    render(<ComposerComments />);
    fireEvent.click(count("0 comments"));
    expect(screen.getByText("No comments on this slide.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Don't send comments" })).toBeNull();
  });
});

/** The overview as a toolbar has it: behind a button that opens and closes it. */
function Opener() {
  const [open, setOpen] = useState(false);
  const anchor = useRef<HTMLButtonElement>(null);
  return (
    <>
      <button ref={anchor} type="button" onClick={() => setOpen((v) => !v)}>
        Comments
      </button>
      <p>Elsewhere</p>
      {open && <CommentsOverview anchor={anchor} onClose={() => setOpen(false)} />}
    </>
  );
}
describe("the overview of the deck's comments", () => {
  const opener = () => screen.getByRole("button", { name: "Comments" });
  const overview = () => screen.queryByRole("dialog", { name: "Comments" });

  it("closes on a press beside it and on Escape, and once on its own button", () => {
    render(<Opener />);
    fireEvent.click(opener());
    expect(overview()).toBeTruthy();
    // The button's own press closes it: it is not also a press outside that the button undoes.
    press(opener());
    expect(overview()).toBeNull();
    fireEvent.click(opener());
    press(screen.getByText("Elsewhere"));
    expect(overview()).toBeNull();
    fireEvent.click(opener());
    fireEvent.keyDown(overview()!, { key: "Escape" });
    expect(overview()).toBeNull();
  });

  it("goes to a comment pressed, marks the ones on the slide shown, and says where a press goes", () => {
    render(<Opener />);
    fireEvent.click(opener());
    const row = (name: string) => screen.getByRole("button", { name });
    expect(row("Bigger").getAttribute("aria-current")).toBe("true");
    expect(row("Add a chart").getAttribute("aria-current")).toBeNull();
    expect(tooltipOf(row("Add a chart"))).toBe("Go to this comment");
    fireEvent.click(row("Add a chart"));
    expect(useApp.getState()).toMatchObject({ selected: "outro", commentAsked: { slide: "outro", id: "c" } });
    expect(overview()).toBeNull();
  });

  it("hands every comment to the agent, and is off with none to hand over", () => {
    render(<Opener />);
    fireEvent.click(opener());
    const send = () => screen.getByRole("button", { name: "Send to agent" }) as HTMLButtonElement;
    expect(tooltipOf(send())).toBe(
      "Takes every comment along with your next message, and goes to the chat to write it",
    );
    fireEvent.click(send());
    expect(useApp.getState()).toMatchObject({ commentScope: "deck", sidebarTab: "chat" });
    expect(overview()).toBeNull();

    useApp.setState({ comments: {} });
    fireEvent.click(opener());
    expect(send().disabled).toBe(true);
    expect(tooltipOf(send())).toBeNull();
  });
});
