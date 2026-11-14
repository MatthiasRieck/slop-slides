/** What the file viewer (components/FileViewer.tsx) shows a file as, by its name. */
import { isImage } from "./drop";

/** How a file that is no deck or page shows: as an image, a PDF, text, or not at all. */
export type PreviewKind = "image" | "pdf" | "text" | "none";

/** Files that are text to read, by extension; their content shows as it is. */
const TEXT_EXTENSIONS = new Set([
  "txt",
  "md",
  "markdown",
  "csv",
  "tsv",
  "json",
  "jsonc",
  "yaml",
  "yml",
  "toml",
  "xml",
  "css",
  "scss",
  "js",
  "mjs",
  "cjs",
  "ts",
  "tsx",
  "jsx",
  "py",
  "rb",
  "sh",
  "log",
  "ini",
  "cfg",
  "conf",
  "env",
  "srt",
  "vtt",
  "rtf",
  "tex",
]);
/** Files without an extension that are text all the same. */
const TEXT_NAMES = new Set(["readme", "license", "changelog", "makefile", "dockerfile"]);

/** The extension of `path`, in lower case, without its dot; empty without one. */
function extensionOf(path: string): string {
  const name = path.slice(path.lastIndexOf("/") + 1);
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
}

/**
 * How the file at `path` shows. A PDF shows only where the window can show one (`pdfs`: the
 * macOS and Windows web views can, Linux's cannot).
 */
export function previewKind(path: string, pdfs: boolean): PreviewKind {
  if (isImage(path)) return "image";
  const extension = extensionOf(path);
  if (extension === "pdf") return pdfs ? "pdf" : "none";
  if (TEXT_EXTENSIONS.has(extension)) return "text";
  const name = path.slice(path.lastIndexOf("/") + 1).toLowerCase();
  return extension === "" && TEXT_NAMES.has(name) ? "text" : "none";
}
