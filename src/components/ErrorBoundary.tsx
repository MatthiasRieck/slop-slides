import { TriangleAlert } from "lucide-react";
import { Component, type ErrorInfo, type ReactNode } from "react";

import { cn } from "../lib/utils";
import { Button } from "./Button";

interface Props {
  /** What this part of the app is, as the message names it: "the sidebar", "the slide list". */
  name: string;
  /**
   * How much went down with it: one `part` of the window (the rest still works, and the part can
   * be loaded again by itself), or the whole `window`.
   */
  scope?: "part" | "window";
  children: ReactNode;
}

interface State {
  /** What a render under this boundary threw; null while all is well. */
  failure: { error: unknown; stack: string } | null;
  copied: boolean;
}

/** What was thrown and where, as text to send along with a report. */
export function errorDetails(error: unknown, componentStack: string): string {
  const what = error instanceof Error ? (error.stack ?? `${error.name}: ${error.message}`) : String(error);
  return `${what}\n\nIn:${componentStack}`;
}

/**
 * Keeps an error thrown while rendering one part of the app from taking the whole window with
 * it. In place of that part it says that something went wrong there and offers to load the part
 * again (its components start afresh; the deck, the chat and everything in the store are as they
 * were) and to copy what happened, for a report. Around the whole app (`scope="window"`) the way
 * on is to reload the window.
 */
export class ErrorBoundary extends Component<Props, State> {
  override state: State = { failure: null, copied: false };

  static getDerivedStateFromError(error: unknown): Partial<State> {
    return { failure: { error, stack: "" }, copied: false };
  }

  override componentDidCatch(error: unknown, info: ErrorInfo) {
    console.error(`${this.props.name} failed to render`, error, info.componentStack);
    this.setState({ failure: { error, stack: info.componentStack ?? "" } });
  }

  private reload = () => {
    if (this.props.scope === "window") window.location.reload();
    else this.setState({ failure: null });
  };

  private copy = async () => {
    const { failure } = this.state;
    if (!failure) return;
    try {
      await navigator.clipboard.writeText(errorDetails(failure.error, failure.stack));
      this.setState({ copied: true });
    } catch {
      // No clipboard: the details are in the console as well.
    }
  };

  override render() {
    const { failure, copied } = this.state;
    if (!failure) return this.props.children;
    const whole = this.props.scope === "window";
    return (
      <div
        role="alert"
        className={cn(
          "flex h-full min-h-0 w-full flex-col items-center justify-center gap-3 overflow-auto bg-background p-4 text-center text-foreground",
          whole && "fixed inset-0",
        )}
      >
        <TriangleAlert aria-hidden="true" className="size-5 shrink-0 text-warning" />
        <div className="flex max-w-xs flex-col gap-1">
          <p className="text-sm font-medium">Something went wrong here</p>
          <p className="text-xs text-muted-foreground">
            {whole
              ? "SlopSlide ran into a problem and could not show this window. Your deck is saved as you work; reloading brings it back."
              : `A problem stopped ${this.props.name} from showing. The rest of the app still works, and your deck is safe.`}
          </p>
        </div>
        <div className="flex flex-wrap justify-center gap-2">
          <Button variant="primary" size="lg" onClick={this.reload}>
            {whole ? "Reload the window" : "Reload this part"}
          </Button>
          <Button size="lg" onClick={() => void this.copy()}>
            {copied ? "Copied" : "Copy details"}
          </Button>
        </div>
      </div>
    );
  }
}
