import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { ChevronDown, FolderSearch, Loader2, MessageSquare, Plus, Save, Sparkles } from "lucide-react";
import { type ReactNode, useEffect, useRef, useState } from "react";

import type { TemplateSummary } from "../lib/api";
import { type Pixels, pixelsOf } from "../lib/slideSize";
import { loadText, trySaveText } from "../lib/storage";
import { cn, layoutLabel, templateSlideUrl } from "../lib/utils";
import { useApp } from "../store";
import { Button } from "./Button";
import { Popover } from "./Popover";
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
          <p className="text-xs text-muted-foreground">No templates found.</p>
        ) : (
          <ul className="grid grid-cols-3 gap-3">
            {props.onBlank && (
              <li>
                <button
                  type="button"
                  aria-label="Blank slide"
                  // The first choice has the focus, so Enter adds a blank slide.
                  data-autofocus
                  title="Add blank slide"
                  onClick={() => {
                    props.onBlank?.();
                    props.onDone();
                  }}
                  className="group flex w-full flex-col gap-1 text-left"
                >
                  <div className="flex aspect-video w-full items-center justify-center rounded-md border border-dashed text-muted-foreground transition group-hover:border-primary group-hover:text-foreground">
                    <Plus className="size-5" />
                  </div>
                  <span className="truncate text-2xs text-muted-foreground group-hover:text-foreground">Blank</span>
                </button>
              </li>
            )}
            {template.slides.map((slide) => (
              <li key={`${template.id}/${slide}`}>
                <button
                  type="button"
                  aria-label={`${layoutLabel(slide)} layout`}
                  onClick={() => choose(slide)}
                  className="group flex w-full flex-col gap-1 text-left"
                >
                  <div className="w-full overflow-hidden rounded-md shadow-thumbnail ring-1 ring-border transition group-hover:ring-2 group-hover:ring-primary">
                    <TemplateSlide template={template.id} slide={slide} size={pixelsOf(template)} />
                  </div>
                  <span className="truncate text-2xs text-muted-foreground group-hover:text-foreground">
                    {layoutLabel(slide)}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
      <p className="border-t px-3 py-2 text-2xs leading-relaxed text-muted-foreground">{hint}</p>
    </div>
  );
}

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

/**
 * One style to pick, in a grid of them: its picture (`children`) over its name, with what marks
 * it after the name (`badges`). `selected` rings the one that is in use or chosen; `requested`
 * the one asked of the agent.
 */
function StyleTile(props: {
  name: string;
  label: string;
  selected: boolean;
  requested?: boolean;
  disabledReason?: string;
  badges?: ReactNode;
  onClick: () => void;
  children: ReactNode;
}) {
  const disabled = props.disabledReason !== undefined;
  return (
    <button
      type="button"
      disabled={disabled}
      title={props.disabledReason}
      aria-label={props.label}
      aria-current={props.selected || undefined}
      data-requested={props.requested || undefined}
      onClick={props.onClick}
      className="group flex w-full flex-col gap-1 text-left disabled:cursor-default disabled:opacity-40"
    >
      <div
        className={cn(
          "w-full overflow-hidden rounded-md shadow-thumbnail ring-1 ring-border transition group-enabled:group-hover:ring-2 group-enabled:group-hover:ring-input",
          props.selected && "ring-2 ring-primary group-enabled:group-hover:ring-primary",
          props.requested && "ring-2 ring-primary/60 ring-offset-2 ring-offset-card",
        )}
      >
        {props.children}
      </div>
      <span className="flex items-center gap-1 text-2xs">
        <span className="truncate">{props.name}</span>
        {props.badges}
      </span>
    </button>
  );
}

/** What marks a template as the user's own, after its name. */
const yours = <span className="rounded bg-muted px-1 text-muted-foreground">Yours</span>;

/** The deck's own style first, then the others in their order. */
function currentFirst(templates: TemplateSummary[], current: string | null): TemplateSummary[] {
  return [...templates.filter((t) => t.id === current), ...templates.filter((t) => t.id !== current)];
}

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
            {currentFirst(templates, current).map((t) => (
              <li key={t.id}>
                <StyleTile
                  name={t.title}
                  label={`${t.title} style`}
                  selected={t.id === current}
                  requested={t.id === requested}
                  disabledReason={disabled ? STYLE_BUSY : undefined}
                  onClick={() => void pick(t.id)}
                  badges={
                    <>
                      {!t.builtin && yours}
                      {t.id === current && (
                        <span className="rounded bg-primary/10 px-1 font-medium text-primary">Current</span>
                      )}
                      {t.id === requested && (
                        <span className="rounded bg-primary/10 px-1 font-medium text-primary">Requested</span>
                      )}
                    </>
                  }
                >
                  {t.slides[0] && <TemplateSlide template={t.id} slide={t.slides[0]} size={pixelsOf(t)} />}
                </StyleTile>
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
          <button
            type="button"
            onClick={() => {
              setSaved(null);
              setName(title);
            }}
            className="flex items-center gap-1.5 rounded-md px-1.5 py-1 text-xs font-medium hover:bg-accent"
          >
            <Save className="size-3.5" />
            Save deck as template…
          </button>
          {saved && (
            <span className="flex min-w-0 items-center gap-1 text-2xs text-muted-foreground">
              <span className="truncate">Saved “{saved.title}”.</span>
              {saved.path && (
                <button
                  type="button"
                  title="Show the template's folder"
                  onClick={() => void revealItemInDir(`${saved.path}/deck.html`)}
                  className="rounded p-0.5 hover:bg-accent hover:text-foreground"
                >
                  <FolderSearch className="size-3.5" />
                </button>
              )}
            </span>
          )}
        </div>
      ) : (
        <form onSubmit={save} className="flex items-center gap-2">
          <input
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
            className="min-w-0 flex-1 rounded-md border bg-background px-2 py-1 text-xs outline-none focus:ring-1 focus:ring-primary"
          />
          <button
            type="submit"
            disabled={saving}
            className="flex items-center gap-1 rounded-md bg-primary px-2 py-1 text-xs font-medium text-primary-foreground hover:opacity-90 disabled:opacity-40"
          >
            {saving && <Loader2 className="size-3 animate-spin" />}
            Save
          </button>
        </form>
      )}
      <p className="mt-1 text-2xs text-muted-foreground">
        Copies the deck to ~/.slopslides/templates with placeholder text in place of its content.
      </p>
    </div>
  );
}

/** What the style choice says while no style is chosen: the agent picks one that suits the deck. */
export const AGENT_STYLE = "Let the agent choose";

/**
 * The style of a new deck: a button showing the one chosen, which opens the styles as pictures
 * to pick from. The first of them leaves the choice to the agent (`null`).
 */
export function StyleChoice(props: { value: string | null; onChange: (template: string | null) => void }) {
  const templates = useTemplates();
  const [open, setOpen] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  const chosen = templates?.find((t) => t.id === props.value) ?? null;

  const pick = (template: string | null) => {
    props.onChange(template);
    setOpen(false);
  };

  return (
    <>
      <Button
        ref={button}
        size="3xl"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={`Style: ${chosen?.title ?? AGENT_STYLE}`}
        onClick={() => setOpen((v) => !v)}
        className="max-w-60 bg-card pl-1.5 pr-2.5 font-normal"
      >
        <span className="w-12 shrink-0 overflow-hidden rounded ring-1 ring-border">
          {chosen?.slides[0] ? (
            <TemplateSlide template={chosen.id} slide={chosen.slides[0]} size={pixelsOf(chosen)} />
          ) : (
            <AgentPick small />
          )}
        </span>
        <span className="truncate">{chosen?.title ?? AGENT_STYLE}</span>
        <ChevronDown className="size-3 shrink-0 text-muted-foreground" />
      </Button>
      {open && (
        <Popover anchor={button} width={440} portal label="Style" onClose={() => setOpen(false)}>
          <div className="min-h-0 overflow-y-auto p-3">
            {templates === undefined ? (
              <Loading />
            ) : (
              <ul className="grid grid-cols-3 gap-3">
                <li>
                  <StyleTile
                    name={AGENT_STYLE}
                    label={AGENT_STYLE}
                    selected={chosen === null}
                    onClick={() => pick(null)}
                  >
                    <AgentPick />
                  </StyleTile>
                </li>
                {templates.map((t) => (
                  <li key={t.id}>
                    <StyleTile
                      name={t.title}
                      label={`${t.title} style`}
                      selected={t.id === chosen?.id}
                      onClick={() => pick(t.id)}
                      badges={!t.builtin && yours}
                    >
                      {t.slides[0] && <TemplateSlide template={t.id} slide={t.slides[0]} size={pixelsOf(t)} />}
                    </StyleTile>
                  </li>
                ))}
              </ul>
            )}
          </div>
          <p className="border-t px-3 py-2 text-2xs leading-relaxed text-muted-foreground">
            A style sets the deck's fonts, colors and layouts. Left to the agent, it picks one that suits what the deck
            is about.
          </p>
        </Popover>
      )}
    </>
  );
}

/** The picture of leaving the style to the agent, in the place of a style's first slide. */
function AgentPick({ small = false }: { small?: boolean }) {
  return (
    <span className="flex aspect-video w-full items-center justify-center bg-muted text-primary">
      <Sparkles className={small ? "size-3.5" : "size-5"} />
    </span>
  );
}

function Loading() {
  return (
    <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
      <Loader2 className="size-3.5 animate-spin" />
      Loading templates…
    </p>
  );
}
