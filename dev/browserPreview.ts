// Dev-only Vite plugin: lets the UI run in a plain browser (no Tauri) against the real deck
// library as its only workspace, read-only. Used for visual checks; the desktop app uses the
// `slop://` protocol.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Plugin } from "vite";

const library = path.join(os.homedir(), "Documents", "SlopSlide");
const userTemplates = path.join(os.homedir(), ".slopslides", "templates");
const builtinTemplates = new URL("../src-tauri/templates/", import.meta.url);
const asset = (name: string) => fs.readFileSync(new URL(`../src-tauri/assets/${name}`, import.meta.url), "utf8");

/** The slide editor: the parts in src-tauri/assets/editor/, joined in the order of their names, as src-tauri/build.rs joins them. */
export function editorScript(): string {
  const dir = new URL("../src-tauri/assets/editor/", import.meta.url);
  return fs
    .readdirSync(dir)
    .filter((name) => name.endsWith(".js"))
    .sort()
    .map((name) => fs.readFileSync(new URL(name, dir), "utf8"))
    .join("");
}

/** One of the app's own scripts for a deck page, by the name it is served under. */
export interface StageScript {
  name: string;
  source: string;
}

/**
 * Like `for_query` in src-tauri/src/protocol/scripts.rs: the scripts a deck page gets for its
 * query, in the order they run. `?pan` and `?show` add the pasteboard; `?edit` adds it too, then
 * overflow detection with the slide editor, which needs it, in one script.
 */
export function stageScripts(query: URLSearchParams): StageScript[] {
  const edit = query.has("edit");
  return [
    ...(edit || query.has("pan") || query.has("show")
      ? [{ name: "pasteboard.js", source: asset("pasteboard.js") }]
      : []),
    ...(edit ? [{ name: "editor.js", source: asset("overflow.js") + editorScript() }] : []),
  ];
}

/** First path segment of the app's scripts, as in src-tauri/src/protocol/scripts.rs. */
const APP_PREFIX = ".app";

/** What a script is, as a few hex digits: the version in its address, which is kept for good. */
const scriptVersion = (script: StageScript) => createHash("sha1").update(script.source).digest("hex").slice(0, 16);

/**
 * Like `tags` in src-tauri/src/protocol/scripts.rs: the tags that load `scripts`, each from an
 * address of its own that carries its version. Plain scripts, neither deferred nor asynchronous:
 * each runs where it stands, in order, as the page is read, right after the player.
 */
export function scriptTags(scripts: StageScript[]): string {
  return scripts
    .map((script) => `<script src="/__deck/${APP_PREFIX}/${scriptVersion(script)}/${script.name}"></script>\n`)
    .join("");
}

/** The script served at `/__deck/.app/<version>/<name>`; null for another version or name. */
export function stageScriptAt(pathname: string): string | null {
  const [, version, name] = /^\/__deck\/\.app\/([^/]+)\/([^/]+)$/.exec(pathname) ?? [];
  const all = stageScripts(new URLSearchParams("edit"));
  return all.find((script) => script.name === name && scriptVersion(script) === version)?.source ?? null;
}

/** A quoted or bare attribute value, as the first of its three groups that matched. */
const VALUE = String.raw`(?:"([^"]*)"|'([^']*)'|([^\s>]+))`;
const attribute = (tag: string, name: string) => {
  const found = new RegExp(String.raw`\s${name}\s*=\s*${VALUE}`, "i").exec(tag);
  return found ? (found[1] ?? found[2] ?? found[3] ?? "") : null;
};

/** The top-level slides of `html`: where each starts and ends, its opening tag and its id. */
function slideSpans(html: string) {
  // Comments and the text of scripts and styles are skipped whole; what is left are the tags.
  const scan =
    /<!--[\s\S]*?(?:-->|$)|<(script|style|textarea|title)\b[^>]*>[\s\S]*?(?=<\/\1|$)|<(\/?)section\b(?:"[^"]*"|'[^']*'|[^>"'])*>/gi;
  const slides: { start: number; end: number; open: string; id: string | null }[] = [];
  let open: { start: number; tag: string; depth: number } | null = null;
  for (const match of html.matchAll(scan)) {
    if (!/^<\/?section/i.test(match[0])) continue;
    const closing = match[2] === "/";
    if (open && !closing) open.depth++;
    else if (open && open.depth > 0) open.depth--;
    else if (open) {
      slides.push({
        start: open.start,
        end: match.index + match[0].length,
        open: open.tag,
        id: attribute(open.tag, "id"),
      });
      open = null;
    } else if (!closing && (attribute(match[0], "class") ?? "").split(/\s+/).includes("slide")) {
      open = { start: match.index, tag: match[0], depth: 0 };
    }
  }
  return slides;
}

/** The ids written inside a slide's markup (not on scripts or styles, nor in comments), each as it is written. */
function idsWithin(markup: string): string[] {
  const scan =
    /<!--[\s\S]*?(?:-->|$)|<(script|style|textarea|title)\b[^>]*>[\s\S]*?(?=<\/\1|$)|<[a-z][^\s/>]*(?:"[^"]*"|'[^']*'|[^>"'])*>/gi;
  const written = new RegExp(String.raw`(?<=\s)id\s*=\s*${VALUE}`, "i");
  return [...markup.matchAll(scan)].flatMap((match) => {
    const id = /^<[a-z]/i.test(match[0]) && !match[1] ? written.exec(match[0]) : null;
    return id && (id[1] ?? id[2] ?? id[3]) ? [id[0]] : [];
  });
}

/**
 * Like `single_slide` in src-tauri/src/html/single.rs: `html` with only the slide `reference`
 * names (an id, or a position as `#3`) left whole. Each other slide stays as its opening tag,
 * without a `style` that loads something, and `</section>`, so the slides keep their count and
 * places; with `ids`, for the slide editor, it also holds an empty element for each id that was
 * in it. Both are held to the same example (src/test/fixtures/single-slide).
 */
export function singleSlide(html: string, reference: string, ids = false): string {
  const slides = slideSpans(html);
  if (slides.length === 0) return html;
  // As the player's `indexFor` (src-tauri/assets/runtime.js) finds it.
  const byId = reference ? slides.findIndex((slide) => slide.id === reference) : 0;
  const position = Number.parseInt(reference.replace(/^#/, ""), 10);
  const fallback = Number.isNaN(position) ? 0 : Math.min(slides.length - 1, Math.max(0, position - 1));
  const kept = byId >= 0 ? byId : fallback;
  let out = "";
  let at = 0;
  slides.forEach((slide, index) => {
    out += html.slice(at, slide.start);
    if (index === kept) out += html.slice(slide.start, slide.end);
    else {
      const style = attribute(slide.open, "style");
      const loads = style?.includes("url(") ?? false;
      const tag = loads ? slide.open.replace(new RegExp(String.raw`(?<=\s)style\s*=\s*${VALUE}`, "i"), "") : slide.open;
      const inside = html.slice(slide.start + slide.open.length, slide.end);
      const holders = ids ? idsWithin(inside).map((id) => `<i ${id}></i>`) : [];
      out += `${tag}${holders.join("")}</section>`;
    }
    at = slide.end;
  });
  return out + html.slice(at);
}

/**
 * Like `page_for` in src-tauri/src/protocol.rs: a deck page as its frame asked for it, cut down
 * to the one slide a preview shows (`embed` with `slide`) and with the tags of the app's scripts
 * for the stage and the show.
 */
export function pageFor(html: string, query: URLSearchParams): string {
  const slide = query.has("embed") ? query.get("slide") : null;
  const page = slide === null ? html : singleSlide(html, slide, query.has("edit"));
  const added = stageScripts(query);
  return added.length > 0 ? beforeBodyEnd(page, scriptTags(added)) : page;
}

/** Like src-tauri/src/templates.rs: the user's templates first, then the built-in ones they do not replace. */
function listTemplates() {
  const read = (id: string, file: string, builtin: boolean) => {
    const html = fs.readFileSync(file, "utf8");
    const slides = [...html.matchAll(/<section\b[^>]*\bclass=["'][^"']*\bslide\b[^"']*["'][^>]*>/gi)].flatMap(
      (m) => /\bid=["']([^"']+)["']/i.exec(m[0])?.[1] ?? [],
    );
    const title = /<title>([^<]*)<\/title>/i.exec(html)?.[1] ?? id;
    return { id, title, builtin, path: builtin ? null : path.dirname(file), slides };
  };
  const own = fs.existsSync(userTemplates)
    ? fs
        .readdirSync(userTemplates)
        .filter((id) => !id.startsWith(".") && fs.existsSync(path.join(userTemplates, id, "deck.html")))
        .map((id) => read(id, path.join(userTemplates, id, "deck.html"), false))
    : [];
  const builtin = fs
    .readdirSync(builtinTemplates)
    .filter((f) => f.endsWith(".html"))
    .map((f) => f.slice(0, -5))
    .filter((id) => !own.some((t) => t.id === id))
    .map((id) => read(id, new URL(`${id}.html`, builtinTemplates).pathname, true));
  return [...own, ...builtin];
}

/** `html` with `scripts` (markup) at the end of its body, as the app adds them to a page it serves. */
function beforeBodyEnd(html: string, scripts: string): string {
  const at = html.toLowerCase().lastIndexOf("</body");
  return at < 0 ? html + scripts : html.slice(0, at) + scripts + html.slice(at);
}

/** A template's deck.html with the player runtime, as the app serves it. */
function templateHtml(id: string): string | null {
  const own = path.join(userTemplates, id, "deck.html");
  const builtin = new URL(`${id}.html`, builtinTemplates).pathname;
  const file =
    !id.includes("/") && fs.existsSync(own) ? own : !id.includes("/") && fs.existsSync(builtin) ? builtin : null;
  if (!file) return null;
  const html = fs.readFileSync(file, "utf8");
  if (html.includes("slopslide:runtime-js")) return html;
  const css = `<style>\n${asset("runtime.css")}</style><script>document.documentElement.setAttribute("data-slop-player", "");</script>`;
  const withCss = html.replace(/<head[^>]*>/i, (head) => head + css);
  return beforeBodyEnd(withCss, `<script>\n${asset("runtime.js")}</script>`);
}
/** Roughly src-tauri/src/git.rs: a file as of the last commit; null when it has none. */
function atHead(file: string): Buffer | null {
  try {
    const dir = path.dirname(file);
    return execFileSync("git", ["cat-file", "blob", `HEAD:./${path.basename(file)}`], {
      cwd: dir,
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    return null;
  }
}

/** Slides by id, with their markup. */
const slidesOf = (html: string) =>
  [...html.matchAll(/<section\b[^>]*\bid="([^"]+)"[^>]*>[\s\S]*?<\/section>/g)].map((m) => ({
    id: m[1]!,
    markup: m[0],
  }));

/** Roughly src-tauri/src/git.rs: the slides by id, the removed ones after the slide they followed. */
function deckChanges(file: string) {
  const committed = atHead(file)?.toString("utf8");
  const none = {
    branch: null,
    detached: false,
    commit: null,
    stylesChanged: false,
    oldSize: null,
    stylesStaged: false,
    stagedFiles: 0,
    stagedElsewhere: 0,
    hasUnstaged: true,
  };
  const now = slidesOf(fs.readFileSync(file, "utf8"));
  const row = (status: string, id: string | null, oldId: string | null) => ({
    key: id ?? `removed:${oldId}`,
    status,
    id,
    oldId,
    details: [],
    textChanges: [],
    moved: false,
    oldNumber: null,
    staged: false,
    moveStaged: false,
  });
  if (committed === undefined) {
    return { ...none, tracking: "notCommitted", slides: now.map((s) => row("added", s.id, null)) };
  }
  const old = slidesOf(committed);
  const rows = now.map((slide) => {
    const before = old.find((s) => s.id === slide.id);
    const status = !before ? "added" : before.markup === slide.markup ? "unchanged" : "modified";
    return row(status, slide.id, before?.id ?? null);
  });
  old.forEach((slide, index) => {
    if (now.some((s) => s.id === slide.id)) return;
    const after = rows.findIndex((r) => r.id === old[index - 1]?.id);
    rows.splice(after + 1, 0, row("removed", null, slide.id));
  });
  const subject = execFileSync("git", ["log", "-1", "--format=%h%x00%ct%x00%s"], { cwd: path.dirname(file) });
  const [hash, time, title] = subject.toString("utf8").trim().split("\0");
  return { ...none, tracking: "committed", commit: { hash, subject: title, time: Number(time) }, slides: rows };
}

const hash = (text: string) => createHash("sha1").update(text).digest("hex").slice(0, 12);

/** A workspace-relative path inside the library; null for anything outside it. */
function inLibrary(rel: string): string | null {
  const file = path.resolve(library, rel);
  return file === library || file.startsWith(library + path.sep) ? file : null;
}

type Kind = "directory" | "deck" | "slideshow" | "webpage" | "file";

// Approximates src-tauri/src/workspace.rs `classify`.
function kindOf(file: string): Kind {
  if (fs.statSync(file).isDirectory()) return "directory";
  if (!/\.html?$/i.test(file)) return "file";
  const html = fs.readFileSync(file, "utf8");
  if (/slopslide:runtime-|<meta\s+name=["']slopslide-|<main\b[^>]*\bclass=["'][^"']*\bdeck\b/i.test(html))
    return "deck";
  if (/class="reveal"|reveal\.js|id="impress"|data-marpit-svg|remark\.create\(/i.test(html)) return "slideshow";
  return "webpage";
}

// A deck's folder is listed with the deck's title, as src-tauri/src/file_ops.rs `list_dir` does.
function deckTitleOf(dir: string): { deckTitle?: string } {
  const file = path.join(dir, "deck.html");
  if (!fs.statSync(dir).isDirectory() || !fs.existsSync(file) || kindOf(file) !== "deck") return {};
  const title = /<title[^>]*>([^<]*)<\/title>/i.exec(fs.readFileSync(file, "utf8"))?.[1]?.trim();
  return { deckTitle: title || path.basename(dir) };
}

// Approximates src-tauri/src/workspace.rs `gallery`: the library's decks, the one changed last first.
function gallery() {
  const files = fs
    .readdirSync(library)
    .filter((name) => !name.startsWith("."))
    .map((name) => path.join(library, name))
    .map((entry) => (fs.statSync(entry).isDirectory() ? path.join(entry, "deck.html") : entry))
    .filter((file) => fs.existsSync(file) && kindOf(file) === "deck");
  const size = { width: 1920, height: 1080, unit: "px", pixelWidth: 1920, pixelHeight: 1080 };
  return files
    .map((file) => ({
      path: file,
      title: /<title>([^<]*)<\/title>/i.exec(fs.readFileSync(file, "utf8"))?.[1] ?? path.basename(path.dirname(file)),
      workspace: library,
      modifiedMs: fs.statSync(file).mtimeMs,
      openedMs: null,
      size,
    }))
    .sort((a, b) => b.modifiedMs - a.modifiedMs);
}

function listDir(rel: string) {
  const dir = inLibrary(rel);
  if (!dir || !fs.existsSync(dir)) return null;
  return fs
    .readdirSync(dir)
    .filter((name) => !name.startsWith(".") && !name.includes(".tmp-"))
    .map((name) => ({
      name,
      path: rel ? `${rel}/${name}` : name,
      kind: kindOf(path.join(dir, name)),
      ...deckTitleOf(path.join(dir, name)),
    }))
    .sort((a, b) => Number(a.kind !== "directory") - Number(b.kind !== "directory") || a.name.localeCompare(b.name));
}

// Approximates src-tauri/src/html.rs: good enough for previews of well-formed decks.
function readDeck(file: string) {
  const html = fs.readFileSync(file, "utf8");
  const slideTags = [...html.matchAll(/<section\b[^>]*\bclass=["'][^"']*\bslide\b[^"']*["'][^>]*>/gi)];
  const slides = slideTags.map((match, index) => {
    const id = /\bid=["']([^"']+)["']/i.exec(match[0])?.[1] ?? `#${index + 1}`;
    const hidden = /\sdata-hidden\b/i.test(match[0]);
    const locked = /\sdata-locked\b/i.test(match[0]);
    const source = html.slice(match.index, html.indexOf("</section>", match.index));
    return { id, hash: hash(source), hidden, locked, moved: /<[^>]*\sdata-(moved|added)\b/i.test(source) };
  });
  const sections = [...html.matchAll(/<div\b[^>]*\bclass=["'][^"']*\bdeck-section\b[^"']*["'][^>]*>/gi)].map(
    (match, index) => ({
      index,
      title: /\bdata-title=["']([^"']*)["']/i.exec(match[0])?.[1] ?? "",
      before: slideTags.filter((slide) => slide.index < match.index).length,
    }),
  );
  const title = /<title>([^<]*)<\/title>/i.exec(html)?.[1] ?? path.basename(file, path.extname(file));
  return { id: file, title, path: file, slides, sections, shellHash: hash(html) };
}

export function browserPreview(): Plugin {
  return {
    name: "slopslide-browser-preview",
    apply: "serve",
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const url = new URL(req.url ?? "/", "http://x");
        const json = (body: unknown) => {
          if (body === null) res.statusCode = 404;
          res.setHeader("content-type", "application/json");
          return res.end(JSON.stringify(body));
        };
        const rel = url.searchParams.get("path") ?? "";
        if (url.pathname === "/__api/library") return json(library);
        if (url.pathname === "/__api/gallery") return json(gallery());
        if (url.pathname === "/__api/dir") return json(listDir(rel));
        if (url.pathname === "/__api/open") {
          const file = inLibrary(rel);
          return json(file && fs.existsSync(file) ? { path: rel, absolute: file, kind: kindOf(file) } : null);
        }
        if (url.pathname === "/__api/deck") {
          const file = url.searchParams.get("id") ?? "";
          return json(file.startsWith(library + path.sep) && fs.existsSync(file) ? readDeck(file) : null);
        }
        if (url.pathname === "/__api/changes") {
          const file = url.searchParams.get("id") ?? "";
          return json(file.startsWith(library + path.sep) && fs.existsSync(file) ? deckChanges(file) : null);
        }
        if (url.pathname === "/__api/templates") return json(listTemplates());
        if (!url.pathname.startsWith("/__deck/")) return next();
        const template = /^\/__deck\/\.template\/([^/]+)\/deck\.html$/.exec(url.pathname);
        if (template) {
          const html = templateHtml(decodeURIComponent(template[1]!));
          if (html === null) {
            res.statusCode = 404;
            return res.end();
          }
          res.setHeader("content-type", "text/html; charset=utf-8");
          return res.end(pageFor(html, url.searchParams));
        }
        // The app's own scripts, which the pages load by tag (see `scriptTags`).
        if (url.pathname.startsWith(`/__deck/${APP_PREFIX}/`)) {
          const script = stageScriptAt(url.pathname);
          if (script === null) {
            res.statusCode = 404;
            return res.end();
          }
          res.setHeader("content-type", "text/javascript; charset=utf-8");
          res.setHeader("cache-control", "public, max-age=31536000, immutable");
          return res.end(script);
        }
        // Files as of the last commit, like src-tauri/src/protocol.rs: what it does not have
        // comes from the workspace.
        const head = /^\/__deck\/\.head\/(.+)$/.exec(url.pathname);
        if (head) {
          const file = path.resolve("/", decodeURIComponent(head[1]!));
          const committed = file.startsWith(library + path.sep) ? atHead(file) : null;
          if (committed) {
            if (!file.endsWith(".html")) return res.end(committed);
            res.setHeader("content-type", "text/html; charset=utf-8");
            return res.end(pageFor(committed.toString("utf8"), url.searchParams));
          }
          url.pathname = url.pathname.replace("/.head/", "/.file/");
        }
        // Workspace files come by absolute path: `/__deck/.file/<path without its leading />`.
        const served = /^\/__deck\/\.file\/(.+)$/.exec(url.pathname);
        const file = served ? path.resolve("/", decodeURIComponent(served[1]!)) : "";
        if (!file.startsWith(library + path.sep) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
          res.statusCode = 404;
          return res.end();
        }
        if (file.endsWith(".html")) {
          res.setHeader("content-type", "text/html; charset=utf-8");
          return res.end(pageFor(fs.readFileSync(file, "utf8"), url.searchParams));
        }
        fs.createReadStream(file).pipe(res);
      });
    },
  };
}
