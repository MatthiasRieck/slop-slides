import { getVersion } from "@tauri-apps/api/app";
import { useEffect, useState } from "react";

import { SettingRow, SettingsGroup } from "./parts";

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
    <SettingsGroup>
      <SettingRow title="Version" hint="A desktop slide editor you drive by chatting.">
        {version && (
          <span data-testid="app-version" className="selectable shrink-0 text-sm tabular-nums text-muted-foreground">
            SlopSlide {version}
          </span>
        )}
      </SettingRow>
    </SettingsGroup>
  );
}
