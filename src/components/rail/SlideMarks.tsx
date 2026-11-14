import { AlertTriangle, AudioLines, CircleAlert, EyeOff, Lock, MessageSquare, Search, StickyNote } from "lucide-react";
import type { ReactNode } from "react";

import type { LintIssue, Slide } from "../../lib/api";
import { cn, plural } from "../../lib/utils";
import { useApp } from "../../store";
import { useOverflowMarks } from "./overflowMarks";

/** How a mark eases in and out as a slide is hidden or locked. */
const MARK_TRANSITION = "transition duration-200";

/** What the deck check found on a slide: how many problems, and whether one of them is an error. */
export interface SlideProblems {
  count: number;
  error: boolean;
}

const problemsOf = new WeakMap<LintIssue[], Map<string, SlideProblems>>();

/**
 * What the deck check found on `slide`, if anything. The check's result is gone through once,
 * however many thumbnails ask: it stays the same list until the deck is checked again.
 */
export function slideProblems(issues: LintIssue[] | null, slide: string): SlideProblems | undefined {
  if (!issues || issues.length === 0) return undefined;
  let bySlide = problemsOf.get(issues);
  if (!bySlide) {
    bySlide = new Map();
    for (const issue of issues) {
      if (issue.slide === null) continue;
      const found = bySlide.get(issue.slide) ?? { count: 0, error: false };
      bySlide.set(issue.slide, { count: found.count + 1, error: found.error || issue.severity === "error" });
    }
    problemsOf.set(issues, bySlide);
  }
  return bySlide.get(slide);
}

/**
 * What there is to know about a slide, as small marks under its number, beside the picture and
 * never on it: a slide's own footer and page number stay readable at any size. From what needs
 * doing to what is just so: problems the deck check found, content running past the slide, locked,
 * hidden, comments, matches of the search, speaker notes, narration.
 *
 * Locked and hidden stay mounted while off, so they fade out the way they came in. Each mark reads
 * just what it shows, so a comment or a check renders the slides concerned.
 */
export function SlideMarks(props: { slide: Slide; comments: number; matches?: number }) {
  const { slide, comments, matches } = props;
  const problems = useApp((s) => slideProblems(s.lint, slide.id));
  const overflow = useOverflowMarks((s) => (s.slides[slide.id]?.hash === slide.hash ? s.slides[slide.id]!.count : 0));
  return (
    <>
      {problems && (
        <Mark
          testId="problem-mark"
          title={`${plural(problems.count, "problem")} found by the deck check: see the list under the slide`}
          className={problems.error ? "text-destructive" : "text-warning"}
        >
          <CircleAlert />
        </Mark>
      )}
      {overflow > 0 && (
        <Mark
          testId="overflow-mark"
          title={`${plural(overflow, "element")} ${overflow === 1 ? "runs" : "run"} past the slide or ${overflow === 1 ? "is" : "are"} cut off`}
          className="text-warning"
        >
          <AlertTriangle />
        </Mark>
      )}
      <FadingMark shown={slide.locked} testId="locked-mark" title="Locked: neither you nor the agent can change it">
        <Lock aria-label="Locked slide" />
      </FadingMark>
      <FadingMark shown={slide.hidden} testId="hidden-mark" title="Hidden: skipped when presenting">
        <EyeOff aria-label="Hidden slide" />
      </FadingMark>
      {comments > 0 && (
        <Mark testId="comment-count" title={plural(comments, "comment")} className="text-primary">
          <MessageSquare />
          {comments > 1 && <Count>{comments}</Count>}
        </Mark>
      )}
      {matches !== undefined && matches > 0 && (
        <Mark testId="match-count" title={`${plural(matches, "match", "matches")} of the search`}>
          <Search />
          <Count>{matches}</Count>
        </Mark>
      )}
      {!!slide.notes?.trim() && (
        <Mark testId="notes-mark" title="Has speaker notes">
          <StickyNote />
        </Mark>
      )}
      {!!slide.narration?.trim() && (
        <Mark testId="narration-mark" title="Has narration">
          <AudioLines />
        </Mark>
      )}
    </>
  );
}

/** One mark of the gutter: an icon, with a count under it when there is one to tell. */
function Mark(props: { testId: string; title: string; className?: string; children: ReactNode }) {
  return (
    <span
      data-testid={props.testId}
      title={props.title}
      className={cn("flex flex-col items-center gap-px text-muted-foreground [&_svg]:size-3", props.className)}
    >
      {props.children}
    </span>
  );
}

/** How many of what the mark is about, small enough for the gutter. */
function Count({ children }: { children: ReactNode }) {
  return <span className="text-[9px] font-medium leading-none tabular-nums">{children}</span>;
}

/** A mark for something that goes on and off (locked, hidden): it takes its place and gives it up with a fade. */
function FadingMark(props: { shown: boolean; testId: string; title: string; children: ReactNode }) {
  return (
    <span
      data-testid={props.testId}
      data-shown={props.shown}
      aria-hidden={!props.shown}
      title={props.shown ? props.title : undefined}
      className={cn(
        "flex justify-center overflow-hidden text-muted-foreground [&_svg]:size-3",
        MARK_TRANSITION,
        props.shown ? "h-3 opacity-100" : "-mt-1 h-0 scale-75 opacity-0",
      )}
    >
      {props.children}
    </span>
  );
}
