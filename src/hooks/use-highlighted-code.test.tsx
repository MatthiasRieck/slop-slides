import { act, render, waitFor } from "@testing-library/react";
import { useRef } from "react";
import { describe, expect, it } from "vitest";

import { loadHighlighter } from "../lib/highlighter";
import { type Place, placeElements } from "../test/intersection";
import { HIGHLIGHT_LIMIT, useHighlightedCode } from "./use-highlighted-code";
import { useSeen } from "./useSeen";

/** A block of code as the chat shows one: colored once it was near what shows, or (`always`) wherever it is. */
function Block({ name, code, always }: { name: string; code: string; always?: boolean }) {
  const ref = useRef<HTMLPreElement>(null);
  const seen = useSeen(ref);
  const lines = useHighlightedCode(code, "json", always ? undefined : seen);
  return (
    <pre ref={ref} data-block={name}>
      {lines.map((line, index) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: lines only come in at the end
        <span key={index} data-line>
          {line}
        </span>
      ))}
    </pre>
  );
}

/** Puts the blocks where `places` says, by name. */
const scroll = (places: Record<string, Place>) =>
  act(() =>
    placeElements((element) => {
      const name = (element as HTMLElement).dataset.block ?? "";
      return name in places ? places[name]! : 0;
    }),
  );

const block = (name: string) => document.querySelector<HTMLElement>(`[data-block=${name}]`)!;
/** Whether the block's code is colored: its lines are then made of the tokens' elements. */
const colored = (name: string) => block(name).querySelector("[data-line]")!.firstElementChild !== null;
/** Lets the grammar, which is loaded by now, reach the blocks that wait for it. */
const loaded = async () => {
  await act(async () => {
    await loadHighlighter("json");
  });
};

const CODE = '{ "a": 1,\n  "b": [true, null] }';

describe("useHighlightedCode", () => {
  it("colors the code that shows, and leaves what is far off plain although its grammar is loaded", async () => {
    await scroll({ shown: 0, next: 0.5, far: 6 });
    render(
      <>
        <Block name="shown" code={CODE} />
        <Block name="next" code={CODE} />
        <Block name="far" code={CODE} />
      </>,
    );
    await waitFor(() => expect(colored("shown")).toBe(true), { timeout: 5000 });
    // Within a screenful it is colored ahead of its showing.
    await waitFor(() => expect(colored("next")).toBe(true));
    await loaded();
    expect(colored("far")).toBe(false);
    for (const name of ["shown", "next", "far"]) expect(block(name).textContent).toBe(CODE.replace("\n", ""));
  });

  it("colors a block once it comes near, and keeps it colored when it has gone again", async () => {
    await scroll({ far: 6 });
    render(<Block name="far" code={CODE} />);
    await loaded();
    expect(colored("far")).toBe(false);
    await scroll({ far: 0.5 });
    await waitFor(() => expect(colored("far")).toBe(true));
    await scroll({ far: 6 });
    await loaded();
    expect(colored("far")).toBe(true);
  });

  it("keeps the lines it colored as code comes in at the end", async () => {
    const { rerender } = render(<Block name="b" code={'{ "a": 1,\n'} />);
    await waitFor(() => expect(colored("b")).toBe(true), { timeout: 5000 });
    const first = block("b").querySelector("[data-line]")!.firstElementChild;
    rerender(<Block name="b" code={'{ "a": 1,\n  "b": 2 }'} />);
    expect(block("b").querySelectorAll("[data-line]")).toHaveLength(2);
    expect(block("b").querySelector("[data-line]")!.firstElementChild).toBe(first);
    expect(block("b").textContent).toBe('{ "a": 1,  "b": 2 }');
  });

  it("leaves code longer than it is worth coloring plain", async () => {
    const long = `[${"1, ".repeat(HIGHLIGHT_LIMIT / 3)}1]`;
    render(<Block name="long" code={long} />);
    await loaded();
    await act(async () => {});
    expect(colored("long")).toBe(false);
    expect(block("long").textContent).toBe(long);
  });

  it("colors when it is not told otherwise", async () => {
    await scroll({ far: 6 });
    render(<Block always name="far" code={CODE} />);
    await waitFor(() => expect(colored("far")).toBe(true), { timeout: 5000 });
  });
});
