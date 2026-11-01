import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { SectionLabel } from "./SectionLabel";

const LABEL = "text-2xs font-medium uppercase tracking-wide text-muted-foreground";

describe("SectionLabel", () => {
  it("is a span by default", () => {
    render(<SectionLabel>Slides</SectionLabel>);
    const label = screen.getByText("Slides");
    expect(label.tagName).toBe("SPAN");
    expect(label.className).toBe(LABEL);
  });

  it("can be a heading", () => {
    render(<SectionLabel as="h2">Open</SectionLabel>);
    expect(screen.getByRole("heading", { level: 2, name: "Open" }).className).toBe(LABEL);
  });

  it("takes extra classes and attributes", () => {
    const onDoubleClick = vi.fn();
    render(
      <SectionLabel className="min-w-0 truncate" title="Rename" onDoubleClick={onDoubleClick}>
        Intro
      </SectionLabel>,
    );
    const label = screen.getByTitle("Rename");
    expect(label.className.split(" ").sort()).toEqual(`${LABEL} min-w-0 truncate`.split(" ").sort());
    label.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    expect(onDoubleClick).toHaveBeenCalled();
  });
});
