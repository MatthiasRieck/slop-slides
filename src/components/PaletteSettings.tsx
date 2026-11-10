import { Palette, RotateCw } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import type { PaletteEntry } from "../lib/api";
import { applyPreset, colorAt, parseColor, rimColors, rotatePalette, toHex, wheelPoints } from "../lib/colorWheel";
import { PALETTE_PRESETS } from "../lib/palette";
import { useApp } from "../store";
import { Button } from "./Button";
import { selectClass } from "./Field";

const NO_PALETTE: PaletteEntry[] = [];
const WHEEL = 220;
const DOT = 9;
/** How far an arrow key turns the wheel, in degrees (Shift: more). */
const STEP = 5;
const BIG_STEP = 30;

/** The entries of `next` that differ from `from`. */
function changed(from: PaletteEntry[], next: PaletteEntry[]): PaletteEntry[] {
  return next.filter((entry, i) => entry.value !== from[i]?.value);
}

/**
 * Writes palette changes one at a time, dropping all but the latest that come in while one is
 * on its way, so turning the wheel does not queue a write per pointer move.
 */
function useLatestWrite() {
  const busy = useRef<Promise<void> | null>(null);
  const next = useRef<PaletteEntry[] | null>(null);
  return useCallback((colors: PaletteEntry[]): Promise<void> => {
    next.current = colors;
    if (busy.current) return busy.current;
    busy.current = (async () => {
      while (next.current) {
        const send = next.current;
        next.current = null;
        await useApp.getState().setPaletteColors(send);
      }
      busy.current = null;
    })();
    return busy.current;
  }, []);
}

/** The deck's color palette, in Settings mode: its colors, presets, and the color wheel. */
export function PaletteSettings() {
  const palette = useApp((s) => s.deck?.palette) ?? NO_PALETTE;
  const running = useApp((s) => s.running);
  const written = useApp((s) => s.lint?.filter((i) => i.rule === "palette-color").length ?? 0);
  // What the wheel shows while it is turned, before the deck has caught up.
  const [preview, setPreview] = useState<PaletteEntry[] | null>(null);
  const write = useLatestWrite();
  const shown = preview ?? palette;

  const change = (next: PaletteEntry[], from: PaletteEntry[] = palette) => {
    const diff = changed(from, next);
    if (diff.length) void write(diff);
  };

  return (
    <div className="flex flex-col gap-3 p-3 text-xs">
      <div className="flex items-center gap-1.5 font-medium">
        <Palette className="size-3.5" />
        Colors
      </div>
      {palette.length === 0 ? (
        <p className="text-muted-foreground">
          This deck has no palette yet: colors its <code>:root</code> styles name, such as <code>--accent</code>, which
          every slide refers to.
        </p>
      ) : (
        <div className="flex flex-wrap items-start gap-4">
          <ColorWheel
            palette={shown}
            disabled={running}
            onPreview={setPreview}
            onChange={(next, from) => change(next, from)}
            onDone={(next, from) => {
              const diff = changed(from, next);
              void (diff.length ? write(diff) : Promise.resolve()).then(() => setPreview(null));
            }}
          />
          <div className="flex min-w-48 flex-1 flex-col gap-2">
            <select
              aria-label="Apply a palette"
              className={selectClass}
              disabled={running}
              value=""
              onChange={(event) => {
                const preset = PALETTE_PRESETS.find((p) => p.id === event.target.value);
                if (preset) change(applyPreset(palette, preset.colors));
              }}
            >
              <option value="">Apply a palette…</option>
              {PALETTE_PRESETS.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.label}
                </option>
              ))}
            </select>
            <ul aria-label="Palette colors" className="flex flex-col gap-1">
              {shown.map((entry) => (
                <PaletteRow
                  key={entry.name}
                  entry={entry}
                  disabled={running}
                  onChange={(value) => change(shown.map((e) => (e.name === entry.name ? { ...e, value } : e)))}
                />
              ))}
            </ul>
          </div>
        </div>
      )}
      {written > 0 && (
        <div className="flex flex-wrap items-center gap-2 rounded-md border border-dashed p-2 text-muted-foreground">
          <span className="flex-1">
            {written === 1 ? "One line of the deck writes" : `${written} lines of the deck write`} colors out instead of
            taking them from the palette, so the palette does not reach them.
          </span>
          <Button size="sm" variant="outline" disabled={running} onClick={() => void useApp.getState().adoptPalette()}>
            Move into the palette
          </Button>
        </div>
      )}
    </div>
  );
}

/** One palette color: its swatch, which picks a new one, its name and its value. */
function PaletteRow(props: { entry: PaletteEntry; disabled: boolean; onChange: (value: string) => void }) {
  const rgba = parseColor(props.entry.value);
  const hex = rgba ? toHex({ ...rgba, a: 1 }) : null;
  const input = useRef<HTMLInputElement>(null);
  const onChange = useRef(props.onChange);
  onChange.current = props.onChange;
  // The system picker reports every color the pointer passes over; only the one it settles on counts.
  useEffect(() => {
    const el = input.current;
    if (!el) return;
    const settle = () => {
      if (el.value !== hex) onChange.current(el.value);
    };
    el.addEventListener("change", settle);
    return () => el.removeEventListener("change", settle);
  }, [hex]);
  return (
    <li className="flex items-center gap-2">
      {hex ? (
        <input
          ref={input}
          type="color"
          aria-label={`Color ${props.entry.name}`}
          title={props.entry.value}
          disabled={props.disabled}
          defaultValue={hex}
          key={hex}
          className="h-5 w-7 shrink-0 cursor-pointer rounded border-0 bg-transparent p-0 disabled:cursor-default"
        />
      ) : (
        <span className="h-5 w-7 shrink-0 rounded border" style={{ background: props.entry.value }} />
      )}
      <span className="truncate font-mono">--{props.entry.name}</span>
      <span className="ml-auto truncate font-mono text-muted-foreground">{props.entry.value}</span>
    </li>
  );
}

type Drag =
  | { kind: "turn"; from: PaletteEntry[]; start: number; latest: PaletteEntry[] }
  | { kind: "move"; from: PaletteEntry[]; name: string; latest: PaletteEntry[] };

/**
 * The palette on a color wheel: each color a dot at its hue (the angle) and chroma (the
 * distance out), joined into a star. Dragging the wheel turns every color's hue together;
 * dragging a dot moves that one color. Arrow keys turn it too.
 */
function ColorWheel(props: {
  palette: PaletteEntry[];
  disabled: boolean;
  onPreview: (palette: PaletteEntry[] | null) => void;
  onChange: (palette: PaletteEntry[], from: PaletteEntry[]) => void;
  onDone: (palette: PaletteEntry[], from: PaletteEntry[]) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const drag = useRef<Drag | null>(null);
  const [turned, setTurned] = useState(0);
  const center = WHEEL / 2;
  const rim = center - DOT - 3;
  const points = wheelPoints(props.palette);
  const at = (angle: number, radius: number) => ({
    x: center + rim * radius * Math.sin((angle * Math.PI) / 180),
    y: center - rim * radius * Math.cos((angle * Math.PI) / 180),
  });
  // Clockwise from the top, as the wheel draws hues; and how far out, 1 at the rim.
  const polar = (event: { clientX: number; clientY: number }) => {
    const box = ref.current?.getBoundingClientRect();
    const scale = box && box.width ? WHEEL / box.width : 1;
    const dx = (event.clientX - (box?.left ?? 0)) * scale - center;
    const dy = (event.clientY - (box?.top ?? 0)) * scale - center;
    return { angle: ((Math.atan2(dx, -dy) * 180) / Math.PI + 360) % 360, radius: Math.hypot(dx, dy) / rim };
  };
  const star = [...points].sort((a, b) => a.angle - b.angle).map((p) => at(p.angle, p.radius));
  const stops = rimColors(24)
    .map((c, i) => `${c} ${(i * 360) / 24}deg`)
    .join(", ");

  const turnBy = (degrees: number) => {
    const next = rotatePalette(props.palette, degrees);
    setTurned((t) => (((t + degrees) % 360) + 360) % 360);
    props.onDone(next, props.palette);
  };

  return (
    <div className="flex flex-col items-center gap-1.5">
      <div
        ref={ref}
        role="slider"
        tabIndex={props.disabled ? -1 : 0}
        aria-label="Color wheel: drag to turn every color, or drag one color's dot"
        aria-valuemin={0}
        aria-valuemax={359}
        aria-valuenow={Math.round(turned)}
        aria-valuetext={`Turned ${Math.round(turned)}°`}
        aria-disabled={props.disabled}
        className="relative touch-none rounded-full outline-none focus-visible:ring-2 focus-visible:ring-ring"
        style={{ width: WHEEL, height: WHEEL, background: `conic-gradient(${stops})` }}
        onKeyDown={(event) => {
          if (props.disabled) return;
          const step = event.shiftKey ? BIG_STEP : STEP;
          if (event.key === "ArrowRight" || event.key === "ArrowUp") turnBy(step);
          else if (event.key === "ArrowLeft" || event.key === "ArrowDown") turnBy(-step);
          else return;
          event.preventDefault();
        }}
        onPointerDown={(event) => {
          if (props.disabled || event.button !== 0) return;
          const name = (event.target as Element).getAttribute("data-color");
          const from = props.palette;
          drag.current = name
            ? { kind: "move", from, name, latest: from }
            : { kind: "turn", from, start: polar(event).angle, latest: from };
          event.currentTarget.setPointerCapture?.(event.pointerId);
          event.preventDefault();
        }}
        onPointerMove={(event) => {
          const d = drag.current;
          if (!d) return;
          const { angle, radius } = polar(event);
          let next: PaletteEntry[];
          if (d.kind === "turn") {
            next = rotatePalette(d.from, angle - d.start);
          } else {
            const own = d.from.find((e) => e.name === d.name);
            const value = own ? colorAt(own.value, angle, radius) : null;
            if (!value) return;
            next = d.from.map((e) => (e.name === d.name ? { ...e, value } : e));
          }
          d.latest = next;
          props.onPreview(next);
          props.onChange(next, d.from);
        }}
        onPointerUp={(event) => {
          const d = drag.current;
          drag.current = null;
          if (!d) return;
          if (d.kind === "turn") {
            const delta = polar(event).angle - d.start;
            setTurned((t) => (((t + delta) % 360) + 360) % 360);
          }
          props.onDone(d.latest, d.from);
        }}
        onPointerCancel={() => {
          const d = drag.current;
          drag.current = null;
          if (d) props.onDone(d.latest, d.from);
        }}
      >
        <div
          className="pointer-events-none absolute inset-0 rounded-full"
          style={{ background: "radial-gradient(closest-side, var(--card), transparent)" }}
        />
        <svg aria-hidden="true" viewBox={`0 0 ${WHEEL} ${WHEEL}`} className="absolute inset-0">
          {star.length > 1 && (
            <polygon
              points={star.map((p) => `${p.x},${p.y}`).join(" ")}
              className="fill-foreground/5 stroke-foreground/60"
              strokeWidth={1.5}
              strokeLinejoin="round"
            />
          )}
          {points.map((p) => {
            const { x, y } = at(p.angle, p.radius);
            return (
              <g key={p.name}>
                <line x1={center} y1={center} x2={x} y2={y} className="stroke-foreground/40" strokeWidth={1} />
                <circle
                  data-color={p.name}
                  cx={x}
                  cy={y}
                  r={DOT}
                  fill={p.hex}
                  className="cursor-grab stroke-card"
                  strokeWidth={2.5}
                >
                  <title>{`--${p.name}: ${p.value}`}</title>
                </circle>
              </g>
            );
          })}
          <circle cx={center} cy={center} r={3} className="fill-foreground/60" />
        </svg>
      </div>
      <div className="flex items-center gap-1 text-muted-foreground">
        <RotateCw className="size-3" />
        Drag the wheel to turn every color; grays stay put.
      </div>
    </div>
  );
}
