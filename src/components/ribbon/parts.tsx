import { Check, ChevronDown, Sparkles } from "lucide-react";
import type { ComponentProps, ReactNode } from "react";

import { useMenuKeys } from "../../hooks/useMenuKeys";
import { type EditStyle, type EditTool, type ToolFamily, toolbarState } from "../../lib/editTools";
import { formatKeys } from "../../lib/keys";
import { cn } from "../../lib/utils";
import { ToolButton } from "../Button";
import { DropdownPanel } from "../Popover";
import { useSlideReport } from "../stage/editorState";

/** Why a control is disabled, by what it works on. */
export const NEEDS_TEXT = "Select text or a text box";
export const NEEDS_ELEMENT = "Select an element";
/** Why a request to the agent cannot start just now. */
export const AGENT_BUSY = "The agent is busy";

/** What every section of the edit ribbon is told: whether it is collapsed to its icon, and the tool in hand. */
export interface SectionProps {
  collapsed: boolean;
  tool: EditTool;
}

/** What the sections that restyle are told on top: the looks of what the tools add, and how to restyle. */
export interface StyleSectionProps extends SectionProps {
  styles: Record<ToolFamily, EditStyle>;
  onStyle: (changes: EditStyle) => void;
  onReturnFocus?: () => void;
}

/**
 * What a section's controls show and which of them are enabled: the selection the editor reports
 * (see `toolbarState`), read here so that only the sections showing it render when it changes.
 */
export function useToolbarState(tool: EditTool, styles: Record<ToolFamily, EditStyle>) {
  const selection = useSlideReport((report) => report.selection);
  const state = toolbarState(selection, tool, styles);
  return { selection, state, style: state?.style ?? {}, textOff: !state?.text };
}

/**
 * What a toggle is given when the selected elements do not agree on it: neither on nor off, with
 * a dashed line around it.
 */
export function mixedToggle(mixed: boolean): { "aria-pressed"?: "mixed"; className?: string } {
  return mixed
    ? { "aria-pressed": "mixed", className: "outline-1 -outline-offset-1 outline-dashed outline-foreground/40" }
    : {};
}

/** The small mark in a button's corner that says it opens a panel or a menu instead of acting at once. */
function Caret() {
  return <ChevronDown aria-hidden="true" className="!size-2 absolute right-0 bottom-0 opacity-70" />;
}

/**
 * An icon button of the ribbon that opens a panel or a menu: a `ToolButton` with a caret in its
 * corner, pressed in while `open`.
 */
export function PanelButton({
  open,
  children,
  className,
  ...rest
}: ComponentProps<typeof ToolButton> & { open: boolean }) {
  return (
    <ToolButton keepFocus aria-expanded={open} active={open} {...rest} className={cn("relative", className)}>
      {children}
      <Caret />
    </ToolButton>
  );
}

/**
 * A ribbon button with its name beside its icon, for the tools of one kind of selection (an
 * image's, a line's, a shape's), which opens their panel.
 */
export function LabelPanelButton({
  open,
  text,
  children,
  ...rest
}: ComponentProps<typeof ToolButton> & { open: boolean; text: string }) {
  return (
    <ToolButton
      keepFocus
      aria-expanded={open}
      active={open}
      {...rest}
      className="flex h-6 items-center gap-1 px-1.5 text-xs"
    >
      {children}
      {text}
      <ChevronDown aria-hidden="true" className="!size-2.5 opacity-70" />
    </ToolButton>
  );
}

/**
 * The mark of a control that hands a request to the agent instead of acting itself, at its
 * icon's corner.
 */
export function AgentMark() {
  return <Sparkles aria-hidden="true" size={12} className="!size-2.5 absolute -top-0.5 -right-0.5 text-primary" />;
}

/**
 * A menu dropping down from a ribbon button: its choices are `MenuRow`s. The arrow keys go
 * through them, and the focus returns to where it was when the menu goes away (see `useMenuKeys`).
 */
export function MenuPanel(props: { label: string; children: ReactNode }) {
  const menu = useMenuKeys();
  return (
    <DropdownPanel
      role="menu"
      aria-label={props.label}
      data-ribbon-panel=""
      {...menu}
      className="flex w-max min-w-44 flex-col p-1 text-xs text-foreground outline-none"
    >
      {props.children}
    </DropdownPanel>
  );
}

/**
 * One choice of a `MenuPanel`: its icon, its name, and the keys that do the same. `checked` makes
 * it a setting that is on or off. Disabled, its tooltip is `disabledReason`.
 */
export function MenuRow(props: {
  icon?: ReactNode;
  label: string;
  shortcut?: string;
  checked?: boolean;
  disabled?: boolean;
  disabledReason?: string;
  title?: string;
  onClick: () => void;
}) {
  const shared = {
    type: "button" as const,
    title: props.disabled ? props.disabledReason : props.title,
    disabled: props.disabled,
    onClick: props.onClick,
    className: cn(
      "flex w-full items-center gap-2 rounded-md px-2 py-1 text-left enabled:hover:bg-accent focus:bg-accent focus:outline-none disabled:cursor-default disabled:opacity-45 [&_svg]:size-4 [&_svg]:shrink-0 [&_svg]:text-muted-foreground",
      props.checked && "text-primary [&_svg]:text-primary",
    ),
  };
  const content = (
    <>
      {props.icon ?? (props.checked !== undefined && <Check className={cn(!props.checked && "invisible")} />)}
      <span className="flex-1">{props.label}</span>
      {props.shortcut && <span className="pl-3 text-muted-foreground">{formatKeys(props.shortcut)}</span>}
    </>
  );
  return props.checked === undefined ? (
    <button role="menuitem" {...shared}>
      {content}
    </button>
  ) : (
    <button role="menuitemcheckbox" aria-checked={props.checked} {...shared}>
      {content}
    </button>
  );
}

/** A line between the groups of a `MenuPanel`. */
export function MenuDivider() {
  return <hr className="my-1 border-border" />;
}

/** The muted name of a row in a ribbon panel laid out as a grid of names and controls. */
export function PanelLabel(props: { htmlFor?: string; off?: boolean; children: ReactNode }) {
  const className = cn("text-muted-foreground", props.off && "opacity-40");
  return props.htmlFor ? (
    <label htmlFor={props.htmlFor} className={className}>
      {props.children}
    </label>
  ) : (
    <span className={className}>{props.children}</span>
  );
}

/** How a ribbon panel of named rows is laid out: the names in one column, their controls in the next. */
export const panelGrid = "grid w-max grid-cols-[auto_auto] items-center gap-x-2 gap-y-1.5 text-xs text-foreground";
