import { Bot, Info, Keyboard, SlidersHorizontal, X } from "lucide-react";
import type { ComponentType } from "react";

import { useRovingTabs } from "../../hooks/useRovingTabs";
import { cn } from "../../lib/utils";
import { SETTINGS_SECTIONS, type SettingsSection, useApp } from "../../store";
import { ToolButton } from "../Button";
import { Dialog } from "../Dialog";
import { AboutSection } from "./AboutSection";
import { GeneralSection } from "./GeneralSection";
import { KeyboardSection } from "./KeyboardSection";
import { ProvidersSection } from "./ProvidersSection";

/** What each section of the settings is called and shows. Add one here and to `SETTINGS_SECTIONS` in the store. */
const PANES: Record<SettingsSection, { label: string; icon: typeof Info; content: ComponentType }> = {
  general: { label: "General", icon: SlidersHorizontal, content: GeneralSection },
  providers: { label: "Providers", icon: Bot, content: ProvidersSection },
  keyboard: { label: "Keyboard shortcuts", icon: Keyboard, content: KeyboardSection },
  about: { label: "About", icon: Info, content: AboutSection },
};

const tabId = (section: SettingsSection) => `settings-tab-${section}`;

/**
 * The app's settings, for every deck and window, in a dialog over the app: the sections listed on
 * the left (↑ and ↓ go through them), the one picked on the right under its name. It opens from
 * the gear in the top bar and on ⌘, (on General), and on `?` or ⌘/ (on Keyboard shortcuts);
 * `openSettings` in ../../store.ts opens it on any section. Escape and the close button close
 * it; a press beside it does not, so a slip of the pointer loses nothing. Rendered while
 * `settingsSection` says a section (see ../../App.tsx).
 */
export function SettingsDialog() {
  const section = useApp((s) => s.settingsSection);
  const tabs = useRovingTabs("vertical");
  if (!section) return null;
  const close = () => useApp.getState().closeSettings();
  const { label, content: Content } = PANES[section];
  return (
    <Dialog
      label="Settings"
      onClose={close}
      backdropTestId="settings-backdrop"
      className="flex h-[38rem] max-h-[calc(100vh-4rem)] w-[54rem] max-w-[calc(100vw-2rem)] overflow-hidden rounded-xl border bg-background text-foreground shadow-2xl outline-none"
    >
      <nav className="flex w-48 shrink-0 flex-col gap-3 border-r bg-sidebar p-3">
        <h2 className="px-2 pt-1.5 text-sm font-semibold">Settings</h2>
        <div
          ref={tabs.ref}
          role="tablist"
          aria-label="Settings"
          aria-orientation="vertical"
          onKeyDown={tabs.onKeyDown}
          className="flex flex-col gap-0.5"
        >
          {SETTINGS_SECTIONS.map((id) => {
            const { label: name, icon: Icon } = PANES[id];
            return (
              <button
                key={id}
                type="button"
                role="tab"
                id={tabId(id)}
                aria-selected={id === section}
                // Set here too (the tab list sets it after the dialog has placed the focus).
                tabIndex={id === section ? 0 : -1}
                aria-controls="settings-pane"
                onClick={() => useApp.getState().openSettings(id)}
                className={cn(
                  "flex items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs font-medium text-muted-foreground hover:bg-accent hover:text-foreground",
                  id === section && "bg-accent text-foreground",
                )}
              >
                <Icon aria-hidden="true" className="size-3.5 shrink-0" />
                {name}
              </button>
            );
          })}
        </div>
      </nav>
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex h-12 shrink-0 items-center justify-between border-b pl-5 pr-3">
          <h3 className="text-sm font-medium">{label}</h3>
          <ToolButton variant="panel" size="md" label="Close" onClick={close}>
            <X />
          </ToolButton>
        </div>
        {/* Keyed: each section starts scrolled to its top, with its own state. */}
        <div
          key={section}
          id="settings-pane"
          role="tabpanel"
          aria-labelledby={tabId(section)}
          className="min-h-0 flex-1 overflow-y-auto p-5"
        >
          <Content />
        </div>
      </div>
    </Dialog>
  );
}
