import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { File, FolderOpen, MonitorPlay } from "lucide-react";

import type { OpenedFile } from "../lib/api";
import { basename, fileUrl, isMac } from "../lib/utils";
import { useApp } from "../store";
import { NewDeckForm } from "./Home";

/**
 * The main area when no deck is open: the open page as it is (any HTML that is not a
 * SlopSlide deck), a note for files there is no viewer for yet, or, with nothing open, a way to
 * start a deck.
 */
export function FileViewer() {
  const file = useApp((s) => s.openedFile);
  const workspace = useApp((s) => s.workspace);
  if (!file) {
    return (
      <div className="flex h-full items-center justify-center overflow-y-auto p-8">
        <div className="flex w-full max-w-2xl flex-col gap-3">
          <NewDeckForm heading="Start a deck" hint={`It goes in a new folder in ${workspace?.name ?? "the workspace"}. Or open a file from the Files tab.`} />
        </div>
      </div>
    );
  }
  if (file.kind === "webpage" || file.kind === "slideshow") return <PageView file={file} />;
  return <NoViewer file={file} />;
}

function PageView({ file }: { file: OpenedFile }) {
  const rev = useApp((s) => s.fileRev);
  return (
    <div className="flex h-full flex-col">
      {file.kind === "slideshow" && (
        <div className="flex shrink-0 items-center gap-2 border-b bg-muted/40 px-3 py-1.5 text-xs text-muted-foreground">
          <MonitorPlay className="size-3.5" />
          A slideshow made with another tool, shown as it is. Only SlopSlide decks open in the slide editor.
        </div>
      )}
      <iframe
        key={file.absolute}
        title={basename(file.path)}
        src={fileUrl(file.absolute, `v=${rev}`)}
        // Its own scripts run, but it gets no access to the app.
        sandbox="allow-scripts allow-forms allow-popups allow-modals"
        className="min-h-0 w-full flex-1 bg-white"
      />
    </div>
  );
}

function NoViewer({ file }: { file: OpenedFile }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 p-8 text-center">
      <File className="size-6 text-muted-foreground" />
      <p className="text-sm font-medium">{basename(file.path)}</p>
      <p className="text-xs text-muted-foreground">There is no preview for this kind of file yet.</p>
      <button
        type="button"
        onClick={() => void revealItemInDir(file.absolute)}
        className="mt-1 flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-xs font-medium hover:bg-accent"
      >
        <FolderOpen className="size-3.5" />
        {isMac ? "Show in Finder" : "Show in folder"}
      </button>
    </div>
  );
}
