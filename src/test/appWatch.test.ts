import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { createServer } from "vite";
import { describe, expect, it } from "vitest";

import { ignoreDeckHtml } from "../../dev/appWatch";

describe("development deck saves", () => {
  it("ignores deck HTML, including nested index.html, while keeping the app shell and source live", () => {
    const ignored = ignoreDeckHtml("/project/index.html");
    expect(ignored("/project/examples/motion/deck.html")).toBe(true);
    expect(ignored("/project/my-deck/index.html")).toBe(true);
    expect(ignored("/project/index.html")).toBe(false);
    expect(ignored("/project/src/components/Stage.tsx")).toBe(false);
    expect(ignored("/project/examples/motion")).toBe(false);
  });

  it("saving a moved element cannot send Vite's full reload to the app", async () => {
    const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "slopslide-watch-")));
    const entry = path.join(root, "index.html");
    const deck = path.join(root, "deck.html");
    await writeFile(entry, "<html><body>App</body></html>");
    await writeFile(deck, '<section class="slide">Before</section>');
    const server = await createServer({
      configFile: false,
      root,
      server: {
        middlewareMode: true,
        ws: false,
        watch: { usePolling: true, interval: 20, ignored: [ignoreDeckHtml(entry)] },
      },
    });
    try {
      const events: string[] = [];
      server.watcher.on("change", (file) => events.push(file));
      await new Promise<void>((resolve) => server.watcher.on("ready", resolve));
      // The deck is excluded from the watcher, not merely suppressed in the UI.
      const watched = () =>
        Object.entries(server.watcher.getWatched()).flatMap(([dir, files]) =>
          files.map((file) => path.join(dir, file)),
        );
      await expect.poll(watched).toContain(entry);
      expect(watched()).not.toContain(deck);
      await writeFile(deck, '<section class="slide"><p style="translate:10px 20px">Moved</p></section>');
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("App shell watcher did not respond")), 5000);
        server.watcher.on("change", (file) => {
          if (file === entry) {
            clearTimeout(timer);
            resolve();
          }
        });
        void writeFile(entry, "<html><body>Updated app</body></html>").catch(reject);
      });
      expect(events).not.toContain(deck);
    } finally {
      await server.close();
      await rm(root, { recursive: true, force: true });
    }
  }, 15000);
});
