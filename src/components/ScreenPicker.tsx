import { MonitorPlay, StickyNote } from "lucide-react";
import { useEffect, useState } from "react";

import type { Screen } from "../lib/api";
import { arrange, choose, defaultChoice, type ScreenChoice } from "../lib/screens";
import { cn } from "../lib/utils";

/** How tall the drawing of the screens gets; it narrows to keep their shape. */
const MAX_HEIGHT_REM = 16;

/**
 * Shown when presenting with several screens attached: the screens drawn the way they sit on
 * the desk, to pick the one the audience sees the slides on and the one the presenter view
 * (notes, next slide, timers) goes to. A screenshot of a screen, where there is one, makes it
 * easy to recognize.
 */
export function ScreenPicker(props: {
  screens: Screen[];
  /** A screenshot for each screen, by its index. */
  previews?: (string | null)[];
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
                  "absolute flex flex-col items-center justify-center gap-1.5 overflow-hidden rounded-md border-2 p-1 text-center",
                  role === "audience" && "border-primary bg-primary/10",
                  role === "presenter" && "border-amber-500 bg-amber-500/10",
                  !role && "border-border bg-muted/40",
                )}
                style={{ left: `${left}%`, top: `${top}%`, width: `${width}%`, height: `${height}%` }}
              >
                {preview && (
                  <img src={preview} alt={`${screen.name} now`} className="absolute inset-0 size-full object-cover" />
                )}
                <div
                  className={cn(
                    "relative flex max-w-full flex-col items-center gap-1.5 rounded p-1",
                    preview && "bg-background/85",
                  )}
                >
                  <span className="text-sm font-semibold tabular-nums">Screen {screen.index + 1}</span>
                  <span className="max-w-full truncate text-xs font-medium">{screen.name}</span>
                  <span className="text-[10px] font-medium">
                    {role === "audience" ? "Audience · slides" : role === "presenter" ? "Presenter · notes" : "Unused"}
                  </span>
                  <span className="text-[10px] text-muted-foreground tabular-nums">
                    {screen.pixelWidth}×{screen.pixelHeight}
                    {screen.primary ? " · main" : ""}
                  </span>
                  <div className="flex gap-1">
                    <RoleButton
                      label={`Slides on ${screen.name}`}
                      active={role === "audience"}
                      onClick={() => setChoice(choose(choice, "audience", screen.index))}
                    >
                      <MonitorPlay /> Slides
                    </RoleButton>
                    <RoleButton
                      label={`Presenter view on ${screen.name}`}
                      active={role === "presenter"}
                      onClick={() => setChoice(choose(choice, "presenter", screen.index))}
                    >
                      <StickyNote /> Notes
                    </RoleButton>
                  </div>
                </div>
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

function RoleButton(props: { label: string; active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      aria-label={props.label}
      aria-pressed={props.active}
      onClick={props.onClick}
      className={cn(
        "flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] [&_svg]:size-3",
        props.active ? "bg-foreground text-background" : "bg-background/70 text-muted-foreground hover:text-foreground",
      )}
    >
      {props.children}
    </button>
  );
}
