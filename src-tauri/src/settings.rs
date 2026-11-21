//! The app's settings: `~/.slopslides/settings.json`, shared by every window. It holds the
//! appearance, what undoing an agent's change does to the chat, and which providers are on;
//! everything else a window remembers stays in that window's own storage.
//!
//! The backend owns the file. It is read once, when the app starts ([`Settings::load`]); a
//! window gets the settings before its page loads ([`Settings::init_script`]), changes them
//! with `update_settings`, and hears of every change, its own and the other windows', with the
//! [`CHANGED_EVENT`] event.

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};

use crate::agent::Provider;
use crate::error::{Error, Result};
use crate::files;

const FILE: &str = "settings.json";
/// Where a settings file that could not be read is moved, for the user to look at.
const BROKEN_FILE: &str = "settings.broken.json";

/// Tells every window the settings changed; its payload is the new [`AppSettings`].
pub const CHANGED_EVENT: &str = "settings-changed";

/// The global a window's page finds the settings in: `{ settings, notice }`.
const GLOBAL: &str = "__SLOPSLIDE_SETTINGS__";

#[derive(Debug, Clone, Copy, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Appearance {
    /// What the system is set to.
    #[default]
    System,
    Light,
    Dark,
}

/// What undoing a change the agent made does to the chat it was made in.
#[derive(Debug, Clone, Copy, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum RewindSetting {
    /// The user is asked each time.
    #[default]
    Ask,
    /// The chat goes back to before the change too.
    Rewind,
    /// Only the deck changes; the chat stays as it is.
    Deck,
}

/// One provider's settings.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct ProviderSettings {
    /// Whether the provider is offered for chats. One that is off can still be read in the
    /// chats it wrote, but takes no turn.
    pub enabled: bool,
}

impl Default for ProviderSettings {
    fn default() -> Self {
        ProviderSettings { enabled: true }
    }
}

/// The settings of each provider.
#[derive(Debug, Clone, Copy, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct Providers {
    claude: ProviderSettings,
    codex: ProviderSettings,
    copilot: ProviderSettings,
}

impl Providers {
    fn of(&mut self, provider: Provider) -> &mut ProviderSettings {
        match provider {
            Provider::Claude => &mut self.claude,
            Provider::Codex => &mut self.codex,
            Provider::Copilot => &mut self.copilot,
        }
    }

    pub fn enabled(mut self, provider: Provider) -> bool {
        self.of(provider).enabled
    }
}

/// Everything in `settings.json`. A field the file leaves out has its default, and fields this
/// version does not know are ignored.
#[derive(Debug, Clone, Copy, Default, PartialEq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct AppSettings {
    pub appearance: Appearance,
    pub rewind: RewindSetting,
    pub providers: Providers,
}

impl AppSettings {
    /// The settings as the app uses them: with no provider on there would be nobody to chat
    /// with, so a file that says so is taken to mean all of them.
    fn valid(mut self) -> Self {
        if !Provider::ALL.iter().any(|p| self.providers.enabled(*p)) {
            self.providers = Providers::default();
        }
        self
    }
}

/// A change to the settings: what it leaves out stays as it is.
#[derive(Debug, Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct SettingsPatch {
    appearance: Option<Appearance>,
    rewind: Option<RewindSetting>,
    providers: Option<ProvidersPatch>,
}

/// The providers a [`SettingsPatch`] changes.
#[derive(Debug, Default, Deserialize)]
#[serde(default)]
struct ProvidersPatch {
    claude: Option<ProviderSettings>,
    codex: Option<ProviderSettings>,
    copilot: Option<ProviderSettings>,
}

impl ProvidersPatch {
    fn of(&self, provider: Provider) -> Option<ProviderSettings> {
        match provider {
            Provider::Claude => self.claude,
            Provider::Codex => self.codex,
            Provider::Copilot => self.copilot,
        }
    }
}

/// `settings` with `patch` applied; an error when the patch turns off a provider that cannot
/// be: one of `busy` (those with a turn running), or the last one on.
fn patched(settings: AppSettings, patch: &SettingsPatch, busy: &[Provider]) -> Result<AppSettings> {
    let mut next = settings;
    if let Some(appearance) = patch.appearance {
        next.appearance = appearance;
    }
    if let Some(rewind) = patch.rewind {
        next.rewind = rewind;
    }
    for provider in Provider::ALL {
        if let Some(changed) = patch.providers.as_ref().and_then(|p| p.of(provider)) {
            *next.providers.of(provider) = changed;
        }
    }
    if !Provider::ALL.iter().any(|p| next.providers.enabled(*p)) {
        return Err(Error::msg("At least one provider has to stay on."));
    }
    let turned_off =
        |p: &&Provider| settings.providers.enabled(**p) && !next.providers.enabled(**p);
    if let Some(provider) = Provider::ALL
        .iter()
        .filter(turned_off)
        .find(|p| busy.contains(p))
    {
        return Err(Error::msg(format!(
            "{} is working in a chat. Stop it or wait for it to finish before turning it off.",
            provider.label()
        )));
    }
    Ok(next)
}

/// The settings in `raw`, the text of a settings file: an object, which a list would also pass
/// for if the settings were read from it directly.
fn parse(raw: &[u8]) -> serde_json::Result<AppSettings> {
    let fields = serde_json::from_slice::<serde_json::Map<String, serde_json::Value>>(raw)?;
    serde_json::from_value(fields.into())
}

/// The settings while the app runs (managed state), and the file they are saved in.
pub struct Settings {
    /// None when the app's folder cannot be found: the settings then last as long as the app.
    file: Option<PathBuf>,
    current: Mutex<AppSettings>,
    /// What to tell the user about the settings file, once (see [`Settings::init_script`]).
    notice: Mutex<Option<String>>,
}

impl Settings {
    /// The settings saved in the app's folder in the user's home.
    pub fn load_from_home() -> Self {
        match files::app_home() {
            Ok(home) => Self::load(&home),
            Err(e) => {
                eprintln!("the settings are not saved: {e}");
                Settings {
                    file: None,
                    current: Mutex::default(),
                    notice: Mutex::default(),
                }
            }
        }
    }

    /// The settings saved in `home`, the app's folder: the defaults when there are none yet. A
    /// file that cannot be read as settings is moved aside ([`BROKEN_FILE`]) rather than
    /// written over, the app starts on the defaults, and a notice says so.
    pub fn load(home: &Path) -> Self {
        let file = home.join(FILE);
        let (settings, notice) = match fs::read(&file) {
            Ok(raw) => match parse(&raw) {
                Ok(settings) => (settings.valid(), None),
                Err(e) => {
                    eprintln!("cannot read {}: {e}", file.display());
                    let notice = match fs::rename(&file, home.join(BROKEN_FILE)) {
                        Ok(()) => format!(
                            "{FILE} could not be read; it was moved to {BROKEN_FILE} and \
                             defaults are used."
                        ),
                        Err(_) => format!("{FILE} could not be read; defaults are used."),
                    };
                    (AppSettings::default(), Some(notice))
                }
            },
            Err(_) => (AppSettings::default(), None),
        };
        Settings {
            file: Some(file),
            current: Mutex::new(settings),
            notice: Mutex::new(notice),
        }
    }

    pub fn get(&self) -> AppSettings {
        *self.current.lock().unwrap()
    }

    /// An error telling the user `provider` is turned off, when it is: it takes no turn then.
    pub fn require_enabled(&self, provider: Provider) -> Result<()> {
        if self.get().providers.enabled(provider) {
            return Ok(());
        }
        Err(Error::msg(format!(
            "{} is turned off. Turn it on in Settings > Providers to continue this chat.",
            provider.label()
        )))
    }

    /// Applies `patch`, saves the file and returns the new settings, which `announce` gets
    /// first: changes are announced in the order they were made. `busy` are the providers with
    /// a turn running, which cannot be turned off. Nothing changes when the patch is refused
    /// or the file cannot be written.
    pub fn update(
        &self,
        patch: &SettingsPatch,
        busy: &[Provider],
        announce: impl FnOnce(&AppSettings),
    ) -> Result<AppSettings> {
        let mut current = self.current.lock().unwrap();
        let next = patched(*current, patch, busy)?;
        if let Some(file) = &self.file {
            let mut json = serde_json::to_vec_pretty(&next)
                .map_err(|e| Error::msg(format!("cannot save the settings: {e}")))?;
            json.push(b'\n');
            files::atomic_write(file, &json)?;
        }
        *current = next;
        announce(&next);
        Ok(next)
    }

    /// The script a new window runs before its page loads, which hands the page the settings
    /// (so it never draws in the wrong appearance first) and, to the first window built since
    /// a broken settings file was found, the notice about it.
    pub fn init_script(&self) -> String {
        let notice = self.notice.lock().unwrap().take();
        init_script(&self.get(), notice.as_deref())
    }
}

/// A script that sets the [`GLOBAL`] to `settings` and `notice`.
fn init_script(settings: &AppSettings, notice: Option<&str>) -> String {
    let value = serde_json::json!({ "settings": settings, "notice": notice });
    format!("window.{GLOBAL} = {};", script_safe(&value.to_string()))
}

/// `json` spelled so it can stand in a script, also one inlined in a page: JSON allows the
/// line separators U+2028 and U+2029 in a string where JavaScript once ended the line, and
/// `</script>` or `<!--` in a string would end or derail the script element around it. In JSON
/// these characters only occur inside strings, where an escape means the same.
fn script_safe(json: &str) -> String {
    let mut safe = String::with_capacity(json.len());
    for c in json.chars() {
        match c {
            '<' => safe.push_str("\\u003c"),
            '>' => safe.push_str("\\u003e"),
            '&' => safe.push_str("\\u0026"),
            '\u{2028}' => safe.push_str("\\u2028"),
            '\u{2029}' => safe.push_str("\\u2029"),
            c => safe.push(c),
        }
    }
    safe
}

#[cfg(test)]
mod tests {
    use serde_json::{json, Value};

    use super::*;
    use crate::test_support::TempDir;

    fn patch(value: Value) -> SettingsPatch {
        serde_json::from_value(value).unwrap()
    }

    /// The saved settings of `home`.
    fn saved(home: &Path) -> Value {
        serde_json::from_slice(&fs::read(home.join(FILE)).unwrap()).unwrap()
    }

    #[test]
    fn the_defaults_follow_the_system_ask_and_have_every_provider_on() {
        assert_eq!(
            serde_json::to_value(AppSettings::default()).unwrap(),
            json!({
                "appearance": "system",
                "rewind": "ask",
                "providers": {
                    "claude": { "enabled": true },
                    "codex": { "enabled": true },
                    "copilot": { "enabled": true },
                },
            })
        );
    }

    #[test]
    fn a_home_without_settings_starts_on_the_defaults_and_writes_nothing() {
        let home = TempDir::new("settings");
        let settings = Settings::load(&home);
        assert_eq!(settings.get(), AppSettings::default());
        assert!(!home.join(FILE).exists());
        assert!(settings.init_script().contains("\"notice\":null"));
    }

    #[test]
    fn a_partial_file_takes_the_defaults_for_what_it_leaves_out() {
        let home = TempDir::new("settings");
        home.write(
            FILE,
            r#"{"appearance": "dark", "providers": {"codex": {"enabled": false}}, "zoom": 2}"#,
        );
        let settings = Settings::load(&home).get();
        assert_eq!(settings.appearance, Appearance::Dark);
        assert_eq!(settings.rewind, RewindSetting::Ask);
        assert!(settings.providers.enabled(Provider::Claude));
        assert!(!settings.providers.enabled(Provider::Codex));
        assert!(settings.providers.enabled(Provider::Copilot));

        home.write(FILE, r#"{"rewind": "deck", "providers": {"copilot": {}}}"#);
        let settings = Settings::load(&home).get();
        assert_eq!(settings.appearance, Appearance::System);
        assert_eq!(settings.rewind, RewindSetting::Deck);
        assert_eq!(settings.providers, Providers::default());
        home.write(FILE, "{}");
        assert_eq!(Settings::load(&home).get(), AppSettings::default());
    }

    #[test]
    fn a_file_with_no_provider_on_means_all_of_them() {
        let home = TempDir::new("settings");
        let off = json!({ "enabled": false });
        home.write(
            FILE,
            json!({
                "appearance": "light",
                "providers": { "claude": off, "codex": off, "copilot": off },
            })
            .to_string(),
        );
        let settings = Settings::load(&home);
        assert_eq!(settings.get().providers, Providers::default());
        assert_eq!(
            settings.get().appearance,
            Appearance::Light,
            "the rest is kept"
        );
        assert!(home.join(FILE).exists() && !home.join(BROKEN_FILE).exists());
    }

    #[test]
    fn a_broken_file_is_moved_aside_and_the_notice_is_given_once() {
        for broken in ["{\"appearance\": \"da", r#"{"appearance": "purple"}"#, "[]"] {
            let home = TempDir::new("settings");
            home.write(FILE, broken);
            let settings = Settings::load(&home);
            assert_eq!(settings.get(), AppSettings::default(), "{broken}");
            assert!(!home.join(FILE).exists(), "{broken}");
            assert_eq!(
                fs::read_to_string(home.join(BROKEN_FILE)).unwrap(),
                broken,
                "kept for the user to look at"
            );

            let first = settings.init_script();
            assert!(
                first.contains(
                    "\"notice\":\"settings.json could not be read; it was moved to \
                     settings.broken.json and defaults are used.\""
                ),
                "{first}"
            );
            let second = settings.init_script();
            assert!(second.contains("\"notice\":null"), "{second}");

            // The next start finds no settings, and nothing to complain about.
            let again = Settings::load(&home);
            assert!(again.init_script().contains("\"notice\":null"));
        }
    }

    #[test]
    fn an_older_broken_file_gives_way_to_the_new_one() {
        let home = TempDir::new("settings");
        home.write(BROKEN_FILE, "old");
        home.write(FILE, "new and broken");
        Settings::load(&home);
        assert_eq!(
            fs::read_to_string(home.join(BROKEN_FILE)).unwrap(),
            "new and broken"
        );
    }

    #[test]
    fn a_change_is_saved_announced_and_read_back() {
        let home = TempDir::new("settings");
        let settings = Settings::load(&home);
        let announced = Mutex::new(Vec::new());
        let announce = |next: &AppSettings| announced.lock().unwrap().push(*next);

        let next = settings
            .update(
                &patch(json!({ "appearance": "dark", "rewind": "rewind" })),
                &[],
                announce,
            )
            .unwrap();
        assert_eq!(next.appearance, Appearance::Dark);
        assert_eq!(next.rewind, RewindSetting::Rewind);
        assert_eq!(settings.get(), next);
        let next = settings
            .update(
                &patch(json!({ "providers": { "copilot": { "enabled": false } } })),
                &[],
                announce,
            )
            .unwrap();
        assert_eq!(next.appearance, Appearance::Dark, "left out, left alone");
        assert!(!next.providers.enabled(Provider::Copilot));
        let heard = announced.lock().unwrap().clone();
        assert_eq!(heard.len(), 2, "each change, in order");
        assert_eq!(heard[0].providers, Providers::default());
        assert_eq!(heard[1], next);

        assert_eq!(
            saved(&home),
            json!({
                "appearance": "dark",
                "rewind": "rewind",
                "providers": {
                    "claude": { "enabled": true },
                    "codex": { "enabled": true },
                    "copilot": { "enabled": false },
                },
            })
        );
        // Written whole, through a temporary file that is gone again.
        let names: Vec<_> = fs::read_dir(&home)
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        assert_eq!(names, [FILE]);
        assert_eq!(Settings::load(&home).get(), next, "the next start reads it");
    }

    #[test]
    fn the_last_provider_stays_on() {
        let home = TempDir::new("settings");
        let settings = Settings::load(&home);
        let off = json!({ "enabled": false });
        settings
            .update(
                &patch(json!({ "providers": { "claude": off, "codex": off } })),
                &[],
                |_| {},
            )
            .unwrap();
        let before = fs::read(home.join(FILE)).unwrap();

        let refused = settings
            .update(
                &patch(json!({ "appearance": "dark", "providers": { "copilot": off } })),
                &[],
                |_| panic!("nothing changed"),
            )
            .unwrap_err();
        assert_eq!(refused.to_string(), "At least one provider has to stay on.");
        assert_eq!(
            settings.get().appearance,
            Appearance::System,
            "a refused patch changes nothing"
        );
        assert_eq!(fs::read(home.join(FILE)).unwrap(), before);

        // Swapping the last one for another in one change is fine.
        let on = json!({ "enabled": true });
        let next = settings
            .update(
                &patch(json!({ "providers": { "copilot": off, "codex": on } })),
                &[],
                |_| {},
            )
            .unwrap();
        assert!(next.providers.enabled(Provider::Codex));
        assert!(!next.providers.enabled(Provider::Copilot));
    }

    #[test]
    fn a_provider_at_work_cannot_be_turned_off() {
        let home = TempDir::new("settings");
        let settings = Settings::load(&home);
        let off = json!({ "enabled": false });
        let cases = [
            (Provider::Claude, "claude", "Claude Code"),
            (Provider::Codex, "codex", "Codex"),
            (Provider::Copilot, "copilot", "GitHub Copilot"),
        ];
        for (provider, id, label) in cases {
            let refused = settings
                .update(
                    &patch(json!({ "providers": { id: off } })),
                    &[provider],
                    |_| panic!("nothing changed"),
                )
                .unwrap_err();
            assert_eq!(
                refused.to_string(),
                format!(
                    "{label} is working in a chat. Stop it or wait for it to finish before \
                     turning it off."
                )
            );
        }
        assert_eq!(settings.get(), AppSettings::default());
        assert!(!home.join(FILE).exists());

        // The others can be, and so can everything else while it works.
        let busy = [Provider::Codex];
        settings
            .update(
                &patch(json!({ "rewind": "deck", "providers": { "copilot": off } })),
                &busy,
                |_| {},
            )
            .unwrap();
        // Saying again that a busy provider is on, or off when it already is, turns nothing off.
        settings
            .update(
                &patch(json!({ "providers": { "codex": { "enabled": true }, "copilot": off } })),
                &[Provider::Codex, Provider::Copilot],
                |_| {},
            )
            .unwrap();
    }

    #[test]
    fn a_provider_that_is_off_takes_no_turn() {
        let home = TempDir::new("settings");
        let settings = Settings::load(&home);
        assert!(settings.require_enabled(Provider::Codex).is_ok());
        settings
            .update(
                &patch(json!({ "providers": { "codex": { "enabled": false } } })),
                &[],
                |_| {},
            )
            .unwrap();
        assert_eq!(
            settings
                .require_enabled(Provider::Codex)
                .unwrap_err()
                .to_string(),
            "Codex is turned off. Turn it on in Settings > Providers to continue this chat."
        );
        assert!(settings.require_enabled(Provider::Claude).is_ok());
    }

    #[test]
    fn a_patch_reads_what_the_frontend_sends() {
        let empty = patch(json!({}));
        assert!(empty.appearance.is_none() && empty.rewind.is_none() && empty.providers.is_none());
        let nulls = patch(json!({ "appearance": null, "providers": { "claude": null } }));
        assert_eq!(
            patched(AppSettings::default(), &nulls, &[]).unwrap(),
            AppSettings::default()
        );
        assert!(serde_json::from_value::<SettingsPatch>(json!({ "appearance": "sepia" })).is_err());
    }

    #[test]
    fn settings_that_cannot_be_written_stay_as_they_were() {
        let home = TempDir::new("settings");
        let settings = Settings::load(&home.join("gone"));
        let failed = settings.update(&patch(json!({ "appearance": "dark" })), &[], |_| {
            panic!("nothing changed")
        });
        assert!(failed.is_err());
        assert_eq!(settings.get(), AppSettings::default());
    }

    #[test]
    fn the_script_hands_the_page_the_settings_before_it_loads() {
        let settings = AppSettings {
            appearance: Appearance::Dark,
            ..AppSettings::default()
        };
        let script = init_script(&settings, None);
        let json = script
            .strip_prefix("window.__SLOPSLIDE_SETTINGS__ = ")
            .and_then(|rest| rest.strip_suffix(';'))
            .unwrap_or_else(|| panic!("{script}"));
        assert_eq!(
            serde_json::from_str::<Value>(json).unwrap(),
            json!({ "settings": settings, "notice": null })
        );
    }

    #[test]
    fn the_script_cannot_be_ended_or_broken_by_what_it_carries() {
        let notice = "a</script><script>alert(1)</script> <!-- & \u{2028}b\u{2029}c \"q\" \\ \n";
        let script = init_script(&AppSettings::default(), Some(notice));
        for hazard in ['<', '>', '&', '\u{2028}', '\u{2029}', '\n'] {
            assert!(!script.contains(hazard), "{hazard:?} in {script}");
        }
        assert!(script.contains("\\u003c/script\\u003e"));
        assert!(script.contains("\\u2028b\\u2029c"));
        // Still the same value once the page reads it.
        let json = script
            .strip_prefix("window.__SLOPSLIDE_SETTINGS__ = ")
            .and_then(|rest| rest.strip_suffix(';'))
            .unwrap();
        assert_eq!(
            serde_json::from_str::<Value>(json).unwrap()["notice"],
            notice
        );
    }
}
