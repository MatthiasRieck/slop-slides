import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ImportedPptx, ImportProgress } from "../../lib/api";
import { useApp } from "../../store";
import { toastTexts } from "../../store/errors";
import { useExports } from "../../store/exports";
import { DECK_HTML, deckFor } from "../../test/fixtures";
import { listen } from "../../test/tauri";
import { importPowerPoint, importReport, openImportReport } from "./importPowerPoint";
import { PptxImport } from "./PptxImport";

const DECK = { ...deckFor(DECK_HTML), id: "/ws/board-update/deck.html", title: "Board update" };

const IMPORTED: ImportedPptx = {
  deck: DECK,
  changes: [
    { what: "charts (their data came along as tables)", slides: [2] },
    { what: "animations (each slide shows as it ends)", slides: [1, 3] },
  ],
  fonts: [{ name: "Brand Sans Missing", slides: [3] }],
};

beforeEach(() => {
  listen.mockReset();
  listen.mockResolvedValue(() => {});
  useExports.setState({ runs: [], dialog: null, importing: null, report: null, reportOpen: false });
  useApp.setState({ toasts: [], deck: null, selected: null });
});

/** Has the store import as the backend would, opening the deck; `progress` events come first. */
function importing(result: ImportedPptx | null, progress: ImportProgress[] = []) {
  const importPptx = vi.fn(async () => {
    const report = listen.mock.calls.find(([event]) => event === "pptx-import-progress")?.[1];
    for (const payload of progress) report?.({ payload });
    if (result) useApp.setState({ deck: result.deck });
    return result;
  });
  useApp.setState({ importPptx });
  return importPptx;
}

describe("the import report", () => {
  it("lists what changed by slide, and the fonts this computer lacks", () => {
    const report = importReport(IMPORTED, "/Users/me/Board.pptx", (names) =>
      names.filter((n) => n.includes("Missing")),
    );
    expect(report).toEqual({
      deckId: DECK.id,
      title: "Board update",
      file: "Board.pptx",
      slides: 3,
      changes: IMPORTED.changes,
      missingFonts: [{ name: "Brand Sans Missing", slides: [3] }],
    });
  });

  it("opens once the deck is open, each change with buttons to its slides", async () => {
    importing(IMPORTED);
    render(<PptxImport />);
    await act(async () => void (await importPowerPoint("/Users/me/Board.pptx")));
    const dialog = screen.getByRole("dialog", { name: "Import report" });
    expect(dialog.textContent).toContain("Imported Board.pptx");
    expect(dialog.textContent).toContain("Charts (their data came along as tables)");
    expect(dialog.textContent).toContain("Animations (each slide shows as it ends)");
    // jsdom measures no font, so none counts as missing here.
    expect(dialog.textContent).not.toContain("not on this computer");
    fireEvent.click(screen.getByRole("button", { name: "2" }));
    expect(useApp.getState().selected).toBe("#2");
    expect(screen.queryByRole("dialog", { name: "Import report" })).toBeNull();
  });

  it("comes back from the toast while the deck is open, and not after", async () => {
    importing(IMPORTED);
    render(<PptxImport />);
    await act(async () => void (await importPowerPoint("/Users/me/Board.pptx")));
    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    expect(screen.queryByRole("dialog", { name: "Import report" })).toBeNull();
    const toast = useApp.getState().toasts.at(-1)!;
    expect(toast.text).toBe("Board update: 2 things to check against Board.pptx.");
    expect(toast.action?.label).toBe("View import report");
    act(() => toast.action?.run());
    expect(screen.getByRole("dialog", { name: "Import report" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    act(() => useApp.setState({ deck: null }));
    act(() => openImportReport());
    expect(screen.queryByRole("dialog", { name: "Import report" })).toBeNull();
    expect(toastTexts(useApp.getState(), "info").at(-1)).toMatch(/went with Board update/);
  });

  it("names the fonts that are missing among the changes", () => {
    useApp.setState({ deck: DECK });
    useExports.setState({
      report: importReport(IMPORTED, "/b/Board.pptx", () => ["Brand Sans Missing"]),
      reportOpen: true,
    });
    render(<PptxImport />);
    expect(screen.getByRole("dialog").textContent).toContain(
      "A font is not on this computer, so another shows in its place: Brand Sans Missing",
    );
    expect(screen.getByRole("dialog").textContent).toContain("3 things could not come along as they were");
  });

  it("says everything came along when nothing changed", async () => {
    importing({ ...IMPORTED, changes: [], fonts: [] });
    render(<PptxImport />);
    await act(async () => void (await importPowerPoint("/Users/me/Board.pptx")));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(toastTexts(useApp.getState(), "success")).toEqual(["Imported Board.pptx: 3 slides, everything as it was."]);
  });
});

describe("an import under way", () => {
  it("says which slide it is reading, over the window, until the deck opens", async () => {
    let finish = () => {};
    const importPptx = vi.fn(async () => {
      const report = listen.mock.calls.find(([event]) => event === "pptx-import-progress")?.[1];
      report?.({ payload: { slide: 4, slides: 20 } });
      await new Promise<void>((resolve) => (finish = resolve));
      return null;
    });
    useApp.setState({ importPptx });
    render(<PptxImport />);
    let done: Promise<boolean> = Promise.resolve(false);
    await act(async () => {
      done = importPowerPoint("/Users/me/Board.pptx");
    });
    const dialog = screen.getByRole("dialog", { name: "Importing Board.pptx" });
    expect(dialog.textContent).toContain("Reading slide 4 of 20");
    expect(screen.getByRole("progressbar").getAttribute("aria-valuenow")).toBe("4");
    // One at a time.
    expect(await importPowerPoint("/Users/me/Other.pptx")).toBe(false);
    await act(async () => finish());
    expect(await done).toBe(false);
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});
