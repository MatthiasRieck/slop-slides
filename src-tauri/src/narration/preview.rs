//! A voice to hear before a deck is said with it: one short sentence, said once by the
//! service and kept in `~/.slopslides/voice-previews`, so hearing a voice again costs nothing.

use std::fs;
use std::path::{Path, PathBuf};

use super::cloud::{self, Provider};
use super::manifest::file_stem;
use super::settings::{language, Delivery};
use super::{audio, Language};
use crate::error::{Error, Result};

/// The folder in the app's `home` the samples are kept in, for every deck.
const FOLDER: &str = "voice-previews";

/// What a voice says as its sample, in `language`: a sentence a presenter might open with.
pub fn sentence(language: &Language) -> &'static str {
    match language.id {
        "de" => "Hallo, ich führe Sie durch diese Präsentation. So klinge ich.",
        "fr" => "Bonjour, je vous guide dans cette présentation. Voici ma voix.",
        "es" => "Hola, le acompaño en esta presentación. Así sueno.",
        "it" => "Buongiorno, vi guido in questa presentazione. Ecco la mia voce.",
        "pt" => "Olá, vou acompanhar você nesta apresentação. Esta é a minha voz.",
        "ru" => "Здравствуйте, я проведу вас по этой презентации. Так я звучу.",
        "zh" => "你好，我来为你讲解这份演示文稿。这就是我的声音。",
        "ja" => "こんにちは。このプレゼンテーションをご案内します。これが私の声です。",
        "ko" => "안녕하세요, 이 발표를 안내해 드리겠습니다. 제 목소리는 이렇습니다.",
        _ => "Hello, I will take you through this presentation. This is how I sound.",
    }
}

/// Where the sample of `voice` of `provider` in `language` is kept. A sample is of the
/// service's model too: another model is another voice, and is said anew.
pub fn sample_file(home: &Path, provider: Provider, voice: &str, language: &Language) -> PathBuf {
    let name = format!(
        "{}-{}-{}-{}",
        provider.id(),
        provider.model(),
        voice,
        language.id
    );
    home.join(FOLDER).join(format!("{}.wav", file_stem(&name)))
}

/// The sample of `voice` of `provider` in the language with id `language_id`, as a WAV file:
/// the one kept, or said now with the provider's key in `home` and kept for the next time.
pub async fn preview_voice(
    home: &Path,
    provider: Provider,
    voice: &str,
    language_id: &str,
) -> Result<PathBuf> {
    let language = language(language_id)
        .ok_or_else(|| Error::msg(format!("unknown narration language: {language_id}")))?;
    if !provider.accepts_voice(voice) {
        return Err(Error::msg(format!(
            "\"{voice}\" is no {} voice.",
            provider.name()
        )));
    }
    let file = sample_file(home, provider, voice, language);
    if file.is_file() {
        return Ok(file);
    }
    let Some((key, _)) = cloud::key(home, provider) else {
        return Err(Error::msg(format!(
            "Add your {} API key first, to hear its voices.",
            provider.name()
        )));
    };
    let said = cloud::say(
        provider,
        &key,
        sentence(language),
        voice,
        language.name,
        &Delivery::default(),
    )
    .await?;
    fs::create_dir_all(home.join(FOLDER))?;
    audio::replace_wav(&file, &said.samples, audio::RATE)?;
    Ok(file)
}

#[cfg(test)]
mod tests {
    use super::super::testing::temp_dir;
    use super::super::LANGUAGES;
    use super::*;

    #[test]
    fn every_language_has_a_sentence_of_its_own() {
        let mut seen = std::collections::BTreeSet::new();
        for language in LANGUAGES {
            assert!(seen.insert(sentence(language)), "{}", language.id);
        }
    }

    #[test]
    fn a_sample_is_kept_per_voice_and_language_and_never_said_twice() {
        let home = temp_dir();
        let (en, de) = (language("en").unwrap(), language("de").unwrap());
        let file = sample_file(&home, Provider::OpenAi, "marin", en);
        assert!(file.starts_with(home.join("voice-previews")));
        assert_ne!(file, sample_file(&home, Provider::OpenAi, "marin", de));
        assert_ne!(file, sample_file(&home, Provider::OpenAi, "coral", en));
        // One that is kept comes back without a key, and without asking anyone.
        fs::create_dir_all(file.parent().unwrap()).unwrap();
        audio::write_wav(&file, &[0.0; 240], audio::RATE).unwrap();
        // The key is looked for in `home` first: a voice with no sample and no key says why.
        let kept =
            tauri::async_runtime::block_on(preview_voice(&home, Provider::OpenAi, "marin", "en"));
        assert_eq!(kept.unwrap(), file);
        let unknown =
            tauri::async_runtime::block_on(preview_voice(&home, Provider::OpenAi, "bob", "en"));
        assert!(unknown.unwrap_err().to_string().contains("no OpenAI voice"));
        let nowhere =
            tauri::async_runtime::block_on(preview_voice(&home, Provider::OpenAi, "marin", "xx"));
        assert!(nowhere.is_err());
        fs::remove_dir_all(home).unwrap();
    }
}
