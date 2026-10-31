import { Loader2, MonitorPlay, StickyNote } from "lucide-react";
import { useEffect, useState } from "react";

import type { Screen } from "../lib/api";
import { arrange, choose, defaultChoice, type ScreenChoice } from "../lib/screens";
import { cn } from "../lib/utils";

/** How tall the drawing of the screens gets; it narrows to keep their shape. */
const MAX_HEIGHT_REM = 16;

/** The small print on a screen, which stays readable over a screenshot. */
const LABEL = "relative max-w-full truncate rounded bg-background/85 px-1.5 py-px text-[10px] font-medium";

/**
 * Shown when presenting with several screens attached: the screens drawn the way they sit on
 * the desk, with a button on each for the audience's slides and one for the presenter view
 * (notes, next slide, timers). Each is on one screen at a time. A screenshot of a screen, where
 * there is one, makes it easy to recognize.
 */
export function ScreenPicker(props: {
  screens: Screen[];
  /** A screenshot for each screen, by its index; null while they are being taken. */
  previews?: (string | null)[] | null;
  onStart: (choice: ScreenChoice) => void;
  onCancel: () => void;
}) {
  const { screens } = props;
  const [choice, setChoice] = useState(() => defaultChoice(screens));
  const { aspect, boxes } = arrange(screens);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => event.key === "Escape" && props.onCancel();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [props.onCancel]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
      <dialog
        open
        aria-label="Choose screens"
        className="static flex w-[34rem] max-w-[90vw] flex-col gap-4 rounded-xl border border-border bg-background p-5 text-foreground shadow-2xl"
      >
        <div>
          <h2 className="text-base font-semibold">Present on</h2>
          <p className="text-xs text-muted-foreground">
            Screens match the arrangement in your system display settings. Pick where your slides and notes appear.
          </p>
        </div>
        <div
          className="relative mx-auto w-full"
          style={{ aspectRatio: String(aspect), width: `min(100%, ${MAX_HEIGHT_REM * aspect}rem)` }}
        >
          {boxes.map(({ screen, left, top, width, height }) => {
            const role =
              screen.index === choice.audience ? "audience" : screen.index === choice.presenter ? "presenter" : null;
            const preview = props.previews?.[screen.index];
            return (
              <div
                key={screen.index}
                data-testid={`screen-${screen.index}`}
                data-role={role ?? ""}
                className={cn(
                  "absolute flex flex-col items-center justify-center gap-1 overflow-hidden rounded-md border-2 p-1 text-center",
                  role === "audience" && "border-primary bg-primary/10",
                  role === "presenter" && "border-amber-500 bg-amber-500/10",
                  !role && "border-border bg-muted/40",
                )}
                style={{ left: `${left}%`, top: `${top}%`, width: `${width}%`, height: `${height}%` }}
              >
                {preview && (
                  <img src={preview} alt={`${screen.name} now`} className="absolute inset-0 size-full object-cover" />
                )}
                {props.previews === null && (
                  <>
                    <div className="absolute inset-0 animate-pulse bg-muted" />
                    <Loader2
                      role="status"
                      aria-label={`Taking a screenshot of ${screen.name}`}
                      className="absolute top-1 right-1 size-3.5 animate-spin text-muted-foreground"
                    />
                  </>
                )}
                <span className={LABEL}>{screen.name}</span>
                <div className="relative flex gap-1.5">
                  <RoleButton
                    label={`Slides on ${screen.name}`}
                    shows="audience"
                    active={role === "audience"}
                    onClick={() => setChoice(choose(choice, "audience", screen.index))}
                  >
                    <MonitorPlay />
                  </RoleButton>
                  <RoleButton
                    label={`Presenter view on ${screen.name}`}
                    shows="presenter"
                    active={role === "presenter"}
                    disabled={role === "audience"}
                    onClick={() => setChoice(choose(choice, "presenter", screen.index))}
                  >
                    <StickyNote />
                  </RoleButton>
                </div>
                <span className={cn(LABEL, "tabular-nums")}>
                  {screen.pixelWidth}×{screen.pixelHeight}
                </span>
              </div>
            );
          })}
        </div>
        <label className="flex items-center gap-2 text-xs">
          <input
            type="checkbox"
            checked={choice.presenter === null}
            onChange={(event) =>
              setChoice({
                ...choice,
                presenter: event.target.checked ? null : screens.findIndex((s) => s.index !== choice.audience),
              })
            }
          />
          No presenter view
        </label>
        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={props.onCancel}
            className="rounded-md px-3 py-1.5 text-xs text-muted-foreground hover:bg-accent hover:text-foreground"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => props.onStart(choice)}
            className="rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground shadow-sm hover:opacity-90"
          >
            Start presenting
          </button>
        </div>
      </dialog>
    </div>
  );
}

function RoleButton(props: {
  label: string;
  shows: "audience" | "presenter";
  active: boolean;
  disabled?: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={props.label}
      aria-pressed={props.active}
      title={props.label}
      disabled={props.disabled}
      onClick={props.onClick}
      className={cn(
        "flex size-8 items-center justify-center rounded-md shadow-sm [&_svg]:size-4",
        props.active && props.shows === "audience" && "bg-primary text-primary-foreground",
        props.active && props.shows === "presenter" && "bg-amber-500 text-black",
        !props.active && "bg-background/85 text-muted-foreground hover:enabled:text-foreground",
        props.disabled && "cursor-not-allowed opacity-50",
      )}
    >
      {props.children}
    </button>
  );
}
