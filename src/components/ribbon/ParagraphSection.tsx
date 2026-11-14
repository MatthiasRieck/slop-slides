import {
  AlignCenter,
  AlignJustify,
  AlignLeft,
  AlignRight,
  AlignVerticalJustifyCenter,
  AlignVerticalJustifyEnd,
  AlignVerticalJustifyStart,
  IndentDecrease,
  IndentIncrease,
  List,
  ListOrdered,
} from "lucide-react";
import { memo, type ReactNode } from "react";

import { useDropdown } from "../../hooks/useDropdown";
import type { ArrangeMessage } from "../../lib/arrange";
import {
  AUTOFIT_LABELS,
  type Autofit,
  type EditSelection,
  type EditStyle,
  isMixed,
  LETTER_SPACINGS,
  LINE_HEIGHTS,
  LIST_STYLES,
  type ListKind,
  PARAGRAPH_SPACES,
  type TextAlign,
  type VerticalAlign,
} from "../../lib/editTools";
import { ToolButton } from "../Button";
import { NumberBox } from "../Field";
import { LineSpacing } from "../LineTools";
import { DropdownPanel } from "../Popover";
import { RibbonRow, RibbonSection, RibbonSelect } from "../Ribbon";
import {
  MenuDivider,
  MenuPanel,
  MenuRow,
  NEEDS_TEXT,
  PanelButton,
  PanelLabel,
  panelGrid,
  type StyleSectionProps,
  useToolbarState,
} from "./parts";

const ALIGN: { value: TextAlign; label: string; shortcut: string; icon: ReactNode }[] = [
  { value: "left", label: "Align text left", shortcut: "mod+shift+l", icon: <AlignLeft /> },
  { value: "center", label: "Center text", shortcut: "mod+shift+e", icon: <AlignCenter /> },
  { value: "right", label: "Align text right", shortcut: "mod+shift+r", icon: <AlignRight /> },
  { value: "justify", label: "Justify text", shortcut: "mod+shift+j", icon: <AlignJustify /> },
];

const VALIGN: { value: VerticalAlign; label: string; icon: ReactNode }[] = [
  { value: "top", label: "Top", icon: <AlignVerticalJustifyStart /> },
  { value: "middle", label: "Middle", icon: <AlignVerticalJustifyCenter /> },
  { value: "bottom", label: "Bottom", icon: <AlignVerticalJustifyEnd /> },
];

const LISTS: { value: ListKind; label: string; title: string; icon: ReactNode }[] = [
  { value: "ul", label: "Bulleted list", title: "Bulleted list (Tab indents, Shift+Tab outdents)", icon: <List /> },
  {
    value: "ol",
    label: "Numbered list",
    title: "Numbered list (Tab indents, Shift+Tab outdents)",
    icon: <ListOrdered />,
  },
];

/** How the text is aligned, listed, indented and spaced, where it sits in its box, and what it does when it does not fit. */
export const ParagraphSection = memo(function ParagraphSection(
  props: StyleSectionProps & { onList?: (list: ListKind) => void; onArrange?: (message: ArrangeMessage) => void },
) {
  const { selection, state, style, textOff } = useToolbarState(props.tool, props.styles);
  const returnFocus = () => props.onReturnFocus?.();
  const alignMixed = isMixed(selection, "align");
  const indent = (step: 1 | -1) => props.onArrange?.({ type: "slop:edit-indent", step });
  return (
    <RibbonSection title="Paragraph" icon={<AlignLeft />} collapsed={props.collapsed} closeOn={props.tool}>
      <RibbonRow>
        {ALIGN.map((a) => (
          <ToolButton
            keepFocus
            key={a.value}
            label={a.label}
            shortcut={a.shortcut}
            active={!textOff && !alignMixed && style.align === a.value}
            disabled={textOff}
            disabledReason={NEEDS_TEXT}
            onClick={() => props.onStyle({ align: a.value })}
          >
            {a.icon}
          </ToolButton>
        ))}
        <SpacingButton
          selection={selection}
          style={style}
          disabled={textOff}
          onChange={props.onStyle}
          onDone={returnFocus}
        />
      </RibbonRow>
      <RibbonRow>
        {LISTS.map((l) => (
          <ToolButton
            keepFocus
            key={l.value}
            label={l.label}
            title={l.title}
            active={!textOff && !!selection && selection.list === l.value}
            disabled={textOff || !selection}
            disabledReason={NEEDS_TEXT}
            onClick={() => props.onList?.(l.value)}
          >
            {l.icon}
          </ToolButton>
        ))}
        <ToolButton
          keepFocus
          label="Decrease indent"
          title="Decrease indent: a list item a level out (Shift+Tab while typing), other text back toward its box's edge"
          disabled={textOff || !selection}
          disabledReason={NEEDS_TEXT}
          onClick={() => indent(-1)}
        >
          <IndentDecrease />
        </ToolButton>
        <ToolButton
          keepFocus
          label="Increase indent"
          title="Increase indent: a list item a level in (Tab while typing), other text in from its box's edge"
          disabled={textOff || !selection}
          disabledReason={NEEDS_TEXT}
          onClick={() => indent(1)}
        >
          <IndentIncrease />
        </ToolButton>
        <TextBoxMenu
          selection={selection}
          valign={state?.valign ? (style.valign ?? null) : null}
          canValign={!!state?.valign}
          disabled={textOff}
          onChange={props.onStyle}
          onDone={returnFocus}
        />
      </RibbonRow>
    </RibbonSection>
  );
});

/** Where the text sits in its box, top to bottom, and what it does when it does not fit: one menu. */
function TextBoxMenu(props: {
  selection: EditSelection | null;
  valign: VerticalAlign | null;
  canValign: boolean;
  disabled: boolean;
  onChange: (changes: EditStyle) => void;
  onDone: () => void;
}) {
  const { open, setOpen, ref, toggle } = useDropdown({ disabled: props.disabled });
  const s = props.selection;
  const run = (changes: EditStyle) => {
    props.onChange(changes);
    setOpen(false);
    props.onDone();
  };
  const current = VALIGN.find((v) => v.value === props.valign) ?? VALIGN[0]!;
  return (
    <div ref={ref} className="relative">
      <PanelButton
        open={open}
        label="Text in its box"
        title="Text in its box: top, middle or bottom, and what happens when it does not fit"
        disabled={props.disabled}
        disabledReason={NEEDS_TEXT}
        onClick={toggle}
      >
        {current.icon}
      </PanelButton>
      {open && (
        <MenuPanel label="Text in its box">
          {VALIGN.map((v) => (
            <MenuRow
              key={v.value}
              icon={v.icon}
              label={v.label}
              checked={!isMixed(s, "valign") && props.valign === v.value}
              disabled={!props.canValign}
              disabledReason="This element's text cannot align vertically"
              onClick={() => run({ valign: v.value })}
            />
          ))}
          <MenuDivider />
          <span className="px-2 py-0.5 text-[10px] text-muted-foreground">When text does not fit</span>
          {AUTOFIT_LABELS.map((choice) => (
            <MenuRow
              key={choice.value}
              label={choice.label}
              checked={!!s && !isMixed(s, "autofit") && (s.autofit ?? "") === choice.value}
              disabled={!s}
              disabledReason={NEEDS_TEXT}
              title="Leave it (the overflow is marked), shrink the text, or grow the box"
              onClick={() => run({ autofit: (choice.value || null) as Autofit | null })}
            />
          ))}
        </MenuPanel>
      )}
    </div>
  );
}

/** Line height, letter spacing, the space before and after paragraphs, and a list's bullets or numbering. */
function SpacingButton(props: {
  selection: EditSelection | null;
  style: EditStyle;
  disabled: boolean;
  onChange: (changes: EditStyle) => void;
  onDone: () => void;
}) {
  const { open, ref, toggle } = useDropdown({ disabled: props.disabled });
  const s = props.selection;
  const value = (key: "lineHeight" | "letterSpacing" | "spaceBefore" | "spaceAfter", fallback: number | null) =>
    isMixed(s, key) ? null : ((props.style[key] as number | null | undefined) ?? fallback);
  const list = s?.list ?? null;
  const styles = list ? LIST_STYLES[list] : [];
  const listStyle = s?.listStyle ?? "";
  return (
    <div ref={ref} className="relative">
      <PanelButton
        open={open}
        label="Spacing"
        title="Spacing: line height, letter spacing, space before and after, bullets"
        disabled={props.disabled}
        disabledReason={NEEDS_TEXT}
        onClick={toggle}
      >
        <LineSpacing />
      </PanelButton>
      {open && (
        <DropdownPanel role="dialog" aria-label="Spacing" className={panelGrid}>
          <PanelLabel>Line height</PanelLabel>
          <NumberBox
            label="Line height"
            value={value("lineHeight", null)}
            min={0.5}
            max={5}
            decimals={2}
            stepBy={0.05}
            width="w-10"
            presets={[
              { value: null, label: "Deck default" },
              ...LINE_HEIGHTS.map((v) => ({ value: v, label: `${v}` })),
            ]}
            onChange={(lineHeight) => props.onChange({ lineHeight })}
            onDone={props.onDone}
          />
          <PanelLabel>Letter spacing</PanelLabel>
          <NumberBox
            label="Letter spacing"
            value={value("letterSpacing", 0)}
            unit="px"
            min={-20}
            max={100}
            decimals={1}
            width="w-10"
            presets={LETTER_SPACINGS.map((v) => ({ value: v, label: v === 0 ? "Normal" : `${v} px` }))}
            onChange={(letterSpacing) => props.onChange({ letterSpacing: letterSpacing ?? 0 })}
            onDone={props.onDone}
          />
          <PanelLabel off={!s}>Space before</PanelLabel>
          <NumberBox
            label="Space before"
            value={s ? value("spaceBefore", 0) : null}
            unit="px"
            min={0}
            max={400}
            width="w-10"
            presets={PARAGRAPH_SPACES.map((v) => ({ value: v }))}
            disabled={!s}
            disabledReason={NEEDS_TEXT}
            onChange={(spaceBefore) => props.onChange({ spaceBefore: spaceBefore ?? 0 })}
            onDone={props.onDone}
          />
          <PanelLabel off={!s}>Space after</PanelLabel>
          <NumberBox
            label="Space after"
            value={s ? value("spaceAfter", 0) : null}
            unit="px"
            min={0}
            max={400}
            width="w-10"
            presets={PARAGRAPH_SPACES.map((v) => ({ value: v }))}
            disabled={!s}
            disabledReason={NEEDS_TEXT}
            onChange={(spaceAfter) => props.onChange({ spaceAfter: spaceAfter ?? 0 })}
            onDone={props.onDone}
          />
          <PanelLabel htmlFor="edit-list-style" off={!list}>
            {list === "ol" ? "Numbering" : "Bullets"}
          </PanelLabel>
          <RibbonSelect
            id="edit-list-style"
            label={list === "ol" ? "Numbering" : "Bullets"}
            disabled={!list}
            disabledReason="Make the text a list first"
            value={styles.some((o) => o.value === listStyle) ? listStyle : ""}
            onPick={(next) => {
              if (next) props.onChange({ listStyle: next });
            }}
            onDone={props.onDone}
            className="border"
          >
            {!styles.some((o) => o.value === listStyle) && <option value="">{list ? "Its own" : "No list"}</option>}
            {styles.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </RibbonSelect>
        </DropdownPanel>
      )}
    </div>
  );
}
