import {
  AArrowDown,
  AArrowUp,
  Baseline,
  Bold,
  CaseSensitive,
  Highlighter,
  Italic,
  Link,
  RemoveFormatting,
  Strikethrough,
  Subscript,
  Superscript,
  Underline,
} from "lucide-react";
import { memo, type ReactNode, useMemo, useState } from "react";

import { useDropdown } from "../../hooks/useDropdown";
import type { ArrangeMessage } from "../../lib/arrange";
import {
  CASE_LABELS,
  type FontChoice,
  firstFamily,
  fontChoices,
  fontWeights,
  isMixed,
  linkedSlide,
  normalizeHref,
  WEIGHT_NAMES,
} from "../../lib/editTools";
import { slideHeading } from "../../lib/slideTitle";
import { cn } from "../../lib/utils";
import { useApp } from "../../store";
import { Button, ToolButton } from "../Button";
import { ColorButton } from "../ColorButton";
import { useEditPanelAsk } from "../editPanelAsk";
import { NumberBox, type NumberPreset } from "../Field";
import { dropdownPanel } from "../Popover";
import { RibbonRow, RibbonSection, RibbonSelect } from "../Ribbon";
import { useEditorState } from "../stage/editorState";
import {
  MenuDivider,
  MenuPanel,
  MenuRow,
  mixedToggle,
  NEEDS_ELEMENT,
  NEEDS_TEXT,
  PanelButton,
  type StyleSectionProps,
  useToolbarState,
} from "./parts";

/** The text's on-or-off looks that have a button of their own. */
const TEXT_MARKS: { mark: "bold" | "italic" | "underline"; label: string; shortcut: string; icon: ReactNode }[] = [
  { mark: "bold", label: "Bold", shortcut: "mod+b", icon: <Bold /> },
  { mark: "italic", label: "Italic", shortcut: "mod+i", icon: <Italic /> },
  { mark: "underline", label: "Underline", shortcut: "mod+u", icon: <Underline /> },
];

/** The font sizes the size field offers, after "Deck default". */
const SIZE_PRESETS: NumberPreset[] = [
  { value: null, label: "Deck default" },
  ...[12, 14, 16, 18, 20, 24, 28, 32, 36, 40, 48, 56, 64, 72, 80, 96, 120, 144, 200].map((value) => ({ value })),
];

/** The text's font, weight, size, marks, color, highlight and link, and the rest of its formatting in a menu. */
export const TextSection = memo(function TextSection(
  props: StyleSectionProps & {
    onLink?: (href: string | null) => void;
    onArrange?: (message: ArrangeMessage) => void;
  },
) {
  const { selection, state, style, textOff } = useToolbarState(props.tool, props.styles);
  const fonts = useEditorState((s) => s.fonts);
  const colors = useEditorState((s) => s.colors);
  const returnFocus = () => props.onReturnFocus?.();
  const mixed = (key: Parameters<typeof isMixed>[1]) => isMixed(selection, key);
  const weight = style.weight ?? (style.bold ? 700 : 400);
  return (
    <RibbonSection title="Text" icon={<CaseSensitive />} collapsed={props.collapsed} closeOn={props.tool}>
      <RibbonRow>
        <FontPicker
          value={style.fontFamily ?? null}
          mixed={mixed("fontFamily")}
          fonts={fonts}
          disabled={textOff}
          onChange={(fontFamily) => props.onStyle({ fontFamily })}
          onDone={returnFocus}
        />
        <WeightPicker
          value={mixed("weight") ? null : weight}
          weights={fontWeights(fonts, style.fontFamily ?? null, weight)}
          disabled={textOff}
          onChange={(next) => props.onStyle({ weight: next })}
          onDone={returnFocus}
        />
        <NumberBox
          label="Font size"
          value={state?.text && !mixed("fontSize") ? (style.fontSize ?? null) : null}
          min={1}
          max={999}
          presets={SIZE_PRESETS}
          disabled={textOff}
          disabledReason={NEEDS_TEXT}
          onChange={(fontSize) => props.onStyle({ fontSize })}
          onDone={returnFocus}
        />
      </RibbonRow>
      <RibbonRow>
        {TEXT_MARKS.map((m) => (
          <ToolButton
            keepFocus
            key={m.mark}
            label={m.label}
            shortcut={m.shortcut}
            active={!textOff && !!style[m.mark]}
            disabled={textOff}
            disabledReason={NEEDS_TEXT}
            onClick={() => props.onStyle({ [m.mark]: mixed(m.mark) || !style[m.mark] })}
            {...mixedToggle(!textOff && mixed(m.mark))}
          >
            {m.icon}
          </ToolButton>
        ))}
        <ColorButton
          label="Text color"
          icon={<Baseline />}
          value={style.color ?? null}
          other={!!selection?.colorOther}
          disabled={textOff}
          disabledReason={NEEDS_TEXT}
          defaultLabel="Deck default"
          deck={colors}
          onChange={(color) => props.onStyle({ color })}
          onPreview={(color) => preview(props, color === undefined ? undefined : { color })}
          onDone={returnFocus}
        />
        <ColorButton
          label="Highlight"
          icon={<Highlighter />}
          value={selection?.highlight ?? null}
          disabled={textOff || !selection}
          disabledReason={NEEDS_TEXT}
          none
          deck={colors}
          onChange={(highlight) => props.onStyle({ highlight })}
          onDone={returnFocus}
        />
        <LinkButton
          value={selection?.link ?? null}
          disabled={!selection}
          onChange={(href) => props.onLink?.(href)}
          onDone={returnFocus}
        />
        <MoreTextMenu {...props} textOff={textOff || !selection} />
      </RibbonRow>
    </RibbonSection>
  );
});

/** Shows `style` on the selection while the pointer is on a color, and with undefined takes it back. */
function preview(
  props: { onArrange?: (message: ArrangeMessage) => void },
  style: { color: string | null } | undefined,
) {
  if (style === undefined) props.onArrange?.({ type: "slop:edit-style-cancel" });
  else props.onArrange?.({ type: "slop:edit-style", style, preview: true });
}

/**
 * The text formatting that does not need a button of its own: strikethrough, superscript and
 * subscript, the case it is written in, a size step up or down (each text from its own size),
 * and clearing the formatting.
 */
function MoreTextMenu(props: StyleSectionProps & { textOff: boolean; onArrange?: (message: ArrangeMessage) => void }) {
  const { open, setOpen, ref, toggle } = useDropdown({ disabled: props.textOff });
  const { selection } = useToolbarState(props.tool, props.styles);
  const run = (then: () => void) => {
    then();
    setOpen(false);
    props.onReturnFocus?.();
  };
  return (
    <div ref={ref} className="relative">
      <PanelButton
        open={open}
        label="More text formatting"
        title="More text formatting: strikethrough, superscript, case, size steps, clear formatting"
        disabled={props.textOff}
        disabledReason={NEEDS_TEXT}
        onClick={toggle}
      >
        <CaseSensitive />
      </PanelButton>
      {open && selection && (
        <MenuPanel label="More text formatting">
          <MenuRow
            icon={<Strikethrough />}
            label="Strikethrough"
            shortcut="mod+shift+x"
            checked={selection.strike}
            onClick={() => run(() => props.onStyle({ strike: !selection.strike }))}
          />
          <MenuRow
            icon={<Superscript />}
            label="Superscript"
            checked={selection.script === "sup"}
            onClick={() => run(() => props.onStyle({ script: selection.script === "sup" ? null : "sup" }))}
          />
          <MenuRow
            icon={<Subscript />}
            label="Subscript"
            checked={selection.script === "sub"}
            onClick={() => run(() => props.onStyle({ script: selection.script === "sub" ? null : "sub" }))}
          />
          <MenuDivider />
          {CASE_LABELS.map((choice) => (
            <MenuRow
              key={choice.value}
              label={choice.label}
              checked={!isMixed(selection, "textCase") && (selection.textCase ?? "") === choice.value}
              onClick={() => run(() => props.onStyle({ textCase: choice.value || null }))}
            />
          ))}
          <MenuDivider />
          <MenuRow
            icon={<AArrowUp />}
            label="Larger text"
            shortcut="mod+shift+."
            onClick={() => run(() => props.onArrange?.({ type: "slop:edit-font-step", step: 1 }))}
          />
          <MenuRow
            icon={<AArrowDown />}
            label="Smaller text"
            shortcut="mod+shift+,"
            onClick={() => run(() => props.onArrange?.({ type: "slop:edit-font-step", step: -1 }))}
          />
          <MenuDivider />
          <MenuRow
            icon={<RemoveFormatting />}
            label="Clear formatting"
            title="Take bold, colors, sizes and other formatting off the text, keeping its links"
            onClick={() => run(() => props.onArrange?.({ type: "slop:edit-clear-formatting" }))}
          />
        </MenuPanel>
      )}
    </div>
  );
}

/** The font list: the deck's own fonts, then system fonts; "Default" leaves it to the deck. Each shows in its own face. */
function FontPicker(props: {
  value: string | null;
  mixed: boolean;
  fonts: FontChoice[];
  disabled: boolean;
  onChange: (stack: string | null) => void;
  onDone: () => void;
}) {
  const choices = fontChoices(props.fonts);
  const name = firstFamily(props.value).toLowerCase();
  const all = [...choices.deck, ...choices.system];
  const match = name ? all.find((f) => f.name.toLowerCase() === name) : undefined;
  // A font the list does not have (set in the deck's styles) still shows as the current one.
  const current = name && !match ? firstFamily(props.value) : null;
  const value = props.mixed ? "__mixed" : match ? match.stack : current ? "__current" : "";
  return (
    <RibbonSelect
      label="Font"
      title={props.mixed ? "Font: mixed" : `Font: ${match?.name ?? current ?? "the deck's own"}`}
      disabled={props.disabled}
      disabledReason={NEEDS_TEXT}
      value={value}
      onPick={(next) => {
        if (next !== "__current" && next !== "__mixed") props.onChange(next || null);
      }}
      onDone={props.onDone}
      className="w-20 truncate border enabled:hover:bg-accent"
    >
      {props.mixed && (
        <option value="__mixed" disabled>
          Mixed
        </option>
      )}
      <option value="">Default font</option>
      {current && <option value="__current">{current}</option>}
      {choices.deck.length > 0 && (
        <optgroup label="Deck fonts">
          {choices.deck.map((f) => (
            <option key={f.name} value={f.stack} style={{ fontFamily: f.stack }}>
              {f.name}
            </option>
          ))}
        </optgroup>
      )}
      <optgroup label="System fonts">
        {choices.system.map((f) => (
          <option key={f.name} value={f.stack} style={{ fontFamily: f.stack }}>
            {f.name}
          </option>
        ))}
      </optgroup>
    </RibbonSelect>
  );
}

/** The font's weight, from those the deck has files for: 300, 500 and 600 as well as regular and bold. Null shows "Mixed". */
function WeightPicker(props: {
  value: number | null;
  weights: number[];
  disabled: boolean;
  onChange: (weight: number) => void;
  onDone: () => void;
}) {
  const name = (weight: number) => WEIGHT_NAMES[weight] ?? String(weight);
  return (
    <RibbonSelect
      label="Font weight"
      title={props.value === null ? "Font weight: mixed" : `Font weight: ${name(props.value)} (${props.value})`}
      disabled={props.disabled}
      disabledReason={NEEDS_TEXT}
      value={props.value === null ? "" : String(props.value)}
      onPick={(next) => {
        if (next) props.onChange(Number(next));
      }}
      onDone={props.onDone}
      className="w-[4.25rem] truncate border enabled:hover:bg-accent"
    >
      {props.value === null && (
        <option value="" disabled>
          Mixed
        </option>
      )}
      {props.weights.map((weight) => (
        <option key={weight} value={weight}>
          {name(weight)}
        </option>
      ))}
    </RibbonSelect>
  );
}

/**
 * Adds, changes or removes the selection's link: to a web or mail address, or another slide.
 * ⌘K and "Link…" in the context menu open it too.
 */
function LinkButton(props: {
  value: string | null;
  disabled: boolean;
  onChange: (href: string | null) => void;
  onDone: () => void;
}) {
  const { open, setOpen, ref } = useDropdown({ disabled: props.disabled });
  const slideNow = linkedSlide(props.value);
  const [address, setAddress] = useState("");
  const [slide, setSlide] = useState("");
  const [invalid, setInvalid] = useState(false);

  /** Opens the popover on the link as it is now. */
  const show = () => {
    setAddress(props.value && !slideNow ? props.value : "");
    setSlide(slideNow ?? "");
    setInvalid(false);
    setOpen(true);
  };
  const toggle = () => {
    if (open) setOpen(false);
    else show();
  };
  useEditPanelAsk("link", () => {
    if (!props.disabled) show();
  });
  const finish = (href: string | null) => {
    props.onChange(href);
    setOpen(false);
    props.onDone();
  };
  const apply = () => {
    const href = slide ? `#${slide}` : normalizeHref(address);
    if (!href) {
      setInvalid(true);
      return;
    }
    finish(href);
  };
  const web = props.value && !slideNow && /^(https?|mailto):/i.test(props.value) ? props.value : null;

  return (
    <div ref={ref} className="relative">
      <PanelButton
        open={open}
        label="Link"
        shortcut="mod+k"
        title={props.value ? `Link: ${props.value}` : "Add a link"}
        active={open || !!props.value}
        disabled={props.disabled}
        disabledReason={NEEDS_ELEMENT}
        onClick={toggle}
      >
        <Link />
      </PanelButton>
      {open && (
        <form
          role="dialog"
          aria-label="Link"
          onSubmit={(event) => {
            event.preventDefault();
            apply();
          }}
          className={cn(dropdownPanel, "flex w-64 flex-col gap-2 text-xs text-foreground")}
        >
          <input
            autoFocus
            aria-label="Link address"
            placeholder="https://… or someone@example.com"
            value={address}
            onChange={(event) => {
              setAddress(event.target.value);
              setSlide("");
              setInvalid(false);
            }}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                event.preventDefault();
                setOpen(false);
                props.onDone();
              }
            }}
            aria-invalid={invalid || undefined}
            className={cn("h-7 rounded border bg-transparent px-2", invalid && "border-destructive")}
          />
          <LinkTargets
            value={slide}
            onChange={(id) => {
              setSlide(id);
              setInvalid(false);
            }}
          />
          {invalid && <p className="text-destructive">Enter a web address, an email address, or pick a slide.</p>}
          <div className="flex items-center justify-end gap-1">
            {web && (
              <a
                href={web}
                target="_blank"
                rel="noreferrer"
                className="mr-auto rounded-md px-1.5 py-1 text-primary hover:bg-accent"
              >
                Open link
              </a>
            )}
            {props.value && (
              <Button variant="ghost" size="sm" onClick={() => finish(null)}>
                Remove link
              </Button>
            )}
            <Button type="submit" variant="primary" size="sm">
              {props.value ? "Update" : "Add link"}
            </Button>
          </div>
        </form>
      )}
    </div>
  );
}

/**
 * The deck's slides by their titles, to pick the one a link goes to. It is part of the open Link
 * popover: only then is the list made, and kept up with the deck.
 */
function LinkTargets(props: { value: string; onChange: (slide: string) => void }) {
  const slides = useApp((s) => s.deck?.slides);
  const targets = useMemo(() => (slides ?? []).map((s, i) => ({ id: s.id, label: slideHeading(i, s.id) })), [slides]);
  if (targets.length === 0) return null;
  return (
    <select
      aria-label="Link to slide"
      value={props.value}
      onChange={(event) => props.onChange(event.target.value)}
      className="h-7 rounded border bg-transparent px-1"
    >
      <option value="">Or link to a slide…</option>
      {targets.map((target) => (
        <option key={target.id} value={target.id}>
          {target.label}
        </option>
      ))}
    </select>
  );
}
