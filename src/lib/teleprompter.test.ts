import { describe, expect, it } from "vitest";

import { follow, pieces, type Script, startTrack, type Track, toScript } from "./teleprompter";

const SCRIPT =
  "Welcome everyone to the quarterly results. Revenue grew strongly in every region this year, " +
  "driven by demand for our cloud platform. Costs stayed flat because the migration finished " +
  "early. Looking forward, we expect hiring to accelerate across engineering and support. " +
  "Finally, thank you to the customers who trusted us during a difficult transition.";

const script = toScript(SCRIPT);
const hear = (track: Track, ...heard: string[]) => heard.reduce((t, words) => follow(script, t, words), track);

function saidText(from: Script, track: Track) {
  return pieces(from, track)
    .map((p) => (p.said ? p.text : "|"))
    .join("")
    .replace(/^\||\|$/g, "")
    .replace(/\|/g, " | ");
}

/** The word index just after `phrase`. */
function endOf(phrase: string) {
  return toScript(SCRIPT.slice(0, SCRIPT.indexOf(phrase) + phrase.length)).words.length;
}

describe("follow", () => {
  it("follows the speaker reading along, window by window", () => {
    const track = hear(
      startTrack(script),
      "welcome everyone to the quarterly",
      "welcome everyone to the quarterly results revenue grew",
      "to the quarterly results revenue grew strongly in every region",
    );
    expect(track.position).toBe(endOf("in every region"));
    expect(saidText(script, track)).toBe(
      "Welcome everyone to the quarterly results. Revenue grew strongly in every region",
    );
  });

  it("copes with paraphrase and misheard words", () => {
    const track = hear(
      startTrack(script),
      "welcome all to our quarterly result so revenue has grown strongly in each region",
    );
    expect(track.position).toBe(endOf("in every region"));
  });

  it("does not care about case, punctuation or accents", () => {
    const accented = toScript("Der Café öffnet früh, und die Gäste kommen.");
    const track = follow(accented, startTrack(accented), "der cafe offnet fruh und die gaste kommen");
    expect(track.position).toBe(accented.words.length);
  });

  it("fills in words recognition missed while reading on", () => {
    const track = hear(startTrack(script), "welcome everyone to the quarterly results", "revenue grew strongly");
    const skipped = hear(track, "strongly in every region this year driven by");
    expect(skipped.said.slice(0, skipped.position).every(Boolean)).toBe(true);
  });

  it("finds the speaker after a jump forward, leaving what they skipped unsaid", () => {
    const start = hear(startTrack(script), "welcome everyone to the quarterly results");
    const track = hear(
      start,
      "finally thank you to the customers who trusted",
      "thank you to the customers who trusted us",
    );
    expect(track.position).toBe(endOf("who trusted us"));
    expect(saidText(script, track)).toBe(
      "Welcome everyone to the quarterly results | Finally, thank you to the customers who trusted us",
    );
  });

  it("finds the speaker after a jump back, keeping what they said", () => {
    const start = hear(startTrack(script), "finally thank you to the customers who trusted us");
    const track = hear(start, "costs stayed flat because the migration finished early");
    expect(track.position).toBe(endOf("finished early"));
    expect(track.said[endOf("who trusted us") - 1]).toBe(true);
  });

  it("goes by the latest words after a jump, not the ones still in the window", () => {
    const start = hear(startTrack(script), "welcome everyone to the quarterly results");
    const track = hear(
      start,
      "the quarterly results um let me skip ahead we expect hiring to accelerate across engineering",
    );
    expect(track.position).toBe(endOf("across engineering"));
  });

  it("is not carried along by a stray word after an aside", () => {
    const start = hear(startTrack(script), "driven by demand for our cloud platform");
    const track = hear(start, "our cloud platform now let me skip ahead here to the");
    expect(track).toBe(start);
  });

  it("stays put when the speaker goes off script", () => {
    const start = hear(startTrack(script), "welcome everyone to the quarterly results");
    expect(hear(start, "sorry can someone close that door please")).toBe(start);
    expect(hear(start, "")).toBe(start);
  });

  it("does not jump for a word or two that happen to be elsewhere", () => {
    const start = hear(startTrack(script), "welcome everyone to the quarterly results");
    expect(hear(start, "my customers")).toBe(start);
  });

  it("gives back the same track when the same words are heard again", () => {
    const start = hear(startTrack(script), "welcome everyone to the quarterly results");
    expect(hear(start, "welcome everyone to the quarterly results")).toBe(start);
  });

  it("does not slip back while the same words are still being heard", () => {
    const start = hear(startTrack(script), "welcome everyone to the quarterly results revenue grew strongly");
    expect(hear(start, "to the quarterly results revenue").position).toBe(start.position);
  });

  it("prefers the nearest copy of a repeated phrase", () => {
    const repeated = toScript(
      "Our customers love the product. Then many unrelated words fill this long stretch of text here today. " +
        "Our customers love the product. Then the same thing comes again at the very end of everything.",
    );
    const second = repeated.text.lastIndexOf("Our customers");
    const near = toScript(repeated.text.slice(0, second)).words.length;
    const track = follow(
      repeated,
      { position: near, said: startTrack(repeated).said },
      "our customers love the product",
    );
    expect(track.position).toBe(near + 5);
  });

  it("follows languages written without spaces", () => {
    const japanese = toScript("皆さんこんにちは。今日は四半期の結果についてお話しします。");
    const track = follow(japanese, startTrack(japanese), "皆さんこんにちは今日は四半期の結果について");
    expect(track.position).toBeGreaterThan(5);
  });

  it("has nothing to follow in an empty script", () => {
    const empty = toScript("  ");
    const track = startTrack(empty);
    expect(follow(empty, track, "hello there")).toBe(track);
  });
});

describe("following a real talk", () => {
  // What Whisper heard, a pass a second, of the script spoken with a paraphrase, a jump to the
  // end, and a jump back.
  const passes = [
    "Welcome everyone to",
    "Welcome everyone to the quarterly results.",
    "Welcome everyone to the quarterly results. Revenue",
    "Welcome everyone to the quarterly results. Revenue grew strongly in each",
    "Welcome everyone to the quarterly results. Revenue grew strongly in each region this year.",
    "Welcome everyone to the quarterly results. Revenue grew strongly in each region this year, driven by demand",
    "the quarterly results. Revenue grew strongly in each region this year, driven by demand for our cloud platform.",
    "revenue grew strongly in each region this year, driven by demand for our cloud platform. Now let's",
    "grew strongly in each region this year, driven by demand for our cloud platform. Now let me skip ahead.",
    "region this year, driven by demand for our cloud platform. Now let me skip ahead. Finally,",
    "Driven by demand for our cloud platform. Now let me skip ahead. Finally, thank you to the customers who",
    "for our cloud platform. Now let me skip ahead. Finally, thank you to the customers who trusted us during",
    "Now let me skip ahead. Finally, thank you to the customers who trusted us during a difficult transition.",
    "Finally, thank you to the customers who trusted us during a difficult transition.",
    "Finally, thank you to the customers who trusted us during a difficult transition. Actually, let me go",
    "Thank you to the customers who trusted us during a difficult transition. Actually, let me go back for a moment.",
    "who trusted us during a difficult transition. Actually, let me go back for a moment.",
    "a difficult transition. Actually, let me go back for a moment. Costs stayed flat because the migratory",
  ];

  it("keeps up, jumps both ways and leaves what was skipped unsaid", () => {
    const seen = passes.reduce<Track[]>((tracks, heard) => {
      const last = tracks[tracks.length - 1] ?? startTrack(script);
      return [...tracks, follow(script, last, heard)];
    }, []);
    expect(seen[1]!.position).toBe(endOf("quarterly results"));
    expect(seen[6]!.position).toBe(endOf("our cloud platform"));
    expect(seen[12]!.position).toBe(endOf("a difficult transition"));
    // Whisper made "migratory" of the last word.
    expect(seen[17]!.position).toBe(endOf("flat because the"));
    expect(saidText(script, seen[17]!)).toBe(
      "Welcome everyone to the quarterly results. Revenue grew strongly in every region this year, driven by demand for our cloud platform. Costs stayed flat because the | Finally, thank you to the customers who trusted us during a difficult transition",
    );
  });
});

describe("pieces", () => {
  it("keeps the text exactly as written", () => {
    const multiline = toScript("  First line,\n\n  second — line!  ");
    const track = follow(multiline, startTrack(multiline), "first line second line");
    expect(
      pieces(multiline, track)
        .map((p) => p.text)
        .join(""),
    ).toBe(multiline.text);
  });

  it("shows nothing as said at the start", () => {
    expect(pieces(script, startTrack(script))).toEqual([{ text: SCRIPT, said: false, current: false }]);
  });

  it("runs the highlight across spaces, and picks out the last word", () => {
    const short = toScript("One two three four five.");
    const track: Track = { position: 3, said: [true, true, true, false, false] };
    expect(pieces(short, track)).toEqual([
      { text: "One two ", said: true, current: false },
      { text: "three", said: true, current: true },
      { text: " four five.", said: false, current: false },
    ]);
  });
});
