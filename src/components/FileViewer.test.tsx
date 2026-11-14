import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useApp } from "../store";
import { invoke, open as openDialog, revealItemInDir } from "../test/tauri";
import { FileViewer } from "./FileViewer";

beforeEach(() => {
  invoke.mockReset().mockResolvedValue([]);
  revealItemInDir.mockReset();
  useApp.setState({ workspace: { path: "/ws", name: "ws" }, openedFile: null, deck: null, fileRev: 0, templates: [] });
});

const frame = () => document.querySelector("iframe");

describe("FileViewer", () => {
  it("shows a web page as it is, sandboxed, and reloads it when it changes", () => {
    useApp.setState({ openedFile: { path: "site/index.html", absolute: "/ws/site/index.html", kind: "webpage" } });
    render(<FileViewer />);
    expect(frame()!.getAttribute("src")).toBe("/__deck/.file/ws/site/index.html?v=0");
    expect(frame()!.getAttribute("sandbox")).toBe("allow-scripts allow-forms allow-popups allow-modals");
    expect(frame()!.getAttribute("title")).toBe("index.html");
    expect(screen.queryByText(/made with another tool/)).toBeNull();
    act(() => useApp.setState({ fileRev: 1 }));
    expect(frame()!.getAttribute("src")).toBe("/__deck/.file/ws/site/index.html?v=1");
  });

  it("shows another tool's slideshow as it is, saying so", () => {
    useApp.setState({ openedFile: { path: "reveal.html", absolute: "/ws/reveal.html", kind: "slideshow" } });
    render(<FileViewer />);
    expect(frame()!.getAttribute("src")).toBe("/__deck/.file/ws/reveal.html?v=0");
    expect(screen.getByText(/made with another tool/)).toBeTruthy();
  });

  it("offers the system's app and the file manager for files it cannot show", async () => {
    useApp.setState({ openedFile: { path: "song.mp3", absolute: "/ws/song.mp3", kind: "file" } });
    render(<FileViewer />);
    expect(frame()).toBeNull();
    expect(screen.getByText(/cannot show this kind of file/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Show in folder/ }));
    expect(revealItemInDir).toHaveBeenCalledWith("/ws/song.mp3");
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Open in default app" })));
    expect(invoke).toHaveBeenCalledWith("open_in_default_app", { path: "song.mp3" });
  });

  it("says why the system's app could not open a file", async () => {
    invoke.mockRejectedValue("song.mp3 can run as a program");
    useApp.setState({ toasts: [], openedFile: { path: "song.mp3", absolute: "/ws/song.mp3", kind: "file" } });
    render(<FileViewer />);
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Open in default app" })));
    expect(useApp.getState().toasts.map((t) => t.text)).toEqual([
      "Could not open song.mp3: song.mp3 can run as a program",
    ]);
  });

  it("shows a text file as it is, read-only, and reads it again when it changes", async () => {
    invoke.mockImplementation(async (command: string) =>
      command === "read_text_file" ? { text: "# Notes\nSay hello", truncated: true } : undefined,
    );
    useApp.setState({ openedFile: { path: "notes.md", absolute: "/ws/notes.md", kind: "file" } });
    render(<FileViewer />);
    await waitFor(() => expect(screen.getByTestId("preview-text").textContent).toBe("# Notes\nSay hello"));
    expect(screen.getByText(/Only the start of this file is shown/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Open in default app" })).toBeTruthy();
    expect(invoke).toHaveBeenCalledWith("read_text_file", { path: "notes.md" });
    await act(async () => useApp.setState({ fileRev: 1 }));
    expect(invoke.mock.calls.filter(([c]) => c === "read_text_file")).toHaveLength(2);
  });

  it("says when a text file turns out not to be text", async () => {
    invoke.mockImplementation(async (command: string) => {
      if (command === "read_text_file") throw "This file is not text.";
    });
    useApp.setState({ openedFile: { path: "data.csv", absolute: "/ws/data.csv", kind: "file" } });
    render(<FileViewer />);
    await waitFor(() => expect(screen.getByText("This file is not text.")).toBeTruthy());
    expect(screen.getByRole("button", { name: "Open in default app" })).toBeTruthy();
  });

  it("shows a PDF in the window's own viewer", () => {
    useApp.setState({ openedFile: { path: "Talk.pdf", absolute: "/ws/Talk.pdf", kind: "file" } });
    render(<FileViewer />);
    // The tests run as macOS or Windows would, or as Linux, which has no viewer for PDFs.
    const shows = /Mac|Windows/.test(navigator.userAgent);
    expect(frame()?.getAttribute("src") ?? null).toBe(shows ? "/__deck/.file/ws/Talk.pdf?v=0" : null);
    expect(screen.getByRole("button", { name: "Open in default app" })).toBeTruthy();
  });

  it("offers to import a PowerPoint file as a deck", async () => {
    const importPptx = vi.fn(async () => null);
    useApp.setState({ importPptx, openedFile: { path: "talks/q3.pptx", absolute: "/ws/talks/q3.pptx", kind: "file" } });
    render(<FileViewer />);
    expect(screen.queryByText(/cannot show this kind of file/)).toBeNull();
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Import as deck" })));
    expect(importPptx).toHaveBeenCalledWith("/ws/talks/q3.pptx");
  });

  it("says it is importing, and imports the file once however often the button is pressed", async () => {
    let done = () => {};
    const importPptx = vi.fn(() => new Promise<null>((resolve) => (done = () => resolve(null))));
    useApp.setState({ importPptx, openedFile: { path: "talks/q3.pptx", absolute: "/ws/talks/q3.pptx", kind: "file" } });
    render(<FileViewer />);
    const button = () => screen.getByRole("button", { name: /Import/ }) as HTMLButtonElement;
    fireEvent.click(button());
    expect(button().textContent).toBe("Importing q3.pptx…");
    expect(button().disabled).toBe(true);
    expect(button().getAttribute("aria-busy")).toBe("true");
    await act(async () => fireEvent.click(button()));
    expect(importPptx).toHaveBeenCalledOnce();
    await act(async () => done());
    expect(button().textContent).toBe("Import as deck");
    expect(button().disabled).toBe(false);
  });

  it.each(["png", "jpg", "jpeg", "gif", "svg", "webp"])(
    "shows a .%s image, and loads it again when it changes",
    (ext) => {
      const absolute = `/ws/assets/logo.${ext}`;
      useApp.setState({ openedFile: { path: `assets/logo.${ext}`, absolute, kind: "file" } });
      render(<FileViewer />);
      const image = screen.getByRole("img", { name: `logo.${ext}` }) as HTMLImageElement;
      expect(image.getAttribute("src")).toBe(`/__deck/.file/ws/assets/logo.${ext}?v=0`);
      expect(screen.queryByText(/cannot show this kind of file/)).toBeNull();
      act(() => useApp.setState({ fileRev: 1 }));
      expect(screen.getByRole("img").getAttribute("src")).toBe(`/__deck/.file/ws/assets/logo.${ext}?v=1`);
      fireEvent.click(screen.getByRole("button", { name: /Show in folder/ }));
      expect(revealItemInDir).toHaveBeenCalledWith(absolute);
    },
  );

  it("uses the reveal icon, not the open folder's, for the file manager", () => {
    useApp.setState({ openedFile: { path: "song.mp3", absolute: "/ws/song.mp3", kind: "file" } });
    render(<FileViewer />);
    const reveal = screen.getByRole("button", { name: /Show in folder/ });
    expect(reveal.querySelector("svg")!.getAttribute("class")).toContain("lucide-folder-search");
  });

  it("offers to start a deck in the workspace when nothing is open", async () => {
    render(<FileViewer />);
    expect(screen.getByText("Start a deck")).toBeTruthy();
    expect(screen.getByText(/new folder in ws/)).toBeTruthy();
    fireEvent.change(screen.getByRole("textbox", { name: "Title (optional)" }), { target: { value: "Board" } });
    await act(async () => fireEvent.click(screen.getByRole("button", { name: /Create deck/ })));
    expect(invoke).toHaveBeenCalledWith("create_deck", { title: "Board", template: null });
    expect(invoke).not.toHaveBeenCalledWith("open_workspace", expect.anything());
  });

  it("leaves the focus where it is when a deck closes: only the start screen's form takes it", () => {
    const composer = document.createElement("textarea");
    document.body.append(composer);
    composer.focus();
    render(<FileViewer />);
    expect(document.activeElement).toBe(composer);
    composer.remove();
  });

  it("imports a PowerPoint file into the workspace from where a deck is started", async () => {
    const importPptx = vi.fn(async () => null);
    useApp.setState({ importPptx });
    openDialog.mockResolvedValue("/Users/me/Downloads/q3.pptx");
    render(<FileViewer />);
    fireEvent.click(screen.getByRole("button", { name: "Import PowerPoint…" }));
    await waitFor(() => expect(importPptx).toHaveBeenCalledWith("/Users/me/Downloads/q3.pptx"));
    expect(invoke).not.toHaveBeenCalledWith("open_workspace", expect.anything());
  });
});
