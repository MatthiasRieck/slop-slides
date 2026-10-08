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
  const slideTags = [...html.matchAll(/<section\b[^>]*\bclass=["'][^"']*\bslide\b[^"']*["'][^>]*>/gi)];
  const slides = slideTags.map((match, index) => {
    const id = /\bid=["']([^"']+)["']/i.exec(match[0])?.[1] ?? `#${index + 1}`;
    const hidden = /\sdata-hidden\b/i.test(match[0]);
    const source = html.slice(match.index, html.indexOf("</section>", match.index));
    return { id, hash: hash(source), hidden, moved: /<[^>]*\sdata-moved\b/i.test(source) };
  });
  const sections = [...html.matchAll(/<div\b[^>]*\bclass=["'][^"']*\bdeck-section\b[^"']*["'][^>]*>/gi)].map(
    (match, index) => ({
      index,
      title: /\bdata-title=["']([^"']*)["']/i.exec(match[0])?.[1] ?? "",
      before: slideTags.filter((slide) => slide.index < match.index).length,
    }),
  );
  const title = /<title>([^<]*)<\/title>/i.exec(html)?.[1] ?? id;
  return { id, title, path: dir, slides, sections, shellHash: hash(html), updatedMs: fs.statSync(file).mtimeMs };
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
        if (file.endsWith(".html")) {
          res.setHeader("content-type", "text/html; charset=utf-8");
          // Like src-tauri/src/protocol.rs: `?pan` and `?show` add the pasteboard, `?edit` the
          // slide editor on top of it.
          const { searchParams: q } = url;
          const names = [
            "image-menu.js",
            ...(q.has("pan") || q.has("show") || q.has("edit") ? ["pasteboard.js"] : []),
            ...(q.has("edit") ? ["editor.js"] : []),
          ];
          if (names.length > 0) {
            const scripts = names
              .map((name) => `<script>\n${fs.readFileSync(new URL(`../src-tauri/assets/${name}`, import.meta.url), "utf8")}</script>\n`)
              .join("");
            const html = fs.readFileSync(file, "utf8");
            const at = html.toLowerCase().lastIndexOf("</body");
            return res.end(at < 0 ? html + scripts : html.slice(0, at) + scripts + html.slice(at));
          }
        }
        fs.createReadStream(file).pipe(res);
      });
    },
  };
}
