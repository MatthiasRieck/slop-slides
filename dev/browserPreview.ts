// Dev-only Vite plugin: lets the UI run in a plain browser (no Tauri) against the real deck
// library, read-only. Used for visual checks; the desktop app uses the `slop://` protocol.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Plugin } from "vite";

const library = path.join(os.homedir(), "Documents", "SlopSlide");
const stage = (name: string) => fs.readFileSync(path.join(import.meta.dirname, "../src-tauri/assets", name), "utf8");

function readDeck(id: string) {
  const dir = path.join(library, id);
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, "deck.json"), "utf8"));
  const slides = (manifest.slides ?? []).filter((s: string) => fs.existsSync(path.join(dir, s)));
  return { id, dir, title: manifest.title, slides, mtime: fs.statSync(path.join(dir, "deck.json")).mtimeMs };
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
            ? fs.readdirSync(library).filter((id) => fs.existsSync(path.join(library, id, "deck.json"))).map(readDeck)
            : [];
          res.setHeader("content-type", "application/json");
          return res.end(JSON.stringify(decks));
        }
        if (!url.pathname.startsWith("/__deck/")) return next();
        const rel = decodeURIComponent(url.pathname.slice("/__deck/".length));
        const file = path.resolve(library, rel);
        if (!file.startsWith(library + path.sep) || !fs.existsSync(file)) {
          res.statusCode = 404;
          return res.end();
        }
        if (file.endsWith(".html")) {
          const html = fs.readFileSync(file, "utf8");
          const snippet = `<style>${stage("stage.css")}</style><script>${stage("stage.js")}</script>`;
          const at = html.search(/<head[^>]*>/i);
          const out = at >= 0 ? html.replace(/<head[^>]*>/i, (m) => m + snippet) : snippet + html;
          res.setHeader("content-type", "text/html; charset=utf-8");
          return res.end(out);
        }
        if (file.endsWith(".css")) res.setHeader("content-type", "text/css");
        fs.createReadStream(file).pipe(res);
      });
    },
  };
}
