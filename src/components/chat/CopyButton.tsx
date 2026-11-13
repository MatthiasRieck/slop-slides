import { Check, Copy } from "lucide-react";
import { useEffect, useState } from "react";

import { cn } from "../../lib/utils";

/**
 * Copies `text`, showing for a moment that it did. `label` names what is copied ("Copy message");
 * `className` places it and sets when it shows.
 */
export function CopyButton({ text, label, className }: { text: string; label: string; className?: string }) {
  const [copied, setCopied] = useState(false);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 2000);
    return () => clearTimeout(timer);
  }, [copied]);
  return (
    <button
      type="button"
      title={failed ? "Could not copy. Try again." : copied ? "Copied" : label}
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
      className={cn("rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground", className)}
    >
      {copied ? <Check className="size-3" /> : <Copy className="size-3" />}
    </button>
  );
}
