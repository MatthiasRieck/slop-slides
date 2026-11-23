import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { Check, FolderSearch, MessageSquare, Plus, Save } from "lucide-react";
import { useEffect, useState } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Empty, EmptyDescription, EmptyHeader } from "@/components/ui/empty";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import type { TemplateSummary } from "../lib/api";
import { type Pixels, pixelsOf } from "../lib/slideSize";
import { loadText, trySaveText } from "../lib/storage";
import { cn, layoutLabel, templateSlideUrl } from "../lib/utils";
import { useApp } from "../store";
import { SlideFrame } from "./SlideFrame";

const LAST_TEMPLATE_KEY = "slopslide.layoutTemplate";

/** Loads the templates once, for whichever picker needs them first. */
export function useTemplates(): TemplateSummary[] | undefined {
  const templates = useApp((s) => s.templates);
  useEffect(() => {
    if (useApp.getState().templates === undefined) void useApp.getState().refreshTemplates();
  }, []);
  return templates;
}

/** A still preview of one of a template's slides, loaded when the list it is in shows it. */
export function TemplateSlide(props: { template: string; slide: string; size?: Pixels; className?: string }) {
  return (
    <SlideFrame
      deckId={props.template}
      slideId={props.slide}
      version=""
      thumbnail
      lazy
      size={props.size}
      url={templateSlideUrl(props.template, props.slide)}
      className={props.className}
    />
  );
}

/** The template a picker starts on: the deck's own, else the one picked last, else the first. */
function initialTemplate(templates: TemplateSummary[], deckTemplate: string | null | undefined): string | null {
  const known = (id: string | null | undefined) => (id && templates.some((t) => t.id === id) ? id : null);
  return known(deckTemplate) ?? known(loadText(LAST_TEMPLATE_KEY)) ?? templates[0]?.id ?? null;
}

/**
 * Template layouts as thumbnails, to add a slide on one (`add`) or rebuild the selected slide
 * on one (`change`).
 */
export function LayoutPicker(props: { mode: "add" | "change"; onDone: () => void; onBlank?: () => void }) {
  const templates = useTemplates();
  const deckTemplate = useApp((s) => s.deck?.template);
  // Both modes stay on one template: picking a layout must not change the deck's style.
  const current = templates ? initialTemplate(templates, deckTemplate) : null;
  const template = templates?.find((t) => t.id === current);
  // An empty deck takes the template's style, so its layouts are added as they are.
  const empty = useApp((s) => s.deck?.slides.length === 0);
  const sameStyle = !!template && (template.id === deckTemplate || empty);

  const choose = (slide: string) => {
    if (!template) return;
    trySaveText(LAST_TEMPLATE_KEY, template.id);
    const app = useApp.getState();
    void (props.mode === "add" ? app.addLayoutSlide(template.id, slide) : app.changeLayout(template.id, slide));
    props.onDone();
  };

  const hint =
    props.mode === "add"
      ? sameStyle
        ? "Adds a copy of the layout with placeholder text after the selected slide."
        : "This deck has another style: the chat gets a request for the agent to recreate the layout in it."
      : "The chat gets a request for the agent to rebuild this slide on the layout, keeping its content and this deck's style.";

  return (
    <div className="flex min-h-0 flex-col">
      <div className="flex items-center gap-2 border-b px-3 py-2">
        <span className="text-xs font-medium">{props.mode === "add" ? "New slide" : "Change layout"}</span>
      </div>
      <div className="min-h-0 overflow-y-auto p-3">
        {templates === undefined ? (
          <Loading />
        ) : !template ? (
          <Empty className="p-2">
            <EmptyHeader>
              <EmptyDescription className="text-xs">No templates found.</EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          <ul className="grid grid-cols-3 gap-3">
            {props.onBlank && (
              <li>
                <Button
                  variant="ghost"
                  aria-label="Blank slide"
                  tooltip="Add blank slide"
                  onClick={() => {
                    props.onBlank?.();
                    props.onDone();
                  }}
                  className={tile}
                >
                  <div className="flex aspect-video w-full items-center justify-center rounded-md border border-dashed text-muted-foreground transition group-hover:border-primary group-hover:text-foreground">
                    <Plus className="size-5" />
                  </div>
                  <span className="truncate text-2xs text-muted-foreground group-hover:text-foreground">Blank</span>
                </Button>
              </li>
            )}
            {template.slides.map((slide) => (
              <li key={`${template.id}/${slide}`}>
                <Button
                  variant="ghost"
                  aria-label={`${layoutLabel(slide)} layout`}
                  onClick={() => choose(slide)}
                  className={tile}
                >
                  <div className="w-full overflow-hidden rounded-md shadow-thumbnail ring-1 ring-border transition group-hover:ring-2 group-hover:ring-primary">
                    <TemplateSlide template={template.id} slide={slide} size={pixelsOf(template)} />
                  </div>
                  <span className="truncate text-2xs text-muted-foreground group-hover:text-foreground">
                    {layoutLabel(slide)}
                  </span>
                </Button>
              </li>
            ))}
          </ul>
        )}
      </div>
      <p className="border-t px-3 py-2 text-2xs leading-relaxed text-muted-foreground">{hint}</p>
    </div>
  );
}

/**
 * A thumbnail to pick, with its name under it: a button that is all thumbnail, whose own look is
 * only its focus ring; the thumbnail's frame is what answers the pointer.
 */
const tile =
  "group h-auto w-full flex-col items-stretch gap-1 rounded-md p-0 text-left font-normal whitespace-normal hover:bg-transparent active:translate-y-0 aria-disabled:opacity-40 dark:hover:bg-transparent";

/** Restyles the deck like a template, or saves the deck as a template. */
export function StylePicker() {
  const deck = useApp((s) => s.deck);
  const running = useApp((s) => s.running);
  const templates = useTemplates();
  if (!deck) return null;
  return (
    <StylePanel
      // Another deck starts without the last one's request.
      key={deck.id}
      templates={templates}
      current={deck.template ?? null}
      empty={deck.slides.length === 0}
      busy={running}
    />
  );
}

/** Said where a change to the design became a message for the agent, which the user still has to send. */
export function RequestStatus({ children }: { children: string }) {
  return (
    <p role="status" className="flex items-center gap-1.5 text-2xs text-foreground">
      <MessageSquare className="size-3 shrink-0 text-primary" />
      {children}
    </p>
  );
}

const STYLE_BUSY = "Wait for the agent to finish to restyle the deck";

/** A badge small enough for the line under a thumbnail. */
const tag = "h-4 rounded px-1 text-2xs";

function StylePanel(props: {
  templates: TemplateSummary[] | undefined;
  current: string | null;
  empty: boolean;
  busy: boolean;
}) {
  const { templates, current } = props;
  /** The style asked of the agent last: its request waits in the chat. */
  const [requested, setRequested] = useState<string | null>(null);
  const disabled = props.busy && !props.empty;

  const pick = async (id: string) => {
    setRequested(null);
    if ((await useApp.getState().applyStyle(id)) === "requested") setRequested(id);
  };

  return (
    <>
      <div className="border-b px-3 py-2">
        <span className="text-xs font-medium">Style</span>
        <p className="text-2xs text-muted-foreground">
          {props.empty
            ? "The deck takes the style's fonts, colors, and layouts."
            : "The chat gets a request for the agent to restyle every slide, keeping the content."}
        </p>
        {disabled && <p className="text-2xs text-muted-foreground">{STYLE_BUSY}.</p>}
        {requested && <RequestStatus>Request added to the chat. Send it to restyle.</RequestStatus>}
      </div>
      <div className="min-h-0 overflow-y-auto p-3">
        {templates === undefined ? (
          <Loading />
        ) : (
          <ul className="grid grid-cols-3 gap-3">
            {templates.map((t) => (
              <li key={t.id}>
                <Button
                  variant="ghost"
                  disabled={disabled}
                  // Disabled, it says what it waits for.
                  {...(disabled && { tooltip: STYLE_BUSY })}
                  aria-label={`${t.title} style`}
                  aria-current={t.id === current || undefined}
                  data-requested={t.id === requested || undefined}
                  onClick={() => void pick(t.id)}
                  className={tile}
                >
                  <div
                    className={cn(
                      "w-full overflow-hidden rounded-md shadow-thumbnail ring-1 ring-border transition",
                      !disabled && "group-hover:ring-2 group-hover:ring-input",
                      t.id === current && "ring-2 ring-primary",
                      t.id === current && !disabled && "group-hover:ring-primary",
                      t.id === requested && "ring-2 ring-primary/60 ring-offset-2 ring-offset-card",
                    )}
                  >
                    {t.slides[0] && <TemplateSlide template={t.id} slide={t.slides[0]} size={pixelsOf(t)} />}
                  </div>
                  <span className="flex items-center gap-1 text-2xs">
                    <span className="truncate">{t.title}</span>
                    {!t.builtin && (
                      <Badge variant="secondary" className={tag}>
                        Yours
                      </Badge>
                    )}
                    {t.id === current && <Check className="size-3 text-primary" />}
                    {t.id === requested && <Badge className={cn(tag, "bg-primary/10 text-primary")}>Requested</Badge>}
                  </span>
                </Button>
              </li>
            ))}
          </ul>
        )}
      </div>
      {!props.empty && <SaveAsTemplate />}
    </>
  );
}

/** Saves the deck as a template: its design and layouts, with placeholder text. */
function SaveAsTemplate() {
  const title = useApp((s) => s.deck?.title ?? "");
  const [name, setName] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState<TemplateSummary | null>(null);

  const save = async (event: React.FormEvent) => {
    event.preventDefault();
    if (name === null || saving) return;
    setSaving(true);
    const created = await useApp.getState().saveAsTemplate(name.trim() || title);
    setSaving(false);
    if (created) {
      setSaved(created);
      setName(null);
    }
  };

  return (
    <div className="border-t px-3 py-2">
      {name === null ? (
        <div className="flex items-center gap-2">
          <Button
            variant="ghost"
            size="xs"
            onClick={() => {
              setSaved(null);
              setName(title);
            }}
            className="px-1.5"
          >
            <Save data-icon="inline-start" />
            Save deck as template…
          </Button>
          {saved && (
            <span className="flex min-w-0 items-center gap-1 text-2xs text-muted-foreground">
              <span className="truncate">Saved “{saved.title}”.</span>
              {saved.path && (
                <Button
                  variant="ghost"
                  size="icon-2xs"
                  tooltip="Show the template's folder"
                  onClick={() => void revealItemInDir(`${saved.path}/deck.html`)}
                >
                  <FolderSearch className="size-3.5" />
                </Button>
              )}
            </span>
          )}
        </div>
      ) : (
        <form onSubmit={save} className="flex items-center gap-2">
          <Input
            size="sm"
            autoFocus
            aria-label="Template name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            onFocus={(e) => e.currentTarget.select()}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                e.stopPropagation();
                setName(null);
              }
            }}
            className="min-w-0 flex-1"
          />
          <Button type="submit" size="sm" disabled={saving} aria-busy={saving || undefined}>
            {saving && <Spinner aria-hidden="true" data-icon="inline-start" className="size-3" />}
            Save
          </Button>
        </form>
      )}
      <p className="mt-1 text-2xs text-muted-foreground">
        Copies the deck to ~/.slopslides/templates with placeholder text in place of its content.
      </p>
    </div>
  );
}

/** What the style choice calls leaving the style to the agent. */
const ANY_STYLE = "";

/**
 * Style choice for a new deck: one of the templates, or any (null), which leaves it to the agent.
 * A list that opens from its button: the arrows go through the styles, Enter picks one.
 */
export function TemplateSelect(props: {
  value: string | null;
  onChange: (template: string | null) => void;
  id?: string;
  disabled?: boolean;
}) {
  const templates = useTemplates();
  const items = [
    { value: ANY_STYLE, label: "Any style" },
    ...(templates ?? []).map((t) => ({ value: t.id, label: `${t.title}${t.builtin ? "" : " (yours)"}` })),
  ];
  return (
    <Select
      items={items}
      value={props.value ?? ANY_STYLE}
      onValueChange={(value) => props.onChange((value as string) || null)}
      {...(props.disabled !== undefined && { disabled: props.disabled })}
    >
      <SelectTrigger
        {...(props.id !== undefined && { id: props.id })}
        aria-label="Style"
        className="min-w-36 bg-card data-[size=default]:h-10"
      >
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectGroup>
          {items.map((item) => (
            <SelectItem key={item.value} value={item.value}>
              {item.label}
            </SelectItem>
          ))}
        </SelectGroup>
      </SelectContent>
    </Select>
  );
}

/** The thumbnails' places, while the templates are read. */
function Loading() {
  return (
    <div role="status" className="grid grid-cols-3 gap-3">
      <span className="sr-only">Loading templates…</span>
      {[0, 1, 2].map((i) => (
        <div key={i} aria-hidden="true" className="flex flex-col gap-1">
          <Skeleton className="aspect-video w-full" />
          <Skeleton className="h-3 w-2/3" />
        </div>
      ))}
    </div>
  );
}
