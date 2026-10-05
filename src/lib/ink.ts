/** Presenter annotation tools: the pure parts, shared by the overlay and its tests. */

export type Tool = "pointer" | "laser" | "pen" | "highlighter" | "eraser";
export type InkTool = "pen" | "highlighter";

/** A freehand line, in fractions of the screen so it survives window resizes. */
export interface Stroke {
  tool: InkTool;
  color: string;
  points: [number, number][];
}

/** Single-key shortcuts while presenting. Pressing the active tool's key puts it away. */
export const TOOL_KEYS: Record<string, Tool> = { l: "laser", p: "pen", h: "highlighter", e: "eraser" };

export const INK_COLORS = ["#ef4444", "#facc15", "#22c55e", "#3b82f6", "#ffffff"] as const;
export const DEFAULT_COLORS: Record<InkTool, string> = { pen: "#ef4444", highlighter: "#facc15" };

/** Stroke width in screen pixels, and opacity, per tool. */
export const INK_STYLE: Record<InkTool, { width: number; opacity: number }> = {
  pen: { width: 4, opacity: 1 },
  highlighter: { width: 28, opacity: 0.4 },
};

/** Screen pixel positions of a stroke's points, on a layer of the given size. */
export function toPixels(points: readonly [number, number][], width: number, height: number): [number, number][] {
  return points.map(([x, y]) => [px(x * width), px(y * height)]);
}

/** A stroke that never moved (a tap); drawn as a dot, since a zero-length path renders unreliably. */
export function isDot(points: readonly [number, number][]): boolean {
  const [first] = points;
  return !!first && points.every(([x, y]) => x === first[0] && y === first[1]);
}

/** SVG path data through pixel positions. */
export function strokePath(points: readonly [number, number][]): string {
  return points.map(([x, y], i) => `${i ? "L" : "M"}${x} ${y}`).join("");
}

/** Position of a pointer event inside `rect`, as fractions of its size. */
export function toFraction(clientX: number, clientY: number, rect: DOMRect): [number, number] {
  const x = (clientX - rect.left) / (rect.width || 1);
  const y = (clientY - rect.top) / (rect.height || 1);
  return [round(x), round(y)];
}

const round = (n: number) => Math.round(n * 10_000) / 10_000;
const px = (n: number) => Math.round(n * 10) / 10;
