# Spoken words example deck

Every word of the narration appears on the slide the moment the voice says it.

Open deck.html in SlopSlide, press Present and play the show (or export a video with
narration). Its audio in `narration/` was spoken by the voice model and its words timed
("Time words" in the Narration panel), so `narration/manifest.json` lists each slide's
words with their `start` and `end` in seconds into the slide's audio.

- welcome, how, end: each word of a `.said` paragraph is a `<span class="w">` whose `--at`
  is when it is said, so its colour animates in then.
- why: each card's `--at` is when its keyword ("Pace", "Focus", "Polish") is said.

`--at` is the slide's `data-narration-start` (0.5 s) plus the word's `start`; each slide's
`data-duration` is that plus its audio's length plus a short pause. Changing a slide's
narration makes its audio and timings out of date: generate the audio and time its words
again, then ask the agent to re-time the slide to its words.
