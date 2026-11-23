import { Check, Copy } from "lucide-react";
import { useEffect, useState } from "react";

import { Button } from "@/components/ui/button";

/**
 * Copies `text`, showing for a moment that it did. `label` names what is copied ("Copy message");
 * `className` places it and sets when it shows; `size` is the button's, 24px unless given.
 */
export function CopyButton(props: { text: string; label: string; className?: string; size?: "icon-xs" | "icon-2xs" }) {
  const { text, label, className, size = "icon-xs" } = props;
  const [copied, setCopied] = useState(false);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 2000);
    return () => clearTimeout(timer);
  }, [copied]);
  return (
    <Button
      variant="tool"
      size={size}
      tooltip={failed ? "Could not copy. Try again." : copied ? "Copied" : label}
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
