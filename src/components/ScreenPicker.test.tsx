import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Screen } from "../lib/api";
import { saveChoice } from "../lib/screens";
import { ScreenPicker } from "./ScreenPicker";

const screens: Screen[] = [
  {
    index: 0,
    name: "Built-in",
    x: 0,
    y: 0,
    width: 1512,
    height: 982,
    pixelWidth: 3024,
    pixelHeight: 1964,
    primary: true,
  },
  {
    index: 1,
    name: "Projector",
    x: 1512,
    y: 0,
    width: 1920,
    height: 1080,
    pixelWidth: 1920,
    pixelHeight: 1080,
    primary: false,
  },
];

beforeEach(() => localStorage.clear());

describe("ScreenPicker", () => {
  it("shows every screen and starts with the show on the last one", () => {
    const onStart = vi.fn();
    render(<ScreenPicker screens={screens} onStart={onStart} onCancel={() => {}} onWindows={() => {}} />);
    expect(screen.getByTestId("screen-0").dataset.role).toBe("presenter");
    expect(screen.getByTestId("screen-1").dataset.role).toBe("audience");
    fireEvent.click(screen.getByText("Start presenting"));
    expect(onStart).toHaveBeenCalledWith({ audience: 1, presenter: 0 });
  });

  it("says what a screen is called, what it shows and how big it is", () => {
    render(<ScreenPicker screens={screens} onStart={() => {}} onCancel={() => {}} onWindows={() => {}} />);
    expect(screen.getByTestId("screen-0").textContent).toBe("Built-inPresenter view3024×1964");
    expect(screen.getByTestId("screen-1").textContent).toBe("ProjectorSlides1920×1080");
  });

  it("names each screen's role in words, as it changes", () => {
    const threeScreens = [...screens, { ...screens[1], index: 2, name: "Side", x: 3432 } as Screen];
    render(<ScreenPicker screens={threeScreens} onStart={() => {}} onCancel={() => {}} onWindows={() => {}} />);
    const roles = () => [0, 1, 2].map((i) => screen.getByTestId(`screen-role-${i}`).textContent);
    expect(roles()).toEqual(["Presenter view", "Not used", "Slides"]);
    fireEvent.click(screen.getByLabelText("Slides on Projector"));
    expect(roles()).toEqual(["Presenter view", "Slides", "Not used"]);
    fireEvent.click(screen.getByLabelText("No presenter view"));
    expect(roles()).toEqual(["Not used", "Slides", "Not used"]);
  });

  it("puts the slides on the screen that is not the main one, wherever it is listed", () => {
    const onStart = vi.fn();
    const swapped = [
      { ...screens[1]!, index: 0 },
      { ...screens[0]!, index: 1 },
    ];
    render(<ScreenPicker screens={swapped} onStart={onStart} onCancel={() => {}} onWindows={() => {}} />);
    expect(screen.getByTestId("screen-role-0").textContent).toBe("Slides");
    fireEvent.click(screen.getByText("Start presenting"));
    expect(onStart).toHaveBeenCalledWith({ audience: 0, presenter: 1 });
  });

  it("swaps the slides and the presenter view", () => {
    const onStart = vi.fn();
    render(<ScreenPicker screens={screens} onStart={onStart} onCancel={() => {}} onWindows={() => {}} />);
    const swap = screen.getByRole("button", { name: "Swap" }) as HTMLButtonElement;
    fireEvent.click(swap);
    expect(screen.getByTestId("screen-0").dataset.role).toBe("audience");
    expect(screen.getByTestId("screen-1").dataset.role).toBe("presenter");
    fireEvent.click(screen.getByText("Start presenting"));
    expect(onStart).toHaveBeenCalledWith({ audience: 0, presenter: 1 });
    // Without a presenter view there is nothing to swap, and it says so.
    fireEvent.click(screen.getByLabelText("No presenter view"));
    expect(swap.disabled).toBe(true);
    expect(swap.title).toMatch(/Pick a screen for the presenter view first/);
  });

  it("starts with what was picked last for these screens", () => {
    saveChoice(screens, { audience: 0, presenter: 1 });
    render(<ScreenPicker screens={screens} onStart={() => {}} onCancel={() => {}} onWindows={() => {}} />);
    expect(screen.getByTestId("screen-0").dataset.role).toBe("audience");
    expect(screen.getByTestId("screen-1").dataset.role).toBe("presenter");
  });

  it("has the focus on Start presenting, so Enter starts the show", () => {
    render(<ScreenPicker screens={screens} onStart={() => {}} onCancel={() => {}} onWindows={() => {}} />);
    expect(document.activeElement).toBe(screen.getByText("Start presenting"));
  });

  it("has each role on one screen", () => {
    const threeScreens = [...screens, { ...screens[1], index: 2, name: "Side", x: 3432 } as Screen];
    render(<ScreenPicker screens={threeScreens} onStart={() => {}} onCancel={() => {}} onWindows={() => {}} />);
    fireEvent.click(screen.getByLabelText("Slides on Projector"));
    fireEvent.click(screen.getByLabelText("Presenter view on Side"));
    const pressed = screen.getAllByRole("button", { pressed: true }).map((b) => b.getAttribute("aria-label"));
    expect(pressed).toEqual(["Slides on Projector", "Presenter view on Side"]);
  });

  it("takes the notes off a screen the slides are put on, for them to go on another", () => {
    const onStart = vi.fn();
    render(<ScreenPicker screens={screens} onStart={onStart} onCancel={() => {}} onWindows={() => {}} />);
    fireEvent.click(screen.getByLabelText("Slides on Built-in"));
    expect(screen.getByTestId("screen-0").dataset.role).toBe("audience");
    expect(screen.getByTestId("screen-1").dataset.role).toBe("");
    expect((screen.getByLabelText("No presenter view") as HTMLInputElement).checked).toBe(true);
    fireEvent.click(screen.getByLabelText("Presenter view on Projector"));
    fireEvent.click(screen.getByText("Start presenting"));
    expect(onStart).toHaveBeenCalledWith({ audience: 0, presenter: 1 });
  });

  it("can't put the notes on the slides' screen", () => {
    render(<ScreenPicker screens={screens} onStart={() => {}} onCancel={() => {}} onWindows={() => {}} />);
    const button = screen.getByLabelText("Presenter view on Projector") as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    fireEvent.click(button);
    expect(screen.getByTestId("screen-1").dataset.role).toBe("audience");
    expect((screen.getByLabelText("Presenter view on Built-in") as HTMLButtonElement).disabled).toBe(false);
  });

  it("can go without a presenter view", () => {
    const onStart = vi.fn();
    render(<ScreenPicker screens={screens} onStart={onStart} onCancel={() => {}} onWindows={() => {}} />);
    fireEvent.click(screen.getByLabelText("No presenter view"));
    fireEvent.click(screen.getByText("Start presenting"));
    expect(onStart).toHaveBeenCalledWith({ audience: 1, presenter: null });
  });

  it("can present in windows instead, for sharing the slides' window in a call", () => {
    const onStart = vi.fn();
    const onWindows = vi.fn();
    render(<ScreenPicker screens={screens} onStart={onStart} onCancel={() => {}} onWindows={onWindows} />);
    fireEvent.click(screen.getByRole("button", { name: /Present in windows/ }));
    expect(onWindows).toHaveBeenCalled();
    expect(onStart).not.toHaveBeenCalled();
  });

  it("shows a screenshot of the screens that have one", () => {
    const shot = "data:image/png;base64,AAAA";
    render(
      <ScreenPicker
        screens={screens}
        previews={[null, shot]}
        onStart={() => {}}
        onCancel={() => {}}
        onWindows={() => {}}
      />,
    );
    expect(screen.getByAltText("Projector now").getAttribute("src")).toBe(shot);
    expect(screen.queryByAltText("Built-in now")).toBeNull();
  });

  it("works without screenshots", () => {
    render(<ScreenPicker screens={screens} onStart={() => {}} onCancel={() => {}} onWindows={() => {}} />);
    expect(screen.queryByRole("img")).toBeNull();
    expect(screen.getByText("Built-in")).toBeTruthy();
  });

  it("shows a placeholder on every screen while the screenshots are taken", () => {
    const { rerender } = render(
      <ScreenPicker screens={screens} previews={null} onStart={() => {}} onCancel={() => {}} onWindows={() => {}} />,
    );
    expect(screen.getByLabelText("Taking a screenshot of Built-in")).toBeTruthy();
    expect(screen.getByLabelText("Taking a screenshot of Projector")).toBeTruthy();
    rerender(
      <ScreenPicker
        screens={screens}
        previews={[null, "data:,"]}
        onStart={() => {}}
        onCancel={() => {}}
        onWindows={() => {}}
      />,
    );
    expect(screen.queryByRole("status")).toBeNull();
    expect(screen.getByAltText("Projector now")).toBeTruthy();
  });

  it("can be used before the screenshots are there", () => {
    const onStart = vi.fn();
    render(
      <ScreenPicker screens={screens} previews={null} onStart={onStart} onCancel={() => {}} onWindows={() => {}} />,
    );
    fireEvent.click(screen.getByText("Start presenting"));
    expect(onStart).toHaveBeenCalledWith({ audience: 1, presenter: 0 });
  });

  it("cancels with Escape", () => {
    const onCancel = vi.fn();
    render(<ScreenPicker screens={screens} onStart={() => {}} onCancel={onCancel} onWindows={() => {}} />);
    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(onCancel).toHaveBeenCalled();
  });
});
