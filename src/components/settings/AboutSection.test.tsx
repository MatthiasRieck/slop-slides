import { act, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const getVersion = vi.hoisted(() => vi.fn<() => Promise<string>>());
vi.mock("@tauri-apps/api/app", () => ({ getVersion }));

import { AboutSection } from "./AboutSection";

beforeEach(() => void getVersion.mockReset());

describe("AboutSection", () => {
  it("says which version of the app this is", async () => {
    getVersion.mockResolvedValue("1.2.3");
    render(<AboutSection />);
    expect((await screen.findByTestId("app-version")).textContent).toBe("SlopSlide 1.2.3");
    expect(screen.getByRole("heading", { name: "Version" })).toBeTruthy();
  });

  it("leaves the version out where there is none to read", async () => {
    getVersion.mockRejectedValue("no app");
    render(<AboutSection />);
    await act(async () => {});
    expect(screen.queryByTestId("app-version")).toBeNull();
    expect(screen.getByRole("heading", { name: "Version" })).toBeTruthy();
  });
});
