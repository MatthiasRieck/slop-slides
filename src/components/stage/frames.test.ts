import { describe, expect, it } from "vitest";

import { isEditTool, toolMessage } from "./editKeys";
import { fromFrameIn, toAppPoint, toFramePoint } from "./frames";

/** A preview 1920 px wide inside, shown at `width` app pixels from (`left`, `top`). */
function shownFrame(left: number, top: number, width: number) {
  const frame = document.createElement("iframe");
  Object.defineProperty(frame, "clientWidth", { value: 1920 });
  frame.getBoundingClientRect = () => new DOMRect(left, top, width, (width * 9) / 16);
  return frame;
}

describe("the stage's previews", () => {
  it("maps points between the preview's pixels and the app's, scaled down to fit", () => {
    const frame = shownFrame(100, 50, 960);
    expect(toAppPoint(frame, 200, 40)).toEqual({ x: 200, y: 70 });
    expect(toFramePoint(frame, 200, 70)).toEqual({ x: 200, y: 40 });
  });

  it("takes the points as they are without a preview, or one not laid out", () => {
    expect(toAppPoint(null, 12, 34)).toEqual({ x: 12, y: 34 });
    const unlaid = document.createElement("iframe");
    unlaid.getBoundingClientRect = () => new DOMRect(10, 20, 0, 0);
    expect(toAppPoint(unlaid, 5, 5)).toEqual({ x: 15, y: 25 });
    expect(toFramePoint(unlaid, 15, 25)).toEqual({ x: 5, y: 5 });
  });

  it("tells messages from the previews in an area from any other", () => {
    const area = document.createElement("div");
    const frame = document.createElement("iframe");
    area.append(frame);
    document.body.append(area);
    expect(fromFrameIn(area, frame.contentWindow)).toBe(true);
    expect(fromFrameIn(area, window)).toBe(false);
    expect(fromFrameIn(null, frame.contentWindow)).toBe(false);
    area.remove();
  });
});

describe("the editor's tools", () => {
  it("knows the tools the editor reports", () => {
    expect(isEditTool("rect")).toBe(true);
    expect(isEditTool("block-arrow")).toBe(true);
    expect(isEditTool("laser")).toBe(false);
  });

  it("sends a tool with the style of what it adds", () => {
    const styles = { shape: { fill: "#f00" }, text: { fontSize: 40 } };
    expect(toolMessage("rect", styles)).toEqual({ type: "slop:edit-tool", tool: "rect", style: { fill: "#f00" } });
    expect(toolMessage("select", styles)).toEqual({ type: "slop:edit-tool", tool: "select", style: undefined });
  });
});
