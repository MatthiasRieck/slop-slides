import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { File, FileUp, FolderSearch, MonitorPlay } from "lucide-react";
import { useRef, useState } from "react";

import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { Spinner } from "@/components/ui/spinner";
import type { OpenedFile } from "../lib/api";
import { isImage } from "../lib/drop";
import { isPowerPoint } from "../lib/opening";
import { basename, fileUrl, revealLabel } from "../lib/utils";
import { useApp } from "../store";
import { ImportPptxButton, NewDeckForm, usePptxImport } from "./Home";

/**
 * The main area when no deck is open: the open page as it is (any HTML that is not a
 * SlopSlide deck), an image, a note for files there is no viewer for yet, or, with nothing
 * open, a way to start a deck.
 */
export function FileViewer() {
  const file = useApp((s) => s.openedFile);
  if (!file) return <StartDeck />;
  if (file.kind === "webpage" || file.kind === "slideshow") return <PageView file={file} />;
  if (isImage(file.path)) return <ImageView file={file} />;
  return <NoViewer file={file} />;
}

/** Nothing is open: start a deck in the workspace, or import one from PowerPoint. */
function StartDeck() {
  const workspace = useApp((s) => s.workspace);
  const pptx = usePptxImport();
  return (
    <div className="flex h-full items-center justify-center overflow-y-auto p-8">
      <div className="flex w-full max-w-2xl flex-col gap-3">
        <NewDeckForm
          heading="Start a deck"
          hint={`It goes in a new folder in ${workspace?.name ?? "the workspace"}. Or open a file from the Files tab.`}
          disabled={pptx.importing !== null}
        />
        <div>
          <ImportPptxButton job={pptx} size="xs" />
        </div>
      </div>
    </div>
  );
}

function PageView({ file }: { file: OpenedFile }) {
  const rev = useApp((s) => s.fileRev);
  return (
    <div className="flex h-full flex-col">
      {file.kind === "slideshow" && (
        <Alert role="note" className="shrink-0 rounded-none border-x-0 border-t-0 bg-muted/40 px-3 py-1.5">
          <MonitorPlay />
          <AlertDescription className="text-xs">
            A slideshow made with another tool, shown as it is. Only SlopSlide decks open in the slide editor.
          </AlertDescription>
        </Alert>
      )}
      <iframe
        key={file.absolute}
        title={basename(file.path)}
        src={fileUrl(file.absolute, `v=${rev}`)}
        // Its own scripts run, but it gets no access to the app.
        sandbox="allow-scripts allow-forms allow-popups allow-modals"
        className="min-h-0 w-full flex-1 bg-paper"
      />
    </div>
  );
}

/** An image of the workspace, as large as fits, loaded again when the file changes. */
function ImageView({ file }: { file: OpenedFile }) {
  const rev = useApp((s) => s.fileRev);
  return (
    <div className="flex h-full flex-col bg-canvas">
      <div className="flex min-h-0 flex-1 items-center justify-center p-6">
        <img
          key={file.absolute}
          alt={basename(file.path)}
          src={fileUrl(file.absolute, `v=${rev}`)}
          className="max-h-full max-w-full rounded-md object-contain shadow-thumbnail"
        />
      </div>
      <div className="flex shrink-0 items-center justify-between gap-3 border-t bg-background px-3 py-1.5 text-xs">
        <span className="min-w-0 truncate text-muted-foreground">{file.path}</span>
        <Button variant="outline" size="xs" onClick={() => void revealItemInDir(file.absolute)}>
          <FolderSearch data-icon="inline-start" />
          {revealLabel}
        </Button>
      </div>
    </div>
  );
}

function NoViewer({ file }: { file: OpenedFile }) {
  const powerPoint = isPowerPoint(file.path);
  const [importing, setImporting] = useState(false);
  /** Set at once, where the state only shows on the next render. */
  const busy = useRef(false);

  const importDeck = async () => {
    if (busy.current) return;
    busy.current = true;
    setImporting(true);
    try {
      await useApp.getState().importPptx(file.absolute);
    } finally {
      busy.current = false;
      setImporting(false);
    }
  };

  return (
    <Empty className="h-full p-8">
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <File />
        </EmptyMedia>
        <EmptyTitle>{basename(file.path)}</EmptyTitle>
        <EmptyDescription className="text-xs">
          {powerPoint
            ? "Import it to make an editable deck. This file stays as it is."
            : "There is no preview for this kind of file yet."}
        </EmptyDescription>
      </EmptyHeader>
      <EmptyContent>
        {powerPoint && (
          <Button size="xs" disabled={importing} aria-busy={importing || undefined} onClick={() => void importDeck()}>
            {importing ? (
              <>
                <Spinner aria-hidden="true" data-icon="inline-start" />
                {`Importing ${basename(file.path)}…`}
              </>
            ) : (
              <>
                <FileUp data-icon="inline-start" />
                Import as deck
              </>
            )}
          </Button>
        )}
        <Button variant="outline" size="xs" onClick={() => void revealItemInDir(file.absolute)}>
          <FolderSearch data-icon="inline-start" />
          {revealLabel}
        </Button>
      </EmptyContent>
    </Empty>
  );
}
