import { type ReactNode, useEffect } from "react";

import { TooltipProvider } from "@/components/ui/tooltip";
import { followFramePresses } from "@/lib/framePress";

/** How long the pointer rests on a control before its tooltip shows; the next one then shows at once. */
const TOOLTIP_DELAY_MS = 500;

/**
 * What every window of the app is rendered in (see ../main.tsx): the tooltips' shared delay, and
 * the watch that lets a press in a slide preview close the popups open over the app. The
 * shadcn/ui components work without it, as in a test that renders one part; a tooltip then waits
 * Base UI's own delay.
 */
export function AppProviders({ children }: { children: ReactNode }) {
  useEffect(() => followFramePresses(), []);
  return <TooltipProvider delay={TOOLTIP_DELAY_MS}>{children}</TooltipProvider>;
}
