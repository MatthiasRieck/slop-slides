import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { FolderOpen } from "lucide-react";
import { type ReactNode, useState } from "react";

import { api, errorMessage } from "../lib/api";
import { revealLabel } from "../lib/utils";
import { type RewindChoice, rememberedRewind, rememberRewind, useApp } from "../store";
import { Button } from "./Button";
import { SectionLabel } from "./SectionLabel";

/** The rewind answer kept in storage: "ask" until the user picks one to keep giving. */
type RewindSetting = RewindChoice | "ask";

function loadRewind(): RewindSetting {
  return rememberedRewind() ?? "ask";
}

/** The app's settings, in a sidebar tab: how undoing an agent's changes treats the chat, review marks, the library. */
export function SettingsPanel() {
  const [rewind, setRewind] = useState(loadRewind);
  const reviewVisible = useApp((s) => s.reviewVisible);

  const pickRewind = (value: RewindSetting) => {
    rememberRewind(value === "ask" ? null : value);
    setRewind(value);
  };

  const revealLibrary = async () => {
    try {
      await revealItemInDir(await api.libraryFolder());
    } catch (error) {
      useApp.getState().setError(errorMessage(error));
    }
  };

  const option = (value: RewindSetting, label: string) => (
    <label className="flex cursor-pointer items-center gap-2 text-sm">
      <input
        type="radio"
        name="settings-rewind"
        className="accent-primary"
        checked={rewind === value}
        onChange={() => pickRewind(value)}
      />
      {label}
    </label>
  );

  return (
    <div className="flex h-full flex-col gap-6 overflow-y-auto p-4">
      <Section
        title="Undoing a chat message's changes"
        hint="What happens to the chat when you undo what the agent did."
      >
        {option("ask", "Ask each time")}
        {option("rewind", "Also rewind the chat")}
        {option("deck", "Only undo the deck changes")}
      </Section>
      <Section title="Review">
        <label className="flex cursor-pointer items-center gap-2 text-sm">
          <input
            type="checkbox"
            className="accent-primary"
            checked={reviewVisible}
            onChange={(event) => useApp.getState().setReviewVisible(event.target.checked)}
          />
          Show review marks and comments on the slides
        </label>
      </Section>
      <Section title="Library" hint="New decks from the start screen are kept in the SlopSlide library.">
        <div>
          <Button variant="outline" size="sm" onClick={() => void revealLibrary()}>
            <FolderOpen className="size-3.5" />
            {revealLabel}
          </Button>
        </div>
      </Section>
    </div>
  );
}

function Section({ title, hint, children }: { title: string; hint?: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-2">
      <div className="flex flex-col gap-0.5">
        <SectionLabel as="h2">{title}</SectionLabel>
        {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
      </div>
      {children}
    </section>
  );
}
