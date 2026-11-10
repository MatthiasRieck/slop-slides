// @vitest-environment node
/**
 * The scripts the dev-only browser preview (dev/browserPreview.ts) adds to a deck page, which
 * mirror src-tauri/src/protocol.rs.
 */
import { describe, expect, it } from "vitest";

import { stageScripts } from "../../dev/browserPreview";
import OVERFLOW from "../../src-tauri/assets/overflow.js?raw";
import PASTEBOARD from "../../src-tauri/assets/pasteboard.js?raw";
import RUNTIME from "../../src-tauri/assets/runtime.js?raw";
import { openDeck } from "./deckDom";
import { EDITOR } from "./editorSource";

const scripts = (query: string) => stageScripts(new URLSearchParams(query));

describe("browser preview scripts", () => {
  it("adds the pasteboard to pan, the show and edit, and overflow detection with the editor to edit", () => {
    expect(scripts("embed&slide=a&edit=0")).toEqual([PASTEBOARD, OVERFLOW + EDITOR]);
    expect(scripts("edit&pan")).toEqual([PASTEBOARD, OVERFLOW + EDITOR]);
    expect(scripts("embed&slide=a&pan")).toEqual([PASTEBOARD]);
    expect(scripts("show")).toEqual([PASTEBOARD]);
    expect(scripts("embed&slide=edit&static")).toEqual([]);
    expect(scripts("")).toEqual([]);
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
        scripts: [RUNTIME, ...scripts("embed&slide=intro&static&edit=0")],
      },
    );
    expect(window.document.querySelector("[data-slop-ui]")).not.toBeNull();
    // The editor's last statements report the deck's fonts: it ran to its end.
    expect(posted.map((m) => m.type)).toContain("slop:edit-fonts");
  });
});
