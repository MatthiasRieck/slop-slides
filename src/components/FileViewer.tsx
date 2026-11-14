import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { File, FileUp, FolderSearch, Loader2, MonitorPlay, SquareArrowOutUpRight } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { api, errorMessage, type OpenedFile, type TextPreview } from "../lib/api";
import { previewKind } from "../lib/filePreview";
import { isPowerPoint } from "../lib/opening";
import { basename, fileUrl, isMac, isWindows, revealLabel } from "../lib/utils";
import { showError, useApp } from "../store";
import { Button } from "./Button";
import { importPowerPoint } from "./export/importPowerPoint";
import { ImportPptxButton, NewDeckForm, usePptxImport } from "./Home";

/** The window can show a PDF itself: the macOS and Windows web views can, Linux's cannot. */
const SHOWS_PDFS = isMac || isWindows;

/**
 * The main area when no deck is open: the open page as it is (any HTML that is not a
 * SlopSlide deck), an image, a PDF, a text file, a note with a way to open what it cannot show
 * in the app the system opens it in, or, with nothing open, a way to start a deck.
 */
export function FileViewer() {
  const file = useApp((s) => s.openedFile);
  if (!file) return <StartDeck />;
  if (file.kind === "webpage" || file.kind === "slideshow") return <PageView file={file} />;
  switch (previewKind(file.path, SHOWS_PDFS)) {
    case "image":
      return <ImageView file={file} />;
    case "pdf":
      return <PdfView file={file} />;
    case "text":
      return <TextView file={file} />;
    default:
      return <NoViewer file={file} />;
  }
}

/** Opens the file in the app the system opens it in, saying what went wrong. */
function openInDefaultApp(file: OpenedFile) {
  api
    .openInDefaultApp(file.path)
    .catch((error) => showError(error, { doing: `Could not open ${basename(file.path)}` }));
}

/** Under a file that shows: its path, and buttons to open it elsewhere or find it in the file manager. */
function FileBar({ file }: { file: OpenedFile }) {
  return (
    <div className="flex shrink-0 items-center justify-between gap-3 border-t bg-background px-3 py-1.5 text-xs">
      <span className="min-w-0 truncate text-muted-foreground">{file.path}</span>
      <div className="flex shrink-0 items-center gap-1.5">
        <Button size="md" onClick={() => openInDefaultApp(file)}>
          <SquareArrowOutUpRight />
          Open in default app
        </Button>
        <Button size="md" onClick={() => void revealItemInDir(file.absolute)}>
          <FolderSearch />
          {revealLabel}
        </Button>
      </div>
    </div>
  );
}

/** A PDF, as the window's own viewer shows it, loaded again when the file changes. */
function PdfView({ file }: { file: OpenedFile }) {
  const rev = useApp((s) => s.fileRev);
  return (
    <div className="flex h-full flex-col bg-canvas">
      <iframe
        key={file.absolute}
        title={basename(file.path)}
        src={fileUrl(file.absolute, `v=${rev}`)}
        className="min-h-0 w-full flex-1"
      />
      <FileBar file={file} />
    </div>
  );
}

/** How a text file's reading went. */
type TextState = { loading: true } | { loading: false; preview: TextPreview | null; error: string | null };

/** A text file, read-only, read again when it changes. A file that turns out not to be text has no preview. */
function TextView({ file }: { file: OpenedFile }) {
  const rev = useApp((s) => s.fileRev);
  const [state, setState] = useState<TextState>({ loading: true });
  // biome-ignore lint/correctness/useExhaustiveDependencies: read again when the file changes on disk (`rev`)
  useEffect(() => {
    let gone = false;
    api.readTextFile(file.path).then(
      (preview) => !gone && setState({ loading: false, preview, error: null }),
      (error) => !gone && setState({ loading: false, preview: null, error: errorMessage(error) }),
    );
    return () => {
      gone = true;
    };
  }, [file.path, rev]);
  if (!state.loading && !state.preview) return <NoViewer file={file} reason={state.error} />;
  return (
    <div className="flex h-full flex-col">
      <div className="min-h-0 flex-1 overflow-auto bg-card">
        {state.loading ? (
          <p className="flex items-center gap-1.5 p-4 text-xs text-muted-foreground">
            <Loader2 className="size-3.5 animate-spin" />
            Loading…
          </p>
        ) : (
          <pre
            data-testid="preview-text"
            className="selectable min-h-full whitespace-pre-wrap break-words p-4 font-mono text-xs leading-relaxed"
          >
            {state.preview?.text}
          </pre>
        )}
        {!state.loading && state.preview?.truncated && (
          <p className="border-t px-4 py-2 text-2xs text-muted-foreground">
            Only the start of this file is shown. Open it in its app to see all of it.
          </p>
        )}
      </div>
      <FileBar file={file} />
    </div>
  );
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
          <ImportPptxButton job={pptx} size="lg" />
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
        <div className="flex shrink-0 items-center gap-2 border-b bg-muted/40 px-3 py-1.5 text-xs text-muted-foreground">
          <MonitorPlay className="size-3.5" />A slideshow made with another tool, shown as it is. Only SlopSlide decks
          open in the slide editor.
        </div>
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
      <FileBar file={file} />
    </div>
  );
}

/**
 * A file the app cannot show: open it in the app the system opens it in, or find it in the file
 * manager; a PowerPoint file can become a deck. `reason` says why it does not show, when that
 * is more than its kind.
 */
function NoViewer({ file, reason }: { file: OpenedFile; reason?: string | null }) {
  const powerPoint = isPowerPoint(file.path);
  const [importing, setImporting] = useState(false);
  /** Set at once, where the state only shows on the next render. */
  const busy = useRef(false);

  const importDeck = async () => {
    if (busy.current) return;
    busy.current = true;
    setImporting(true);
    try {
      await importPowerPoint(file.absolute);
    } finally {
      busy.current = false;
      setImporting(false);
    }
  };

  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 p-8 text-center">
      <File className="size-6 text-muted-foreground" />
      <p className="text-sm font-medium">{basename(file.path)}</p>
      <p className="text-xs text-muted-foreground">
        {powerPoint
          ? "Import it to make an editable deck. This file stays as it is."
          : (reason ?? "SlopSlide cannot show this kind of file. Open it in the app it belongs to.")}
      </p>
      {powerPoint && (
        <Button variant="primary" size="lg" busy={importing} onClick={() => void importDeck()} className="mt-1">
          {importing ? (
            `Importing ${basename(file.path)}…`
          ) : (
            <>
              <FileUp className="size-3.5" />
              Import as deck
            </>
          )}
        </Button>
      )}
      <div className="mt-1 flex items-center gap-2">
        <Button variant={powerPoint ? "outline" : "primary"} size="lg" onClick={() => openInDefaultApp(file)}>
          <SquareArrowOutUpRight className="size-3.5" />
          Open in default app
        </Button>
        <Button size="lg" onClick={() => void revealItemInDir(file.absolute)}>
          <FolderSearch className="size-3.5" />
          {revealLabel}
        </Button>
      </div>
    </div>
  );
}
