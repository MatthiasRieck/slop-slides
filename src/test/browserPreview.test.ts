// @vitest-environment node
/**
 * The scripts the dev-only browser preview (dev/browserPreview.ts) adds to a deck page, which
 * mirror src-tauri/src/protocol.rs.
 */
import { describe, expect, it } from "vitest";

import { pageFor, scriptTags, singleSlide, stageScriptAt, stageScripts } from "../../dev/browserPreview";
import OVERFLOW from "../../src-tauri/assets/overflow.js?raw";
import PASTEBOARD from "../../src-tauri/assets/pasteboard.js?raw";
import RUNTIME from "../../src-tauri/assets/runtime.js?raw";
import { openDeck } from "./deckDom";
import { EDITOR } from "./editorSource";
import DECK from "./fixtures/single-slide/deck.html?raw";
import SECOND from "./fixtures/single-slide/second.html?raw";
import SECOND_EDITED from "./fixtures/single-slide/second-edited.html?raw";

const scripts = (query: string) => stageScripts(new URLSearchParams(query));
const sources = (query: string) => scripts(query).map((script) => script.source);

describe("browser preview scripts", () => {
  it("adds the pasteboard to pan, the show and edit, and overflow detection with the editor to edit", () => {
    expect(sources("embed&slide=a&edit=0")).toEqual([PASTEBOARD, OVERFLOW + EDITOR]);
    expect(sources("edit&pan")).toEqual([PASTEBOARD, OVERFLOW + EDITOR]);
    expect(sources("embed&slide=a&pan")).toEqual([PASTEBOARD]);
    expect(sources("show")).toEqual([PASTEBOARD]);
    expect(sources("embed&slide=edit&static")).toEqual([]);
    expect(sources("")).toEqual([]);
  });

  it("gives edit mode what the editor needs to run", () => {
    const posted: { type: string }[] = [];
    const window = openDeck(
      '<!DOCTYPE html><html><head></head><body><main class="deck"><section class="slide" id="intro"><h1>Hi</h1></section></main></body></html>',
      {
        url: "https://example.test/deck.html?embed&slide=intro&static&edit=0",
        size: [1920, 1080],
        parent: { postMessage: (data: { type: string }) => posted.push(data) },
        visual: true,
        scripts: [RUNTIME, ...sources("embed&slide=intro&static&edit=0")],
      },
    );
    expect(window.document.querySelector("[data-slop-ui]")).not.toBeNull();
    // The editor's last statement before it waits for the slide to show reports the slide's
    // background: it ran to its end.
    expect(posted.map((m) => m.type)).toContain("slop:edit-background");
  });

  it("loads the scripts by tag, in order, from addresses that serve them", () => {
    const tags = scriptTags(scripts("embed&slide=a&edit=0"));
    const addresses = [...tags.matchAll(/<script src="([^"]+)"><\/script>\n/g)].map((match) => match[1]!);
    expect(addresses.map((address) => address.split("/").at(-1))).toEqual(["pasteboard.js", "editor.js"]);
    expect(tags.replace(/<script src="[^"]+"><\/script>\n/g, "")).toBe("");
    // Plain scripts: they run where they stand, after the player, as the inlined ones did.
    expect(tags).not.toMatch(/defer|async|module/);
    expect(addresses.map(stageScriptAt)).toEqual([PASTEBOARD, OVERFLOW + EDITOR]);
    // One version for them all: the pasteboard finds the editor beside its own address.
    expect(addresses[1]).toBe(addresses[0]!.replace("pasteboard.js", "editor.js"));
    expect(stageScriptAt("/__deck/.app/0000000000000000/editor.js")).toBeNull();
    expect(stageScriptAt(addresses[0]!.replace("pasteboard.js", "other.js"))).toBeNull();
  });

  it("puts the tags at the end of the body instead of the scripts' source", () => {
    const html = '<html><body><main class="deck"></main><script>player</script></BODY></html>';
    const page = pageFor(html, new URLSearchParams("embed&slide=a&edit=0"));
    expect(page.indexOf("player")).toBeLessThan(page.indexOf("/pasteboard.js"));
    expect(page.indexOf("/pasteboard.js")).toBeLessThan(page.indexOf("/editor.js"));
    expect(page.indexOf("/editor.js")).toBeLessThan(page.indexOf("</BODY>"));
    expect(page.length).toBeLessThan(html.length + 300);
    expect(pageFor(html, new URLSearchParams("static"))).toBe(html);
  });
});

describe("browser preview: one slide for a preview", () => {
  it("cuts the shared example exactly as the app does", () => {
    // src-tauri/src/html/single.rs is held to the same two files.
    expect(singleSlide(DECK, "#2")).toBe(SECOND);
    expect(singleSlide(SECOND, "#2")).toBe(SECOND);
    expect(singleSlide(DECK, "#2", true)).toBe(SECOND_EDITED);
  });

  it("keeps every id of the deck in the stage's pages, which the editor comes to, and only there", () => {
    const edited = pageFor(DECK, new URLSearchParams("embed&slide=end&v=1&static&pan&edit=0"));
    expect(edited).toContain(`<i id="el-1"></i><i ID='logo'></i></section>`);
    expect(edited).toContain("<i id=clip></i></section>");
    expect(edited).not.toContain("assets/logo.png");
    expect(pageFor(DECK, new URLSearchParams("embed&slide=end&v=1&pan"))).toContain("<i id=clip></i></section>");
    const thumbnail = pageFor(DECK, new URLSearchParams("embed&slide=end&v=1&static"));
    expect(thumbnail).not.toContain("<i ");
  });

  it("keeps the slide a preview names, by id or position, as the player finds it", () => {
    const whole = (reference: string) => {
      const page = singleSlide(DECK, reference);
      return ["logo.png", "second.png", "plan.mp4", "Bye"].filter((mark) => page.includes(mark));
    };
    expect(whole("intro")).toEqual(["logo.png"]);
    expect(whole("plan")).toEqual(["plan.mp4"]);
    expect(whole("end")).toEqual(["Bye"]);
    expect(whole("#2")).toEqual(["second.png"]);
    expect(whole("#99")).toEqual(["Bye"]);
    expect(whole("#0")).toEqual(["logo.png"]);
    expect(whole("unknown")).toEqual(["logo.png"]);
    expect(whole("")).toEqual(["logo.png"]);
    expect(whole("in-script")).toEqual(["logo.png"]);
  });

  it("serves a preview its slide alone and the show the whole deck", () => {
    const preview = pageFor(DECK, new URLSearchParams("embed&slide=plan&v=1&static"));
    expect(preview).toContain("assets/plan.mp4");
    expect(preview).not.toContain("assets/logo.png");
    expect(preview).not.toContain("assets/cover.jpg");
    expect(preview).toContain("assets/odd.png");
    expect(pageFor(DECK, new URLSearchParams("v=1&show"))).toContain("assets/logo.png");
    expect(pageFor(DECK, new URLSearchParams("slide=plan"))).toBe(DECK);
    expect(singleSlide("<html><body><p>Page</p></body></html>", "a")).toBe("<html><body><p>Page</p></body></html>");
  });
});
