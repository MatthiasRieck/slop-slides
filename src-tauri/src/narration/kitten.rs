//! Kitten TTS 0.8, the speech model narration runs: English text to the model's phoneme ids,
//! its voices, and running it with ONNX Runtime.
//!
//! The model was trained on espeak-ng's US English phonemes. espeak-ng is GPL, so the phonemes
//! come from Misaki's English lexicon (MIT) instead, written the way espeak-ng writes them
//! (see [`espeak`]); a word in no lexicon is spelled out.

use std::collections::HashMap;
use std::io::Read;
use std::path::Path;
use std::sync::OnceLock;

use misaki_rs::fallback::FallbackError;
use misaki_rs::{Fallback, Language, G2P};
use ort::session::Session;
use ort::value::Tensor;

use crate::error::{Error, Result};

/// The model's phoneme symbols, in id order (KittenTTS's `TextCleaner`).
const PAD: &str = "$";
const PUNCTUATION: &str = ";:,.!?¡¿—…\"«»\"\" ";
const LETTERS: &str = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
const LETTERS_IPA: &str = "ɑɐɒæɓʙβɔɕçɗɖðʤəɘɚɛɜɝɞɟʄɡɠɢʛɦɧħɥʜɨɪʝɭɬɫɮʟɱɯɰŋɳɲɴøɵɸθœɶʘɹɺɾɻʀʁɽʂʃʈʧʉʊʋⱱʌɣɤʍχʎʏʑʐʒʔʡʕʢǀǁǂǃˈˌːˑʼʴʰʱʲʷˠˤ˞↓↑→↗↘'̩'ᵻ";
/// The ids around every input: the pad first, then `…` and the pad last.
const START: i64 = 0;
const END: [i64; 2] = [10, 0];

/// The most ids the model reads at once (its text encoder's positions).
pub const MAX_TOKENS: usize = 510;
/// Samples the model makes past the end of what it says, cut off (as KittenTTS does).
const TAIL: usize = 5000;
/// The width of a voice's style vectors.
const STYLE: usize = 256;

/// The model's id for each symbol.
fn symbol_ids() -> &'static HashMap<char, i64> {
    static IDS: OnceLock<HashMap<char, i64>> = OnceLock::new();
    IDS.get_or_init(|| {
        let symbols = PAD
            .chars()
            .chain(PUNCTUATION.chars())
            .chain(LETTERS.chars());
        // A symbol listed twice keeps its last id, as in the Python dict the list comes from.
        symbols
            .chain(LETTERS_IPA.chars())
            .enumerate()
            .map(|(id, c)| (c, id as i64))
            .collect()
    })
}

/// The model's ids for the phonemes `ipa`, between its start and end marks. Punctuation stands
/// apart from the words, as KittenTTS's tokenizer leaves it; symbols the model has no id for
/// are left out.
pub fn tokens(ipa: &str) -> Vec<i64> {
    let mut spaced = String::new();
    for c in ipa.chars() {
        if c.is_alphanumeric() || c == '_' || c.is_whitespace() {
            spaced.push(c);
        } else {
            spaced.extend([' ', c, ' ']);
        }
    }
    let ids = symbol_ids();
    let mut out = vec![START];
    let words = spaced.split_whitespace().collect::<Vec<_>>().join(" ");
    out.extend(words.chars().filter_map(|c| ids.get(&c).copied()));
    out.extend(END);
    out
}

/// English text to phonemes, as espeak-ng writes them for US English.
pub struct Phonemizer(G2P);

impl Phonemizer {
    pub fn new() -> Self {
        let mut g2p = G2P::with_fallback(Language::EnglishUS, Some(Box::new(Spell)));
        g2p.unk = String::new();
        Phonemizer(g2p)
    }

    pub fn ipa(&self, text: &str) -> String {
        let misaki = self.0.g2p(text).map(|(p, _)| p).unwrap_or_default();
        espeak(&misaki)
    }
}

/// Spells out a word no lexicon has, letter by letter (in Misaki's phonemes). Never fails:
/// Misaki gives up on the whole text when its fallback does.
struct Spell;

impl Fallback for Spell {
    fn phonemize(&self, word: &str) -> std::result::Result<String, FallbackError> {
        Ok(word.chars().filter_map(letter).collect())
    }
}

/// The name of the letter `c` in Misaki's phonemes.
fn letter(c: char) -> Option<&'static str> {
    Some(match c.to_ascii_lowercase() {
        'a' => "ˈA",
        'b' => "bˈi",
        'c' => "sˈi",
        'd' => "dˈi",
        'e' => "ˈi",
        'f' => "ˈɛf",
        'g' => "ʤˈi",
        'h' => "ˈAʧ",
        'i' => "ˈI",
        'j' => "ʤˈA",
        'k' => "kˈA",
        'l' => "ˈɛl",
        'm' => "ˈɛm",
        'n' => "ˈɛn",
        'o' => "ˈO",
        'p' => "pˈi",
        'q' => "kjˈu",
        'r' => "ˈɑɹ",
        's' => "ˈɛs",
        't' => "tˈi",
        'u' => "jˈu",
        'v' => "vˈi",
        'w' => "dˈʌbᵊljˌu",
        'x' => "ˈɛks",
        'y' => "wˈI",
        'z' => "zˈi",
        _ => return None,
    })
}

/// Vowels, Misaki's one-letter diphthongs among them.
const VOWELS: &str = "aeiouæɐɑɒɔəɘɚɛɜɞɤɨɪɵʉʊʌʏøœɶᵊAIWYOQ";

/// Misaki's US English phonemes as espeak-ng writes them: its one-letter diphthongs and
/// affricates in two letters, its flap `T` as `ɾ`, r-coloured vowels as `ɜː` and `ɚ`, and the
/// long vowels marked long except where an unstressed one ends a word (the `i` of "happy").
pub fn espeak(misaki: &str) -> String {
    misaki
        .split_inclusive(char::is_whitespace)
        .map(espeak_word)
        .collect()
}

fn espeak_word(word: &str) -> String {
    let chars = r_coloured(word);
    let sound = |c: &char| c.is_alphabetic() && !matches!(c, 'ˈ' | 'ˌ' | 'ː');
    let last = chars.iter().rposition(sound);
    let mut out = String::new();
    let mut stressed = false;
    for (i, &c) in chars.iter().enumerate() {
        match c {
            'A' => out.push_str("eɪ"),
            'I' => out.push_str("aɪ"),
            'W' => out.push_str("aʊ"),
            'Y' => out.push_str("ɔɪ"),
            'O' => out.push_str("oʊ"),
            'Q' => out.push_str("əʊ"),
            'ʤ' => out.push_str("dʒ"),
            'ʧ' => out.push_str("tʃ"),
            'T' => out.push('ɾ'),
            'ᵊ' => out.push('ə'),
            'ˈ' | 'ˌ' => {
                stressed = true;
                out.push(c);
            }
            c => out.push(c),
        }
        if VOWELS.contains(c) {
            if matches!(c, 'i' | 'u' | 'ɑ' | 'ɔ') && (stressed || Some(i) != last) {
                out.push('ː');
            }
            stressed = false;
        }
    }
    out
}

/// `word` with Misaki's `əɹ` and `ɜɹ` as espeak-ng's r-coloured `ɚ` and `ɜː`, keeping the `ɹ`
/// before a vowel ("camera" `kˈæmɚɹə`, "hurry" `hˈɜːɹi`).
fn r_coloured(word: &str) -> Vec<char> {
    let chars: Vec<char> = word.chars().collect();
    let mut out = Vec::with_capacity(chars.len());
    let mut i = 0;
    while i < chars.len() {
        let c = chars[i];
        if matches!(c, 'ə' | 'ɜ') && chars.get(i + 1) == Some(&'ɹ') {
            let next = chars[i + 2..].iter().find(|c| !matches!(c, 'ˈ' | 'ˌ'));
            let linking = next.is_some_and(|n| VOWELS.contains(*n));
            out.extend(if c == 'ə' {
                &['ɚ'][..]
            } else {
                &['ɜ', 'ː'][..]
            });
            if linking {
                out.push('ɹ');
            }
            i += 2;
        } else {
            out.push(c);
            i += 1;
        }
    }
    out
}

/// A voice: a style vector for each length of text in characters, the last for any longer.
pub struct Voice(Vec<[f32; STYLE]>);

impl Voice {
    /// The style to say a piece of `chars` characters in.
    pub fn style(&self, chars: usize) -> &[f32; STYLE] {
        &self.0[chars.min(self.0.len() - 1)]
    }
}

/// The voices in a NumPy `.npz` archive, by name.
pub fn read_voices(path: &Path) -> Result<HashMap<String, Voice>> {
    let damaged = |e: &dyn std::fmt::Display| Error::msg(format!("damaged voices file: {e}"));
    let mut archive = zip::ZipArchive::new(std::fs::File::open(path)?).map_err(|e| damaged(&e))?;
    let mut voices = HashMap::new();
    for i in 0..archive.len() {
        let mut entry = archive.by_index(i).map_err(|e| damaged(&e))?;
        let name = entry.name().map_err(|e| damaged(&e))?;
        let Some(name) = name.strip_suffix(".npy").map(str::to_string) else {
            continue;
        };
        let mut bytes = Vec::new();
        entry.read_to_end(&mut bytes)?;
        let voice = npy(&bytes).ok_or_else(|| damaged(&format!("{name} is no style table")))?;
        voices.insert(name, voice);
    }
    Ok(voices)
}

/// A version 1 `.npy` array of little-endian float32 rows of [`STYLE`].
fn npy(bytes: &[u8]) -> Option<Voice> {
    if bytes.get(..7)? != b"\x93NUMPY\x01" {
        return None;
    }
    let len = u16::from_le_bytes([*bytes.get(8)?, *bytes.get(9)?]) as usize;
    let header = std::str::from_utf8(bytes.get(10..10 + len)?).ok()?;
    let row = format!(", {STYLE})");
    if !header.contains("'<f4'")
        || !header.contains("'fortran_order': False")
        || !header.contains(&row)
    {
        return None;
    }
    let data = &bytes[10 + len..];
    if data.is_empty() || !data.len().is_multiple_of(STYLE * 4) {
        return None;
    }
    let rows = data.as_chunks::<{ STYLE * 4 }>().0.iter().map(|row| {
        let mut style = [0f32; STYLE];
        for (s, b) in style.iter_mut().zip(row.as_chunks::<4>().0) {
            *s = f32::from_le_bytes(*b);
        }
        style
    });
    Some(Voice(rows.collect()))
}

/// The model, its voices and the phonemizer, loaded.
pub struct Model {
    session: Session,
    voices: HashMap<String, Voice>,
    phonemizer: Phonemizer,
}

impl Model {
    /// Loads the model file `onnx` and the voices file `voices`.
    pub fn load(onnx: &Path, voices: &Path, threads: usize) -> Result<Self> {
        let failed = |e: ort::Error| Error::msg(format!("cannot load the voice model: {e}"));
        let environment = ort::init().with_name("narration").build().map_err(failed)?;
        let session = Session::builder(&environment)
            .map_err(failed)?
            .with_intra_threads(threads)
            .map_err(|e| failed(e.into()))?
            .commit_from_file(onnx)
            .map_err(failed)?;
        Ok(Model {
            session,
            voices: read_voices(voices)?,
            phonemizer: Phonemizer::new(),
        })
    }

    pub fn has_voice(&self, voice: &str) -> bool {
        self.voices.contains_key(voice)
    }

    /// The phoneme ids for `text`.
    pub fn tokens(&self, text: &str) -> Vec<i64> {
        tokens(&self.phonemizer.ipa(text))
    }

    /// `ids` (of `text`, at most [`MAX_TOKENS`]) said in `voice`, at 24 kHz.
    pub fn speak(&mut self, text: &str, ids: Vec<i64>, voice: &str) -> Result<Vec<f32>> {
        let style = self
            .voices
            .get(voice)
            .ok_or_else(|| Error::msg(format!("the voice model has no voice {voice:?}")))?
            .style(text.chars().count());
        let failed = |e: ort::Error| Error::msg(format!("the speech engine failed: {e}"));
        let inputs = ort::inputs! {
            "input_ids" => Tensor::from_array(([1, ids.len()], ids)).map_err(failed)?,
            "style" => Tensor::from_array(([1, STYLE], style.to_vec())).map_err(failed)?,
            "speed" => Tensor::from_array(([1], vec![1.0f32])).map_err(failed)?,
        };
        let outputs = self.session.run(inputs).map_err(failed)?;
        let (_, samples) = outputs["waveform"]
            .try_extract_tensor::<f32>()
            .map_err(failed)?;
        Ok(samples[..samples.len().saturating_sub(TAIL)].to_vec())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn symbols_have_kittens_ids() {
        let ids = symbol_ids();
        assert_eq!(ids[&'$'], 0);
        assert_eq!(ids[&';'], 1);
        assert_eq!(ids[&'…'], 10);
        assert_eq!(ids[&' '], 16);
        assert_eq!(ids[&'A'], 17);
        assert_eq!(ids[&'a'], 43);
        assert_eq!(ids[&'ɑ'], 69);
        // `"` and `'` are listed twice; the last id stands.
        assert_eq!(ids[&'"'], 15);
        assert_eq!(ids[&'ᵻ'], 177);
        assert_eq!(ids.len(), 175);
    }

    #[test]
    fn tokens_set_punctuation_apart_and_mark_both_ends() {
        let ids = symbol_ids();
        let id = |c| ids[&c];
        assert_eq!(
            tokens("hˈaɪ, ju."),
            [
                0,
                id('h'),
                id('ˈ'),
                id('a'),
                id('ɪ'),
                id(' '),
                id(','),
                id(' '),
                id('j'),
                id('u'),
                id(' '),
                id('.'),
                10,
                0
            ]
        );
        // Symbols the model doesn't know are left out.
        assert_eq!(tokens("aж"), tokens("a"));
        assert_eq!(tokens(""), [0, 10, 0]);
    }

    #[test]
    fn misaki_phonemes_are_written_as_espeak_writes_them() {
        // Each line as Misaki says it, and as espeak-ng does (which the model learned).
        for (misaki, espeak_ng) in [
            ("həlˈO, wˈɜɹld!", "həlˈoʊ, wˈɜːld!"),
            ("plˈiz ɹˈid", "plˈiːz ɹˈiːd"),
            ("jˈɛstəɹdˌA.", "jˈɛstɚdˌeɪ."),
            ("wˈɔTəɹ, bˈʌTəɹ", "wˈɔːɾɚ, bˈʌɾɚ"),
            ("ʤˈY, ʧˈYs", "dʒˈɔɪ, tʃˈɔɪs"),
            ("θɹˈu, ðˌO", "θɹˈuː, ðˌoʊ"),
            ("mˈɑdᵊl", "mˈɑːdəl"),
            ("pɹˈIsɪŋ ɡɹˈu", "pɹˈaɪsɪŋ ɡɹˈuː"),
            // Before a vowel the ɹ stays.
            ("kˈæməɹə ʤˈɛnəɹəl", "kˈæmɚɹə dʒˈɛnɚɹəl"),
            ("mˈɛməɹi hˈɪstəɹi", "mˈɛmɚɹi hˈɪstɚɹi"),
            ("hˈɜɹi", "hˈɜːɹi"),
            ("əɹˈWnd", "ɚɹˈaʊnd"),
            ("klˈɪɹəɹ fˈIəɹ", "klˈɪɹɚ fˈaɪɚ"),
        ] {
            assert_eq!(espeak(misaki), espeak_ng, "{misaki}");
        }
    }

    #[test]
    fn an_unstressed_vowel_ending_a_word_stays_short() {
        assert_eq!(espeak("ˈɛvɹi"), "ˈɛvɹi");
        assert_eq!(espeak("ˈɛvɹi."), "ˈɛvɹi.");
        // Stressed, or inside the word, it is long.
        assert_eq!(espeak("wˈi"), "wˈiː");
        assert_eq!(espeak("ɹˈid"), "ɹˈiːd");
    }

    #[test]
    fn english_text_becomes_espeak_phonemes() {
        let phonemizer = Phonemizer::new();
        assert_eq!(phonemizer.ipa("Hello, world!"), "həlˈoʊ, wˈɜːld!");
        assert_eq!(
            phonemizer.ipa("Please read the report."),
            "plˈiːz ɹˈiːd ðə ɹəpˈɔːɹt."
        );
    }

    #[test]
    fn a_word_in_no_lexicon_is_spelled_out() {
        assert_eq!(Spell.phonemize("Qzx").unwrap(), "kjˈuzˈiˈɛks");
        // Nothing to spell is no failure: Misaki would drop the whole text.
        assert_eq!(Spell.phonemize("—").unwrap(), "");
        let ipa = Phonemizer::new().ipa("Say qzxwv.");
        assert!(ipa.starts_with("sˈeɪ "), "{ipa}");
        assert!(ipa.contains("kjˈuː"), "{ipa}");
    }

    fn npy_bytes(rows: usize, shape: &str) -> Vec<u8> {
        let mut header = format!("{{'descr': '<f4', 'fortran_order': False, 'shape': {shape}, }}");
        while (10 + header.len() + 1) % 64 != 0 {
            header.push(' ');
        }
        header.push('\n');
        let mut bytes = b"\x93NUMPY\x01\x00".to_vec();
        bytes.extend((header.len() as u16).to_le_bytes());
        bytes.extend(header.as_bytes());
        for i in 0..rows * STYLE {
            bytes.extend((i as f32).to_le_bytes());
        }
        bytes
    }

    #[test]
    fn reads_style_tables_and_picks_a_row_by_length() {
        let voice = npy(&npy_bytes(3, "(3, 256)")).unwrap();
        assert_eq!(voice.style(0)[0], 0.0);
        assert_eq!(voice.style(1)[1], 257.0);
        // Longer text than the table has rows takes its last.
        assert_eq!(voice.style(99)[0], 512.0);
        assert!(npy(&npy_bytes(3, "(3, 128)")).is_none());
        assert!(npy(&npy_bytes(0, "(0, 256)")).is_none());
        assert!(npy(b"\x93NUMPY").is_none());
        let mut truncated = npy_bytes(2, "(2, 256)");
        truncated.pop();
        assert!(npy(&truncated).is_none());
    }

    #[test]
    fn reads_the_voices_archive() {
        use std::io::Write;
        let dir = std::env::temp_dir().join(format!("slopslide-voices-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("voices.npz");
        let mut zip = zip::ZipWriter::new(std::fs::File::create(&path).unwrap());
        let options = zip::write::SimpleFileOptions::default();
        zip.start_file("expr-voice-2-m.npy", options).unwrap();
        zip.write_all(&npy_bytes(2, "(2, 256)")).unwrap();
        zip.start_file("readme.txt", options).unwrap();
        zip.finish().unwrap();
        let voices = read_voices(&path).unwrap();
        assert_eq!(voices.keys().collect::<Vec<_>>(), ["expr-voice-2-m"]);
        std::fs::write(&path, b"not a zip").unwrap();
        assert!(read_voices(&path).is_err());
        std::fs::remove_dir_all(dir).unwrap();
    }
}
