import { Loader2, TabletSmartphone, X } from "lucide-react";
import { useEffect, useState } from "react";

import { api, errorMessage, type RemoteInfo } from "../lib/api";
import { isRemote } from "../lib/platform";
import { cn } from "../lib/utils";

/** How often the open dialog refreshes the number of connected devices. */
export const STATUS_POLL_MS = 2000;

/**
 * "Use on another device": serves the app to phones and tablets on the same network
 * (src-tauri/src/remote.rs), e.g. to review slides with a pen. Opening it starts sharing and
 * shows the address as a QR code; sharing goes on after the dialog closes, until stopped.
 */
export function ShareDevice() {
  const [open, setOpen] = useState(false);
  const [info, setInfo] = useState<RemoteInfo | null>(null);

  useEffect(() => {
    if (!isRemote) void refreshStatus(setInfo);
  }, []);

  // A device cannot share the app further.
  if (isRemote) return null;

  const sharing = info !== null;
  return (
    <>
      <button
        type="button"
        title={sharing ? "Shared with other devices" : "Use on a phone or tablet"}
        aria-label="Use on another device"
        aria-pressed={sharing}
        onClick={() => setOpen(true)}
        className={cn(
          "rounded-md p-1.5 text-muted-foreground hover:bg-accent hover:text-foreground",
          sharing && "text-primary hover:text-primary",
        )}
      >
        <TabletSmartphone className="size-4" />
      </button>
      {open && <ShareDialog info={info} setInfo={setInfo} onClose={() => setOpen(false)} />}
    </>
  );
}

async function refreshStatus(setInfo: (info: RemoteInfo | null) => void) {
  try {
    setInfo((await api.remoteStatus()) ?? null);
  } catch {
    // Keeps showing what it knew.
  }
}

function ShareDialog(props: { info: RemoteInfo | null; setInfo: (info: RemoteInfo | null) => void; onClose: () => void }) {
  const { info, setInfo, onClose } = props;
  const [error, setError] = useState<string | null>(null);
  const [stopped, setStopped] = useState(false);
  /** Bumped by "Try again" and "Share again". */
  const [attempt, setAttempt] = useState(0);

  // Opening the dialog shares the app, unless the user just stopped sharing.
  useEffect(() => {
    if (info || stopped) return;
    let cancelled = false;
    api
      .remoteStart()
      .then((started) => !cancelled && setInfo(started))
      .catch((e) => !cancelled && setError(errorMessage(e)));
    return () => {
      cancelled = true;
    };
  }, [stopped, attempt]); // eslint-disable-line react-hooks/exhaustive-deps

  // Keep the count of connected devices current.
  const sharing = info !== null;
  useEffect(() => {
    if (!sharing) return;
    const timer = setInterval(() => void refreshStatus(setInfo), STATUS_POLL_MS);
    return () => clearInterval(timer);
  }, [sharing]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const stop = async () => {
    try {
      await api.remoteStop();
      setStopped(true);
      setInfo(null);
    } catch (e) {
      setError(errorMessage(e));
    }
  };

  const restart = () => {
    setError(null);
    setStopped(false);
    setAttempt((n) => n + 1);
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
      onPointerDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        role="dialog"
        aria-label="Use on another device"
        className="relative flex w-[340px] flex-col items-center gap-3 rounded-xl border bg-card p-5 text-center shadow-xl"
      >
        <button
          type="button"
          aria-label="Close"
          onClick={onClose}
          className="absolute top-2 right-2 rounded-md p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
        >
          <X className="size-4" />
        </button>
        <h2 className="text-sm font-semibold">Use on another device</h2>
        {error ? (
          <>
            <p className="selectable text-xs text-destructive">{error}</p>
            <button type="button" onClick={restart} className="rounded-md border px-2.5 py-1 text-xs font-medium hover:bg-accent">
              Try again
            </button>
          </>
        ) : stopped ? (
          <>
            <p className="text-xs text-muted-foreground">Sharing is off. Devices that were connected no longer have access.</p>
            <button type="button" onClick={restart} className="rounded-md border px-2.5 py-1 text-xs font-medium hover:bg-accent">
              Share again
            </button>
          </>
        ) : !info ? (
          <div className="flex h-60 items-center justify-center text-muted-foreground">
            <Loader2 className="size-5 animate-spin" />
          </div>
        ) : (
          <>
            <p className="text-xs text-muted-foreground">
              Scan with a phone or tablet on the same Wi-Fi to open SlopSlide there, e.g. to mark up slides with a pen.
            </p>
            <div
              data-testid="share-qr"
              className="size-60 overflow-hidden rounded-lg bg-white p-2 [&_svg]:size-full"
              // The backend renders the QR code from the address; nothing here comes from a user.
              dangerouslySetInnerHTML={{ __html: info.qrSvg }}
            />
            <code className="selectable max-w-full truncate rounded bg-muted px-2 py-1 text-2xs">{info.url}</code>
            <p className="text-2xs text-muted-foreground">
              {info.devices === 0
                ? "No device connected yet."
                : `${info.devices} ${info.devices === 1 ? "device" : "devices"} connected.`}{" "}
              Anyone with this address can edit your decks and talk to the agent, so only share it on networks you trust.
            </p>
            <button
              type="button"
              onClick={() => void stop()}
              className="rounded-md border px-2.5 py-1 text-xs font-medium text-destructive hover:bg-accent"
            >
              Stop sharing
            </button>
          </>
        )}
      </div>
    </div>
  );
}
