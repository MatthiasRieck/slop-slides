import { getVersion } from "@tauri-apps/api/app";
import { useEffect, useState } from "react";

import { Badge } from "@/components/ui/badge";
import { Item, ItemActions, ItemContent, ItemDescription, ItemGroup, ItemTitle } from "@/components/ui/item";

/** The settings' About section: which version of the app this is. */
export function AboutSection() {
  const [version, setVersion] = useState<string | null>(null);

  useEffect(() => {
    let gone = false;
    // Without one to read (the browser preview), the section leaves the version out.
    Promise.resolve()
      .then(getVersion)
      .then(
        (found) => !gone && typeof found === "string" && setVersion(found),
        () => {},
      );
    return () => {
      gone = true;
    };
  }, []);

  return (
    <ItemGroup className="gap-0 rounded-lg border bg-card">
      <Item>
        <ItemContent>
          <ItemTitle role="heading" aria-level={4}>
            Version
          </ItemTitle>
          <ItemDescription className="text-xs">A desktop slide editor you drive by chatting.</ItemDescription>
        </ItemContent>
        {version && (
          <ItemActions>
            <Badge variant="outline" data-testid="app-version" className="selectable tabular-nums">
              SlopSlide {version}
            </Badge>
          </ItemActions>
        )}
      </Item>
    </ItemGroup>
  );
}
