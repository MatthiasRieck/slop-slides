import { AppWindow, ArrowLeftRight, MonitorPlay, StickyNote } from "lucide-react";
import { useId, useRef, useState } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";

import type { Screen } from "../lib/api";
import { arrange, choose, loadChoice, type ScreenChoice, swap } from "../lib/screens";
import { cn } from "../lib/utils";

/** How tall the drawing of the screens gets; it narrows to keep their shape. */
const MAX_HEIGHT_REM = 16;

/** The small print on a screen, which stays readable over a screenshot. */
const LABEL = "relative block h-auto max-w-full truncate rounded px-1.5 py-px text-[10px]";

/** What a screen is used for, in words: its border's color alone would not say. */
const ROLE_NAMES = { audience: "Slides", presenter: "Presenter view", none: "Not used" } as const;

/**
 * Shown when presenting with several screens attached: the screens drawn the way they sit on
 * the desk, each saying what it shows ("Slides", "Presenter view", "Not used"), with a button on
 * each for the audience's slides and one for the presenter view (notes, next slide, timers). Each
 * is on one screen at a time, and Swap exchanges the two. It starts with what was picked last for
 * these screens, or else with the slides on a screen that is not the computer's main one (see
 * `loadChoice`). A screenshot of a screen, where there is one, makes it easy to recognize. Enter
 * starts the show. Or the show goes in windows instead, for sharing the slides' window in a call.
 */
export function ScreenPicker(props: {
  screens: Screen[];
  /** A screenshot for each screen, by its index; null while they are being taken. */
  previews?: (string | null)[] | null;
  onStart: (choice: ScreenChoice) => void;
  /** Presents in windows instead of on the screens. */
  onWindows: () => void;
  onCancel: () => void;
}) {
  const { screens } = props;
  const [choice, setChoice] = useState(() => loadChoice(screens));
  const { aspect, boxes } = arrange(screens);
  const start = useRef<HTMLButtonElement>(null);
  const noPresenterId = useId();

  return (
    <Dialog
      open
      disablePointerDismissal
      onOpenChange={(open) => {
        if (!open) props.onCancel();
      }}
    >
      <DialogContent
        aria-label="Choose screens"
        showCloseButton={false}
        // Enter starts the show with what is picked.
        initialFocus={start}
        className="sm:max-w-[34rem]"
      >
        <DialogHeader>
          <h2 className="text-base leading-none font-medium">Present on</h2>
          <DialogDescription className="text-xs">
            Screens match the arrangement in your system display settings. Pick where your slides and notes appear.
          </DialogDescription>
        </DialogHeader>
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
                  role === "presenter" && "border-warning bg-warning/10",
                  !role && "border-border bg-muted/40",
                )}
                style={{ left: `${left}%`, top: `${top}%`, width: `${width}%`, height: `${height}%` }}
              >
                {preview && (
                  <img src={preview} alt={`${screen.name} now`} className="absolute inset-0 size-full object-cover" />
                )}
                {props.previews === null && (
                  <>
                    <Skeleton className="absolute inset-0 rounded-none" />
                    <Spinner
                      aria-label={`Taking a screenshot of ${screen.name}`}
                      className="absolute top-1 right-1 size-3.5 text-muted-foreground"
                    />
                  </>
                )}
                <Badge variant="outline" className={cn(LABEL, "border-transparent bg-background/85")}>
                  {screen.name}
                </Badge>
                <Badge
                  data-testid={`screen-role-${screen.index}`}
                  variant={role === "audience" ? "default" : "outline"}
                  className={cn(
                    LABEL,
                    "border-transparent font-semibold",
                    role === "presenter" && "bg-warning text-warning-foreground",
                    !role && "bg-background/85 text-muted-foreground",
                  )}
                >
                  {ROLE_NAMES[role ?? "none"]}
                </Badge>
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
                <Badge variant="outline" className={cn(LABEL, "border-transparent bg-background/85 tabular-nums")}>
                  {screen.pixelWidth}×{screen.pixelHeight}
                </Badge>
              </div>
            );
          })}
        </div>
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <Checkbox
              id={noPresenterId}
              checked={choice.presenter === null}
              onCheckedChange={(checked) =>
                setChoice({
                  ...choice,
                  presenter: checked ? null : (screens.find((s) => s.index !== choice.audience)?.index ?? null),
                })
              }
            />
            <Label htmlFor={noPresenterId} className="text-xs font-normal">
              No presenter view
            </Label>
          </div>
          <Button
            variant="outline"
            size="xs"
            tooltip={
              choice.presenter === null
                ? "Pick a screen for the presenter view first"
                : "Put the slides where the presenter view is, and the presenter view where the slides are"
            }
            disabled={choice.presenter === null}
            onClick={() => setChoice(swap(choice))}
          >
            <ArrowLeftRight data-icon="inline-start" />
            Swap
          </Button>
        </div>
        <DialogFooter>
          <Button
            variant="ghost"
            size="sm"
            tooltip="The slides in this window and the presenter view in another, to share the slides' window in a call"
            onClick={props.onWindows}
            className="text-muted-foreground sm:mr-auto"
          >
            <AppWindow data-icon="inline-start" />
            Present in windows
          </Button>
          <Button variant="ghost" size="sm" onClick={props.onCancel} className="text-muted-foreground">
            Cancel
          </Button>
          <Button ref={start} size="sm" onClick={() => props.onStart(choice)}>
            Start presenting
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** A button on a screen that puts the slides or the presenter view there; pressed while it is there. */
function RoleButton(props: {
  label: string;
  shows: "audience" | "presenter";
  active: boolean;
  disabled?: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <Button
      variant={props.active && props.shows === "audience" ? "default" : "secondary"}
      size="icon"
      tooltip={props.label}
      aria-pressed={props.active}
      disabled={props.disabled}
      onClick={props.onClick}
      className={cn(
        "shadow-sm",
        props.active && props.shows === "presenter" && "bg-warning text-warning-foreground hover:bg-warning/80",
        !props.active && "bg-background/85 text-muted-foreground hover:bg-background hover:text-foreground",
      )}
    >
      {props.children}
    </Button>
  );
}
