import { Check, Copy } from "lucide-react";
import { useEffect, useState } from "react";

import { Button } from "@/components/ui/button";

/**
 * Copies `text`, showing for a moment that it did. `label` names what is copied ("Copy message");
 * `className` places it and sets when it shows; `size` is the button's, 24px unless given.
 *
 * `plain` is for the one each message of the conversation has: it says what it does with the
 * browser's own tooltip, not a `Tooltip` of its own. A conversation holds hundreds of them, and
 * as many tooltips made every word of a reply coming in cost a third more.
 */
export function CopyButton(props: {
  text: string;
  label: string;
  className?: string;
  size?: "icon-xs" | "icon-2xs";
  plain?: boolean;
}) {
  const { text, label, className, size = "icon-xs" } = props;
  const [copied, setCopied] = useState(false);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 2000);
    return () => clearTimeout(timer);
  }, [copied]);
  const says = failed ? "Could not copy. Try again." : copied ? "Copied" : label;
  return (
    <Button
      variant="tool"
      size={size}
      {...(props.plain ? { title: says } : { tooltip: says })}
      aria-label={copied ? "Copied" : label}
      onClick={() => {
        void navigator.clipboard
          .writeText(text)
          .then(() => {
            setCopied(true);
            setFailed(false);
          })
          .catch(() => setFailed(true));
      }}
      className={className}
    >
      {copied ? <Check /> : <Copy />}
    </Button>
  );
}
