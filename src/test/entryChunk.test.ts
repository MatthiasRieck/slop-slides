// @vitest-environment node
/**
 * What the window starts with: the modules src/main.tsx reaches through static imports, which
 * the build puts in the chunk loaded before anything shows. The heavy parts of the app that the
 * first screen does not show are reached only through `import()` (see src/components/lazy.tsx).
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = resolve(__dirname, "../..");

/** The modules a file imports statically; type-only imports are gone from the build. */
function staticImports(source: string): string[] {
  const found: string[] = [];
  const statement = /^\s*(?:import|export)\s+(?!type\s)(?:[^"';]*?\sfrom\s+)?["']([^"']+)["']/gm;
  for (const match of source.matchAll(statement)) found.push(match[1]!);
  return found;
}

/** Whether `specifier` names a file of the app (relative, or by the `@/` alias of src/) and not a package. */
function ofTheApp(specifier: string): boolean {
  return specifier.startsWith(".") || specifier.startsWith("@/");
}

/** The source file `specifier` names, seen from `from`; null for a package. */
function sourceFile(from: string, specifier: string): string | null {
  if (!ofTheApp(specifier)) return null;
  // `@/` is src/ (see vite.config.ts and tsconfig.json).
  const base = specifier.startsWith("@/") ? join(ROOT, "src", specifier.slice(2)) : resolve(dirname(from), specifier);
  const candidates = [base, `${base}.ts`, `${base}.tsx`, join(base, "index.ts"), join(base, "index.tsx")];
  return candidates.find((path) => existsSync(path) && /\.(tsx?|css)$/.test(path)) ?? null;
}

/** `path` with `/` between its parts, whatever `separator` the system writes. */
function slashed(path: string, separator: string = sep): string {
  return path.split(separator).join("/");
}

/** `file` as the tests name it: from the repository root, the same on every system. */
function repoPath(file: string): string {
  return slashed(relative(ROOT, file));
}

/** Every source file and package reached from `entry` without an `import()`. */
function eagerGraph(entry: string) {
  const files = new Set<string>();
  const packages = new Set<string>();
  const visit = (file: string) => {
    if (files.has(file)) return;
    files.add(file);
    if (file.endsWith(".css")) return;
    for (const specifier of staticImports(readFileSync(file, "utf8"))) {
      const next = sourceFile(file, specifier);
      if (next) visit(next);
      else if (!ofTheApp(specifier)) packages.add(specifier);
    }
  };
  visit(entry);
  return { files: [...files].map((file) => repoPath(file)), packages: [...packages] };
}

describe("the paths the graph reports", () => {
  it("use / whatever the system's separator is", () => {
    expect(repoPath(join(ROOT, "src", "App.tsx"))).toBe("src/App.tsx");
    expect(slashed("src\\components\\Sidebar.tsx", "\\")).toBe("src/components/Sidebar.tsx");
    expect(slashed("src/components/Sidebar.tsx", "/")).toBe("src/components/Sidebar.tsx");
  });
});

describe("what the window loads before it shows anything", () => {
  const graph = eagerGraph(join(ROOT, "src/main.tsx"));

  it("is found by following the app's static imports", () => {
    expect(graph.files).toContain("src/App.tsx");
    expect(graph.files).toContain("src/components/Sidebar.tsx");
    // The first screen: the chat with its Markdown, and the slide rail.
    expect(graph.files).toContain("src/components/ChatPanel.tsx");
    expect(graph.files).toContain("src/components/SlideRail.tsx");
    expect(graph.packages).toContain("react-markdown");
  });

  it("follows the imports written with the `@/` alias, which name files and not packages", () => {
    expect(graph.files).toContain("src/components/ui/button.tsx");
    expect(graph.files).toContain("src/lib/highlighter.tsx");
    expect(graph.packages.filter((name) => name.startsWith("@/"))).toEqual([]);
  });

  it("leaves out the syntax highlighter, loaded with the first code block", () => {
    expect(graph.packages.filter((name) => name.startsWith("shiki"))).toEqual([]);
  });

  it("leaves out the code editor", () => {
    expect(graph.packages.filter((name) => name.startsWith("@codemirror") || name.startsWith("@lezer"))).toEqual([]);
    expect(graph.files).not.toContain("src/components/CodeView.tsx");
    expect(graph.files).not.toContain("src/components/code/sourceEditor.ts");
  });

  it.each([
    "SvgEditor",
    "ChangesView",
    "Presenter",
    "PresenterWindow",
    "NarrationTimeline",
    "VideoExport",
    "SlideImageExport",
    "RewindDialog",
    "DeckSettings",
  ])("leaves out %s, loaded on first use", (name) => {
    expect(graph.files).not.toContain(`src/components/${name}.tsx`);
  });

  it("leaves out the settings dialog, but not the keys that open it", () => {
    expect(graph.files.filter((file) => file.startsWith("src/components/settings/"))).toEqual([
      "src/components/settings/useSettingsKeys.ts",
    ]);
  });
});
