import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ErrorBoundary, errorDetails } from "./ErrorBoundary";

/** Whether the part under the boundary throws as it renders. */
let broken = false;
function Part() {
  if (broken) throw new Error("Cannot read properties of null (reading 'filter')");
  return <p>The chat</p>;
}

beforeEach(() => {
  broken = false;
  // React reports what a boundary caught; the boundary logs it too.
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe("ErrorBoundary", () => {
  it("shows what it holds while all is well", () => {
    render(
      <ErrorBoundary name="the sidebar">
        <Part />
      </ErrorBoundary>,
    );
    expect(screen.getByText("The chat")).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("says that something went wrong in place of a part that threw, leaving what is around it", () => {
    broken = true;
    render(
      <>
        <p>The slide</p>
        <ErrorBoundary name="the sidebar">
          <Part />
        </ErrorBoundary>
      </>,
    );
    const alert = screen.getByRole("alert");
    expect(alert.textContent).toContain("Something went wrong here");
    expect(alert.textContent).toContain("A problem stopped the sidebar from showing.");
    expect(alert.textContent).toContain("The rest of the app still works");
    // No raw error in the user's face.
    expect(alert.textContent).not.toContain("Cannot read properties");
    expect(screen.getByText("The slide")).toBeTruthy();
    expect(console.error).toHaveBeenCalled();
  });

  it("loads the part again on request, and shows it once it renders", () => {
    broken = true;
    render(
      <ErrorBoundary name="the sidebar">
        <Part />
      </ErrorBoundary>,
    );
    // Still broken: it says so again rather than going blank.
    fireEvent.click(screen.getByRole("button", { name: "Reload this part" }));
    expect(screen.getByRole("alert")).toBeTruthy();
    broken = false;
    fireEvent.click(screen.getByRole("button", { name: "Reload this part" }));
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByText("The chat")).toBeTruthy();
  });

  it("copies what happened, for a report", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText } });
    broken = true;
    render(
      <ErrorBoundary name="the sidebar">
        <Part />
      </ErrorBoundary>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Copy details" }));
    expect(await screen.findByRole("button", { name: "Copied" })).toBeTruthy();
    const copied = writeText.mock.calls[0]![0] as string;
    expect(copied).toContain("Cannot read properties of null (reading 'filter')");
    // Where in the app it happened.
    expect(copied).toContain("Part");
    vi.unstubAllGlobals();
  });

  it("offers to reload the window when the whole of it went down", () => {
    const reload = vi.fn();
    vi.stubGlobal("location", { ...window.location, reload });
    broken = true;
    render(
      <ErrorBoundary name="the window" scope="window">
        <Part />
      </ErrorBoundary>,
    );
    expect(screen.getByRole("alert").classList.contains("fixed")).toBe(true);
    expect(screen.queryByRole("button", { name: "Reload this part" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Reload the window" }));
    expect(reload).toHaveBeenCalledOnce();
    vi.unstubAllGlobals();
  });

  it("writes up an error with its stack, and anything else thrown as it is", () => {
    const error = new Error("gone");
    expect(errorDetails(error, "\n    at Sidebar")).toBe(`${error.stack}\n\nIn:\n    at Sidebar`);
    expect(errorDetails("just text", "")).toBe("just text\n\nIn:");
  });
});
