// @vitest-environment node
/**
 * The PDF export helper (src-tauri/assets/pdf.js), run by the app in the hidden window that
 * prints a deck. It answers each step by navigating to /.pdf-signal?<answer>.
 */
import { describe, expect, it, vi } from "vitest";

import PDF_JS from "../../src-tauri/assets/pdf.js?raw";
import { openHelper } from "./deckDom";

const DECK = `<!DOCTYPE html><html><head></head><body>
<main class="deck">
  <section class="slide" id="intro"><h1 class="clip">Title</h1><p>Body</p></section>
  <section class="slide" data-hidden><p>Hidden</p></section>
  <section class="slide" id="end"><p>End</p></section>
</main></body></html>`;

interface Helper {
  ready: () => void;
  fit: (width: number, height: number) => void;
  decor: () => void;
  show: (index: number) => void;
  paint: (index: number, url: string) => void;
  text: () => void;
  notes: (pages: { slide: number; label: string; text: string }[]) => void;
}

/** Loads the deck, runs the helper, and records its answers instead of navigating. */
function helper() {
  return openHelper<Helper>(DECK, "Pdf", {
    setup(window) {
      // Text filled with its background, as gradient headings do.
      const style = window.document.createElement("style");
      style.textContent = ".clip { background-clip: text; }";
      window.document.head.appendChild(style);
    },
    scripts: [PDF_JS],
  });
}

describe("PDF helper", () => {
  it("reports when the deck is ready, with the number of shown slides", async () => {
    const { answers, settle } = helper();
    await settle();
    expect(answers).toEqual(["ready&slides=2"]);
  });

  it("keeps captured decor when a canceled navigation reinjects the helper", async () => {
    const { window, doc, api, answers, settle } = helper();
    await settle();
    api.decor();
    api.paint(0, "data:image/png;base64,AAA");
    window.eval(PDF_JS);
    await settle();
    const current = (window as unknown as { __slopPdf: Helper }).__slopPdf;
    expect(current).toBe(api);
    expect(answers).toEqual(["ready&slides=2", "decor"]);
    current.paint(1, "data:image/png;base64,BBB");
    current.text();
    await settle();
    expect(answers.at(-1)).toBe("text");
    expect(doc.documentElement.getAttribute("data-slop-pdf")).toBe("text");
    expect((doc.getElementById("intro") as HTMLElement).style.background).toContain("data:image/png;base64,AAA");
    expect((doc.getElementById("end") as HTMLElement).style.background).toContain("data:image/png;base64,BBB");
  });

  it("prints slides the size of the paper they get", async () => {
    const { doc, api, answers, settle } = helper();
    await settle();
    api.fit(794, 1122);
    expect(answers.at(-1)).toBe("fit");
    const css = doc.querySelector("style[data-slop-pdf-fit]")!.textContent!;
    expect(css).toContain("@media print");
    expect(css).toContain("--slop-w: 794px !important; --slop-h: 1122px !important;");
    expect(css).toContain("@page { size: 794px 1122px; margin: 0; }");
  });

  it("puts a page of speaker notes after each printed slide that has them, in print only", async () => {
    const { doc, api, answers, settle } = helper();
    await settle();
    api.notes([
      { slide: 0, label: "Notes for slide 1", text: "Greet the room\n<b>not markup</b>" },
      { slide: 1, label: "Notes for slide 2", text: "Thank everyone" },
      { slide: 7, label: "Notes for slide 8", text: "No such slide" },
    ]);
    expect(answers.at(-1)).toBe("notes");
    const order = [...doc.querySelectorAll(".deck > *")].map((el) => el.id || el.className);
    // The hidden slide is no printed slide: the second page of notes follows the last slide.
    expect(order).toEqual(["intro", "slop-pdf-notes", "slide", "end", "slop-pdf-notes"]);
    const [first, second] = [...doc.querySelectorAll(".slop-pdf-notes")];
    expect(first!.querySelector("h2")!.textContent).toBe("Notes for slide 1");
    expect(first!.querySelector("p")!.textContent).toBe("Greet the room\n<b>not markup</b>");
    expect(first!.querySelector("b")).toBeNull();
    expect(second!.querySelector("p")!.textContent).toBe("Thank everyone");
    const css = doc.querySelector("style[data-slop-pdf-notes]")!.textContent!;
    expect(css).toMatch(/^\.slop-pdf-notes \{ display: none; \}/);
    expect(css).toContain("@media print");
    expect(css).toContain("break-after: page");
    // The slides the PDF counts and captures are still the slides alone.
    api.show(1);
    await settle();
    expect(new URLSearchParams(answers.at(-1)).get("shown")).toBe("1");
    expect(doc.getElementById("end")!.classList.contains("active")).toBe(true);
  });

  it("hides the text for the decor, keeping currentColor for borders and icons", async () => {
    const { doc, api, answers, settle } = helper();
    await settle();
    api.decor();
    expect(answers.at(-1)).toBe("decor");
    expect(doc.documentElement.getAttribute("data-slop-pdf")).toBe("decor");
    const css = doc.querySelector("style[data-slop-pdf]")!.textContent!;
    expect(css).toContain("-webkit-text-fill-color: transparent !important");
    expect(css).toContain("text-shadow: none !important");
    expect(css).not.toMatch(/\n {2}color: transparent/);
    expect(doc.querySelector("h1")!.hasAttribute("data-slop-pdf-cliptext")).toBe(true);
    expect(doc.querySelector("p")!.hasAttribute("data-slop-pdf-cliptext")).toBe(false);
  });

  it("shows one slide at a time, skipping hidden slides, and reports where it is", async () => {
    const { window, doc, api, answers, settle } = helper();
    await settle();
    const resized = vi.fn();
    window.addEventListener("resize", resized);
    api.show(1);
    await settle();
    const slides = [...doc.querySelectorAll(".deck > .slide")];
    expect(slides.map((s) => s.classList.contains("active"))).toEqual([false, false, true]);
    expect(resized).toHaveBeenCalled();
    const answer = new URLSearchParams(answers.at(-1));
    expect(answer.get("shown")).toBe("1");
    expect(answer.get("rect")).toBe("0,0,0,0");
    expect(answer.get("view")).toBe(`${window.innerWidth},${window.innerHeight}`);
  });

  it("prints each slide's decor image behind its text, and nothing else", async () => {
    const { doc, api, answers, settle } = helper();
    await settle();
    api.decor();
    api.paint(0, "data:image/png;base64,AAA");
    api.paint(1, "data:image/png;base64,BBB");
    api.text();
    await settle();
    expect(answers.at(-1)).toBe("text");
    expect(doc.documentElement.getAttribute("data-slop-pdf")).toBe("text");
    const [intro, hidden, end] = [...doc.querySelectorAll<HTMLElement>(".deck > .slide")];
    expect(intro!.style.getPropertyValue("background")).toContain("data:image/png;base64,AAA");
    expect(intro!.style.getPropertyPriority("background")).toBe("important");
    expect(hidden!.style.getPropertyValue("background")).toBe("");
    expect(end!.style.getPropertyValue("background")).toContain("data:image/png;base64,BBB");
    const css = doc.querySelector("style[data-slop-pdf]")!.textContent!;
    expect(css).toContain('html[data-slop-pdf="text"] *:not([data-slop-pdf-cliptext])');
    expect(css).toContain("background-image: none !important");
    expect(css).toContain("visibility: hidden !important");
  });
});
