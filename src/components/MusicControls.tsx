import { open } from "@tauri-apps/plugin-dialog";
import { Music, Play, Square, Trash2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { type Deck, type DeckMusic, errorMessage, MUSIC_EXTENSIONS } from "../lib/api";
import { basename, deckFileUrl } from "../lib/utils";
import { useApp } from "../store";

/** How long the volume slider rests before the volume is saved to the deck. */
export const MUSIC_VOLUME_SAVE_DELAY = 300;

const button =
  "flex items-center gap-1 rounded-md border px-2 py-1 text-xs font-medium hover:bg-accent [&_svg]:size-3.5";

/** The deck's background music: which file loops under the show, how loud, and a way to hear it. */
export function MusicControls({ deck }: { deck: Deck }) {
  const pick = async () => {
    try {
      const path = await open({
        title: "Choose background music",
        filters: [{ name: "Audio", extensions: MUSIC_EXTENSIONS }],
      });
      if (typeof path === "string") await useApp.getState().setMusic(path);
    } catch (error) {
      useApp.getState().setError(`Could not add the music: ${errorMessage(error)}`);
    }
  };
  return (
    <div className="mt-auto flex flex-col gap-2 border-t p-3 text-xs">
      <div className="flex items-center justify-between gap-2">
        <span className="flex min-w-0 items-center gap-1 text-muted-foreground">
          <Music className="size-3.5 shrink-0" />
          <span className="truncate" title={deck.music?.file}>
            {deck.music ? basename(deck.music.file) : "No background music"}
          </span>
        </span>
        {!deck.music && (
          <button type="button" className={button} onClick={() => void pick()}>
            Add music…
          </button>
        )}
      </div>
      {/* One player per file: picking another stops the one playing. */}
      {deck.music && <MusicPlayer key={deck.music.file} deckId={deck.id} music={deck.music} onReplace={pick} />}
    </div>
  );
}

function MusicPlayer(props: { deckId: string; music: DeckMusic; onReplace: () => Promise<void> }) {
  const { deckId, music } = props;
  const [volume, setVolume] = useState(music.volume);
  const [playing, setPlaying] = useState(false);
  const audio = useRef<HTMLAudioElement | null>(null);
  const saving = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Changed elsewhere (the agent, the HTML view), unless the slider is being moved.
  useEffect(() => {
    if (saving.current === null) setVolume(music.volume);
  }, [music.volume]);

  useEffect(
    () => () => {
      audio.current?.pause();
      if (saving.current !== null) clearTimeout(saving.current);
    },
    [],
  );

  const change = (value: number) => {
    setVolume(value);
    if (audio.current) audio.current.volume = value / 100;
    if (saving.current !== null) clearTimeout(saving.current);
    saving.current = setTimeout(() => {
      saving.current = null;
      void useApp.getState().setMusicVolume(value);
    }, MUSIC_VOLUME_SAVE_DELAY);
  };

  const toggle = async () => {
    if (audio.current) {
      audio.current.pause();
      audio.current = null;
      setPlaying(false);
      return;
    }
    const player = new Audio(deckFileUrl(deckId, music.file));
    player.loop = true;
    player.volume = volume / 100;
    audio.current = player;
    setPlaying(true);
    try {
      await player.play();
    } catch (error) {
      if (audio.current === player) audio.current = null;
      setPlaying(false);
      useApp.getState().setError(`Could not play the music: ${errorMessage(error)}`);
    }
  };

  return (
    <>
      <label className="flex items-center gap-2">
        <span className="text-muted-foreground">Volume</span>
        <input
          type="range"
          aria-label="Music volume"
          min={0}
          max={100}
          value={volume}
          onChange={(event) => change(Number(event.target.value))}
          className="min-w-0 flex-1"
        />
        <span className="w-8 text-right tabular-nums">{volume}%</span>
      </label>
      <div className="flex justify-end gap-1">
        <button type="button" className={button} onClick={() => void toggle()}>
          {playing ? <Square /> : <Play />}
          {playing ? "Stop" : "Play"}
        </button>
        <button type="button" className={button} onClick={() => void props.onReplace()}>
          Replace…
        </button>
        <button
          type="button"
          className={button}
          aria-label="Remove music"
          title="Remove the music"
          onClick={() => void useApp.getState().removeMusic()}
        >
          <Trash2 />
        </button>
      </div>
    </>
  );
}
