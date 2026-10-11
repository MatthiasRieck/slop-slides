import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));
import { useApp } from "../store";
import { useNarration } from "../narrationStore";
import { useSpeech } from "../speechStore";
import { emptyNarration, emptyScript } from "../lib/narration";
import { DECK_HTML, deckFor } from "../test/fixtures";
import { alternateSpeechProvider, testSpeechProvider } from "../test/speech";
import { PresentationPresets } from "./PresentationPresets";

beforeEach(() => {
  const document = emptyNarration();
  document.manifest.slides.intro = { ...emptyScript(), text: "Welcome", presenterIdOverride: "preset:aiden" };
  useApp.setState({ deck: deckFor(DECK_HTML) });
  useNarration.setState({ deckId: "talk", document, edits: {}, settingsEdits: {}, languageEdit: null, error: null, conflict: null });
  useSpeech.setState({ status: { providers: [testSpeechProvider()], job: null }, job: null });
  vi.spyOn(useSpeech.getState(), "initialize").mockResolvedValue();
});

it("shows the sole provider as the deck preset and edits shared settings only", () => {
  render(<PresentationPresets />);
  expect((screen.getByLabelText("Presentation speech provider") as HTMLSelectElement).disabled).toBe(true);
  expect(screen.queryByText("Draft blank slides…")).toBeNull();
  fireEvent.change(screen.getByLabelText("Default narration presenter"), { target: { value: "preset:aiden" } });
  fireEvent.change(screen.getByLabelText("Deck narration language"), { target: { value: "de" } });
  fireEvent.change(screen.getByLabelText("Default narration pace"), { target: { value: "1.2" } });
  expect(useNarration.getState().settingsEdits).toMatchObject({ presenterId: "preset:aiden", pace: 1.2 });
  expect(useNarration.getState().languageEdit).toBe("de");
  expect(useNarration.getState().edits).toEqual({});
  expect(useNarration.getState().document!.manifest.slides.intro!.presenterIdOverride).toBe("preset:aiden");
});

it("keeps an incompatible voice visible until a matching presenter is chosen", () => {
  useSpeech.setState({ status: { providers: [testSpeechProvider(), alternateSpeechProvider()], job: null } });
  render(<PresentationPresets />);
  fireEvent.change(screen.getByLabelText("Presentation speech provider"), { target: { value: "fixture-tone" } });
  expect(useNarration.getState().settingsEdits.speechProviderId).toBe("fixture-tone");
  expect(screen.getByText(/Choose a presenter supported/)).toBeTruthy();
  expect((screen.getByLabelText("Default narration presenter") as HTMLSelectElement).value).toBe("preset:ryan");
  fireEvent.change(screen.getByLabelText("Default narration presenter"), { target: { value: "tone:440" } });
  expect(useNarration.getState().settingsEdits.presenterId).toBe("tone:440");
  expect(screen.queryByText(/Choose a presenter supported/)).toBeNull();
});
