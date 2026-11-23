import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { tooltipOf } from "../test/ui";
import { ScriptField, ScriptMarkdown, ScriptPreviewToggle } from "./ScriptMarkdown";

describe("ScriptPreviewToggle", () => {
  it("offers the preview while the script is written, and says what it is written in", () => {
    const onChange = vi.fn();
    render(<ScriptPreviewToggle preview={false} onChange={onChange} />);
    const toggle = screen.getByRole("button", { name: "Preview", pressed: false });
    expect(tooltipOf(toggle)).toBe("Written in Markdown");
    fireEvent.click(toggle);
    expect(onChange).toHaveBeenCalledWith(true);
  });

  it("offers to go on writing while the preview shows", () => {
    const onChange = vi.fn();
    render(<ScriptPreviewToggle preview onChange={onChange} />);
    fireEvent.click(screen.getByRole("button", { name: "Edit", pressed: true }));
    expect(onChange).toHaveBeenCalledWith(false);
  });
});

describe("ScriptField", () => {
  const field = (patch: Partial<Parameters<typeof ScriptField>[0]> = {}) => {
    const props = {
      label: "Speaker notes",
      draft: "Say **hello**.",
      preview: false,
      readOnly: false,
      placeholder: "Nothing yet",
      onChange: vi.fn(),
      onBlur: vi.fn(),
      ...patch,
    };
    render(<ScriptField {...props} />);
    return props;
  };

  it("is a text box named for what is written in it, which tells of what is typed and of being left", () => {
    const props = field();
    const box = screen.getByRole("textbox", { name: "Speaker notes" }) as HTMLTextAreaElement;
    expect(box.dataset.slot).toBe("textarea");
    expect(box.value).toBe("Say **hello**.");
    expect(box.placeholder).toBe("Nothing yet");
    // As tall as the room it has, scrolling its text: it does not grow with it.
    expect(box.className).toContain("field-sizing-fixed");
    expect(box.className).toContain("selectable");
    fireEvent.change(box, { target: { value: "Say goodbye." } });
    expect(props.onChange).toHaveBeenCalledWith("Say goodbye.");
    fireEvent.blur(box);
    expect(props.onBlur).toHaveBeenCalledOnce();
  });

  it("cannot be typed in while it is read only", () => {
    field({ readOnly: true });
    expect((screen.getByRole("textbox", { name: "Speaker notes" }) as HTMLTextAreaElement).readOnly).toBe(true);
  });

  it("shows how the text looks in the preview, or what to write when there is none", () => {
    field({ preview: true });
    const preview = screen.getByRole("document", { name: "Speaker notes preview" });
    expect(preview.querySelector("strong")!.textContent).toBe("hello");
    expect(screen.queryByRole("textbox")).toBeNull();
  });

  it("says what to write in the preview of an empty script", () => {
    field({ preview: true, draft: "  " });
    expect(screen.getByRole("document", { name: "Speaker notes preview" }).textContent).toBe("Nothing yet");
  });
});

describe("ScriptMarkdown", () => {
  it("shows neither links nor pictures, and keeps code as plain text", () => {
    const { container } = render(
      <ScriptMarkdown text={"See [the docs](https://example.com) ![logo](logo.png)\n\n```\ncode\n```"} />,
    );
    expect(container.querySelector("a")).toBeNull();
    expect(container.querySelector("img")).toBeNull();
    expect(container.textContent).toContain("the docs");
    // A script's code is a plain block: the chat's own blocks of code are the chat's.
    expect(container.querySelector("pre")!.hasAttribute("data-slot")).toBe(false);
    expect(container.querySelector("[data-slot=code-block]")).toBeNull();
  });
});
