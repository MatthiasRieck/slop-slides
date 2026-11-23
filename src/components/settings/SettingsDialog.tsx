import { Bot, Info, Keyboard, SlidersHorizontal, X } from "lucide-react";
import { type ComponentType, useRef } from "react";

import { Button } from "@/components/ui/button";
import { Dialog, DialogClose, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

import { SETTINGS_SECTIONS, type SettingsSection, useApp } from "../../store";
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

/**
 * The app's settings, for every deck and window, in a dialog over the app: the sections listed on
 * the left (↑ and ↓ go through them), the one picked on the right under its name. It opens from
 * the gear in the top bar and on ⌘, (on General), and on `?` or ⌘/ (on Keyboard shortcuts);
 * `openSettings` in ../../store.ts opens it on any section. Escape and the close button close
 * it; a press beside it does not, so a slip of the pointer loses nothing. The focus starts on
 * the section's tab, or in what the section marks `data-autofocus` (the shortcuts' filter box).
 * Rendered while `settingsSection` says a section (see ../../App.tsx).
 */
export function SettingsDialog() {
  const section = useApp((s) => s.settingsSection);
  const box = useRef<HTMLDivElement>(null);
  if (!section) return null;
  const { label, content: Content } = PANES[section];
  return (
    <Dialog
      open
      disablePointerDismissal
      onOpenChange={(open) => {
        if (!open) useApp.getState().closeSettings();
      }}
    >
      <DialogContent
        ref={box}
        showCloseButton={false}
        overlayProps={{ "data-testid": "settings-backdrop" }}
        initialFocus={() => box.current?.querySelector<HTMLElement>("[data-autofocus]") ?? true}
        className="flex h-[38rem] max-h-[calc(100vh-4rem)] w-[54rem] gap-0 overflow-hidden bg-background p-0 text-foreground sm:max-w-[calc(100vw-2rem)]"
      >
        <Tabs
          orientation="vertical"
          value={section}
          onValueChange={(value) => useApp.getState().openSettings(value as SettingsSection)}
          className="min-w-0 flex-1 gap-0"
        >
          <nav className="flex w-48 shrink-0 flex-col gap-3 border-r bg-sidebar p-3">
            <DialogTitle className="px-2 pt-1.5 text-sm font-semibold">Settings</DialogTitle>
            <TabsList aria-label="Settings" className="w-full items-stretch gap-0.5 bg-transparent p-0">
              {SETTINGS_SECTIONS.map((id) => {
                const { label: name, icon: Icon } = PANES[id];
                return (
                  <TabsTrigger
                    key={id}
                    value={id}
                    className="h-auto flex-none gap-2 px-2 py-1.5 text-xs text-muted-foreground hover:bg-accent data-active:bg-accent data-active:shadow-none dark:data-active:border-transparent dark:data-active:bg-accent"
                  >
                    <Icon aria-hidden="true" className="size-3.5" />
                    {name}
                  </TabsTrigger>
                );
              })}
            </TabsList>
          </nav>
          <div className="flex min-w-0 flex-1 flex-col">
            <div className="flex h-12 shrink-0 items-center justify-between border-b pl-5 pr-3">
              <h3 className="text-sm font-medium">{label}</h3>
              <DialogClose render={<Button variant="tool" size="icon-sm" tooltip="Close" />}>
                <X />
              </DialogClose>
            </div>
            {/* Keyed: each section starts scrolled to its top, with its own state. */}
            <TabsContent key={section} value={section} className="min-h-0 overflow-y-auto p-5">
              <Content />
            </TabsContent>
          </div>
        </Tabs>
      </DialogContent>
    </Dialog>
  );
}
