// Dev-only Vite plugin: lets the UI run in a plain browser (no Tauri) against the real deck
// library, read-only. Used for visual checks; the desktop app uses the `slop://` protocol.
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Plugin } from "vite";

const library = path.join(os.homedir(), "Documents", "SlopSlide");
const hash = (text: string) => createHash("sha1").update(text).digest("hex").slice(0, 12);

// Approximates src-tauri/src/html.rs: good enough for previews of well-formed decks.
function readDeck(id: string) {
  const dir = path.join(library, id);
  const file = path.join(dir, "deck.html");
  const html = fs.readFileSync(file, "utf8");
  const slides = [...html.matchAll(/<section\b[^>]*\bclass=["'][^"']*\bslide\b[^"']*["'][^>]*>/gi)].map(
    (match, index) => {
      const id = /\bid=["']([^"']+)["']/i.exec(match[0])?.[1] ?? `#${index + 1}`;
      const hidden = /\sdata-hidden\b/i.test(match[0]);
      return { id, hash: hash(html.slice(match.index, html.indexOf("</section>", match.index))), hidden };
    },
  );
  const title = /<title>([^<]*)<\/title>/i.exec(html)?.[1] ?? id;
  return { id, title, path: dir, slides, shellHash: hash(html), updatedMs: fs.statSync(file).mtimeMs };
}

export function browserPreview(): Plugin {
  return {
    name: "slopslide-browser-preview",
    apply: "serve",
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const url = new URL(req.url ?? "/", "http://x");
        if (url.pathname === "/__api/decks") {
          const decks = fs.existsSync(library)
            ? fs
                .readdirSync(library)
                .filter((id) => fs.existsSync(path.join(library, id, "deck.html")))
                .map(readDeck)
            : [];
          res.setHeader("content-type", "application/json");
          return res.end(JSON.stringify(decks));
        }
        if (!url.pathname.startsWith("/__deck/")) return next();
        const file = path.resolve(library, decodeURIComponent(url.pathname.slice("/__deck/".length)));
        if (!file.startsWith(library + path.sep) || !fs.existsSync(file)) {
          res.statusCode = 404;
          return res.end();
        }
        if (file.endsWith(".html")) res.setHeader("content-type", "text/html; charset=utf-8");
        fs.createReadStream(file).pipe(res);
      });
    },
  };
}
