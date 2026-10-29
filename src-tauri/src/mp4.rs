//! A minimal MP4 (ISO base media file) writer for one AV1 video track and, optionally, one
//! Opus audio track, as video.rs makes them.
//!
//! Samples are written into `mdat` as they come; the index (`moov`) follows them at the end,
//! when every sample's size, place and duration is known. Each video sample may last any
//! number of track time units, so a frame held on screen is stored once.
//! (ISO/IEC 14496-12, the AV1 binding: <https://aomediacodec.github.io/av1-isobmff/>, and the
//! Opus binding: <https://opus-codec.org/docs/opus_in_isobmff.html>.)

use std::io::{self, Seek, SeekFrom, Write};

/// The movie's time units per second, for the overall duration.
const MOVIE_TIMESCALE: u32 = 1000;
/// The identity transform of `mvhd` and `tkhd`.
const MATRIX: [u32; 9] = [0x0001_0000, 0, 0, 0, 0x0001_0000, 0, 0, 0, 0x4000_0000];

/// A written sample, for the index.
struct Sample {
    offset: u64,
    size: u32,
    duration: u32,
    sync: bool,
}

/// An Opus audio track: its packets, each [`AudioTrack::PACKET`] samples at 48 kHz.
pub struct AudioTrack {
    pub packets: Vec<Vec<u8>>,
    /// Samples the decoder drops from the start (the encoder's lookahead).
    pub pre_skip: u16,
    /// The sample rate the audio had before it was encoded.
    pub input_rate: u32,
    /// How many samples (at [`AudioTrack::RATE`]) play: the packets less the pre-skip and
    /// the padding of the last packet.
    pub length: u64,
}

impl AudioTrack {
    /// Opus decodes at 48 kHz.
    pub const RATE: u32 = 48_000;
    /// Samples in each packet: 20 ms.
    pub const PACKET: u32 = 960;
}

/// The audio track's packets, as written.
struct Audio {
    samples: Vec<Sample>,
    pre_skip: u16,
    input_rate: u32,
    length: u64,
}

pub struct Mp4Writer<W: Write + Seek> {
    out: W,
    width: u32,
    height: u32,
    /// The track's time units per second.
    timescale: u32,
    /// The AV1 codec configuration record (`av1C`).
    config: Vec<u8>,
    /// Where `mdat` starts, to write its size at the end.
    mdat: u64,
    samples: Vec<Sample>,
    audio: Option<Audio>,
}

impl<W: Write + Seek> Mp4Writer<W> {
    /// Starts a file of `width` × `height` AV1 video, with `config` its `av1C` record.
    pub fn start(
        mut out: W,
        (width, height): (u32, u32),
        timescale: u32,
        config: Vec<u8>,
    ) -> io::Result<Self> {
        let mut ftyp = Vec::new();
        ftyp.extend_from_slice(b"isom");
        put32(&mut ftyp, 0x200);
        for brand in [b"isom", b"iso6", b"av01", b"mp41"] {
            ftyp.extend_from_slice(brand);
        }
        out.write_all(&boxed(b"ftyp", &ftyp))?;
        let mdat = out.stream_position()?;
        // A 64-bit size, filled in at the end: 1, the type, then the real size.
        out.write_all(&1u32.to_be_bytes())?;
        out.write_all(b"mdat")?;
        out.write_all(&0u64.to_be_bytes())?;
        Ok(Mp4Writer {
            out,
            width,
            height,
            timescale,
            config,
            mdat,
            samples: Vec::new(),
            audio: None,
        })
    }

    /// Adds one frame, shown for `duration` track time units; `sync` if it is a keyframe.
    pub fn write_sample(&mut self, data: &[u8], duration: u32, sync: bool) -> io::Result<()> {
        let offset = self.out.stream_position()?;
        self.out.write_all(data)?;
        self.samples.push(Sample {
            offset,
            size: u32::try_from(data.len())
                .map_err(|_| io::Error::other("a video frame is too large"))?,
            duration,
            sync,
        });
        Ok(())
    }

    /// Adds the audio track, its packets written after the video so far.
    pub fn write_audio(&mut self, track: &AudioTrack) -> io::Result<()> {
        let mut samples = Vec::with_capacity(track.packets.len());
        for packet in &track.packets {
            samples.push(Sample {
                offset: self.out.stream_position()?,
                size: packet.len() as u32,
                duration: AudioTrack::PACKET,
                sync: true,
            });
            self.out.write_all(packet)?;
        }
        self.audio = Some(Audio {
            samples,
            pre_skip: track.pre_skip,
            input_rate: track.input_rate,
            length: track.length,
        });
        Ok(())
    }

    /// Writes the index and gives back the output.
    pub fn finish(mut self) -> io::Result<W> {
        let end = self.out.stream_position()?;
        self.out.seek(SeekFrom::Start(self.mdat + 8))?;
        self.out.write_all(&(end - self.mdat).to_be_bytes())?;
        self.out.seek(SeekFrom::Start(end))?;
        let moov = self.moov();
        self.out.write_all(&moov)?;
        self.out.flush()?;
        Ok(self.out)
    }

    /// The video track's length in its own time units.
    fn duration(&self) -> u64 {
        self.samples.iter().map(|s| u64::from(s.duration)).sum()
    }

    fn moov(&self) -> Vec<u8> {
        let movie = |duration: u64, timescale: u32| {
            u32::try_from(duration * u64::from(MOVIE_TIMESCALE) / u64::from(timescale.max(1)))
                .unwrap_or(u32::MAX)
        };
        let video_duration = movie(self.duration(), self.timescale);
        let audio_duration = self
            .audio
            .as_ref()
            .map(|a| movie(a.length, AudioTrack::RATE));
        let movie_duration = video_duration.max(audio_duration.unwrap_or(0));

        let mut mvhd = vec![0; 8]; // version 0, created and modified at 0
        put32(&mut mvhd, MOVIE_TIMESCALE);
        put32(&mut mvhd, movie_duration);
        put32(&mut mvhd, 0x0001_0000); // rate 1.0
        put16(&mut mvhd, 0x0100); // volume 1.0
        mvhd.extend_from_slice(&[0; 10]);
        MATRIX.iter().for_each(|v| put32(&mut mvhd, *v));
        mvhd.extend_from_slice(&[0; 24]);
        put32(&mut mvhd, if self.audio.is_some() { 3 } else { 2 }); // next track id

        let mut tkhd = vec![0; 8];
        put32(&mut tkhd, 1); // track id
        put32(&mut tkhd, 0);
        put32(&mut tkhd, video_duration);
        tkhd.extend_from_slice(&[0; 16]); // reserved, layer, group, volume, reserved
        MATRIX.iter().for_each(|v| put32(&mut tkhd, *v));
        put32(&mut tkhd, self.width << 16);
        put32(&mut tkhd, self.height << 16);

        let minf = boxed(
            b"minf",
            &[
                full(b"vmhd", 0, 1, &[0; 8]),
                dinf(),
                boxed(b"stbl", &self.stbl()),
            ]
            .concat(),
        );
        let mdia = boxed(
            b"mdia",
            &[
                mdhd(self.timescale, self.duration()),
                hdlr(b"vide", b"VideoHandler"),
                minf,
            ]
            .concat(),
        );
        let trak = boxed(b"trak", &[full(b"tkhd", 0, 3, &tkhd), mdia].concat());
        let mut moov = [full(b"mvhd", 0, 0, &mvhd), trak].concat();
        if let (Some(audio), Some(duration)) = (&self.audio, audio_duration) {
            moov.extend_from_slice(&audio_trak(audio, duration));
        }
        boxed(b"moov", &moov)
    }

    fn stbl(&self) -> Vec<u8> {
        let mut entry = vec![0; 6];
        put16(&mut entry, 1); // data reference index
        entry.extend_from_slice(&[0; 16]);
        put16(&mut entry, self.width as u16);
        put16(&mut entry, self.height as u16);
        put32(&mut entry, 0x0048_0000); // 72 dpi
        put32(&mut entry, 0x0048_0000);
        put32(&mut entry, 0);
        put16(&mut entry, 1); // frames per sample
        entry.extend_from_slice(&[0; 32]); // compressor name
        put16(&mut entry, 0x0018); // depth
        put16(&mut entry, 0xffff);
        entry.extend_from_slice(&boxed(b"av1C", &self.config));
        // BT.709 colours in video (limited) range, as video.rs converts them.
        entry.extend_from_slice(&boxed(
            b"colr",
            &[b'n', b'c', b'l', b'x', 0, 1, 0, 1, 0, 1, 0],
        ));
        let mut stsd = Vec::new();
        put32(&mut stsd, 1);
        stsd.extend_from_slice(&boxed(b"av01", &entry));

        let keys: Vec<u32> = (1..)
            .zip(&self.samples)
            .filter(|(_, s)| s.sync)
            .map(|(n, _)| n)
            .collect();
        let mut stss = Vec::new();
        put32(&mut stss, keys.len() as u32);
        keys.iter().for_each(|n| put32(&mut stss, *n));

        [
            full(b"stsd", 0, 0, &stsd),
            stts(&self.samples),
            full(b"stss", 0, 0, &stss),
            sample_tables(&self.samples),
        ]
        .concat()
    }
}

/// The audio track's `trak`, `duration` long in the movie's time units.
fn audio_trak(audio: &Audio, duration: u32) -> Vec<u8> {
    let samples: u64 = audio.samples.iter().map(|s| u64::from(s.duration)).sum();
    let mut tkhd = vec![0; 8];
    put32(&mut tkhd, 2); // track id
    put32(&mut tkhd, 0);
    put32(&mut tkhd, duration);
    tkhd.extend_from_slice(&[0; 8]); // reserved
    put16(&mut tkhd, 0); // layer
    put16(&mut tkhd, 1); // alternate group
    put16(&mut tkhd, 0x0100); // volume 1.0
    put16(&mut tkhd, 0);
    MATRIX.iter().for_each(|v| put32(&mut tkhd, *v));
    put32(&mut tkhd, 0); // no width or height
    put32(&mut tkhd, 0);

    // Playback starts after the pre-skip, so the audio lines up with the video.
    let mut elst = Vec::new();
    put32(&mut elst, 1);
    put32(&mut elst, duration);
    put32(&mut elst, u32::from(audio.pre_skip));
    put32(&mut elst, 0x0001_0000); // rate 1.0
    let edts = boxed(b"edts", &full(b"elst", 0, 0, &elst));

    let mut dops = vec![0, 1]; // version, one channel
    put16(&mut dops, audio.pre_skip);
    put32(&mut dops, audio.input_rate);
    put16(&mut dops, 0); // output gain
    dops.push(0); // channel mapping family: mono or stereo
    let mut entry = vec![0; 6];
    put16(&mut entry, 1); // data reference index
    entry.extend_from_slice(&[0; 8]);
    put16(&mut entry, 1); // channels
    put16(&mut entry, 16); // sample size
    put32(&mut entry, 0);
    put32(&mut entry, AudioTrack::RATE << 16);
    entry.extend_from_slice(&boxed(b"dOps", &dops));
    let mut stsd = Vec::new();
    put32(&mut stsd, 1);
    stsd.extend_from_slice(&boxed(b"Opus", &entry));

    let stbl = boxed(
        b"stbl",
        &[
            full(b"stsd", 0, 0, &stsd),
            stts(&audio.samples),
            sample_tables(&audio.samples),
        ]
        .concat(),
    );
    let minf = boxed(
        b"minf",
        &[full(b"smhd", 0, 0, &[0; 4]), dinf(), stbl].concat(),
    );
    let mdia = boxed(
        b"mdia",
        &[
            mdhd(AudioTrack::RATE, samples),
            hdlr(b"soun", b"SoundHandler"),
            minf,
        ]
        .concat(),
    );
    boxed(b"trak", &[full(b"tkhd", 0, 3, &tkhd), edts, mdia].concat())
}

/// A track's `mdhd`: its time units per second and its length in them.
fn mdhd(timescale: u32, duration: u64) -> Vec<u8> {
    let mut mdhd = vec![0; 16]; // version 1: 64-bit times, so long videos fit
    put32(&mut mdhd, timescale);
    put64(&mut mdhd, duration);
    put16(&mut mdhd, 0x55c4); // "und"
    put16(&mut mdhd, 0);
    full(b"mdhd", 1, 0, &mdhd)
}

fn hdlr(kind: &[u8; 4], name: &[u8]) -> Vec<u8> {
    let mut hdlr = vec![0; 4];
    hdlr.extend_from_slice(kind);
    hdlr.extend_from_slice(&[0; 12]);
    hdlr.extend_from_slice(name);
    hdlr.push(0);
    full(b"hdlr", 0, 0, &hdlr)
}

/// Says the media is in this file.
fn dinf() -> Vec<u8> {
    let url = full(b"url ", 0, 1, &[]);
    let mut dref = Vec::new();
    put32(&mut dref, 1);
    dref.extend_from_slice(&url);
    boxed(b"dinf", &full(b"dref", 0, 0, &dref))
}

/// The `stts` of `samples`: runs of samples that last as long as each other.
fn stts(samples: &[Sample]) -> Vec<u8> {
    let mut runs: Vec<(u32, u32)> = Vec::new();
    for s in samples {
        match runs.last_mut() {
            Some((count, duration)) if *duration == s.duration => *count += 1,
            _ => runs.push((1, s.duration)),
        }
    }
    let mut stts = Vec::new();
    put32(&mut stts, runs.len() as u32);
    runs.iter().for_each(|(count, duration)| {
        put32(&mut stts, *count);
        put32(&mut stts, *duration);
    });
    full(b"stts", 0, 0, &stts)
}

/// The `stsc`, `stsz` and `co64` of `samples`: each sample is a chunk of its own.
fn sample_tables(samples: &[Sample]) -> Vec<u8> {
    let mut stsc = Vec::new();
    [1, 1, 1, 1].iter().for_each(|v| put32(&mut stsc, *v));

    let count = samples.len() as u32;
    let mut stsz = vec![0; 4];
    put32(&mut stsz, count);
    samples.iter().for_each(|s| put32(&mut stsz, s.size));

    let mut co64 = Vec::new();
    put32(&mut co64, count);
    samples.iter().for_each(|s| put64(&mut co64, s.offset));

    [
        full(b"stsc", 0, 0, &stsc),
        full(b"stsz", 0, 0, &stsz),
        full(b"co64", 0, 0, &co64),
    ]
    .concat()
}

fn put16(out: &mut Vec<u8>, v: u16) {
    out.extend_from_slice(&v.to_be_bytes());
}

fn put32(out: &mut Vec<u8>, v: u32) {
    out.extend_from_slice(&v.to_be_bytes());
}

fn put64(out: &mut Vec<u8>, v: u64) {
    out.extend_from_slice(&v.to_be_bytes());
}

/// A box: its size, its type, then `body`.
fn boxed(kind: &[u8; 4], body: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(body.len() + 8);
    put32(&mut out, (body.len() + 8) as u32);
    out.extend_from_slice(kind);
    out.extend_from_slice(body);
    out
}

/// A full box: a box whose body starts with a version and 24 bits of flags.
fn full(kind: &[u8; 4], version: u8, flags: u32, body: &[u8]) -> Vec<u8> {
    let mut head = vec![version];
    head.extend_from_slice(&flags.to_be_bytes()[1..]);
    boxed(kind, &[head, body.to_vec()].concat())
}

/// Reads back what video tests need to know about a file this module wrote.
#[cfg(test)]
pub mod read {
    /// One video track's index, as written.
    #[derive(Debug, PartialEq)]
    pub struct Track {
        pub width: u32,
        pub height: u32,
        pub timescale: u32,
        pub config: Vec<u8>,
        /// Each sample's duration, in track time units.
        pub durations: Vec<u32>,
        /// The keyframes, numbered from 1.
        pub keys: Vec<u32>,
        pub samples: Vec<Vec<u8>>,
    }

    /// The boxes in `data`: (type, body).
    pub fn boxes(data: &[u8]) -> Vec<([u8; 4], &[u8])> {
        let mut out = Vec::new();
        let mut at = 0;
        while at + 8 <= data.len() {
            let size32 = u32::from_be_bytes(data[at..at + 4].try_into().unwrap()) as usize;
            let kind: [u8; 4] = data[at + 4..at + 8].try_into().unwrap();
            let (head, size) = match size32 {
                1 => (
                    16,
                    u64::from_be_bytes(data[at + 8..at + 16].try_into().unwrap()) as usize,
                ),
                n => (8, n),
            };
            out.push((kind, &data[at + head..at + size]));
            at += size;
        }
        out
    }

    fn find<'a>(data: &'a [u8], path: &[&[u8; 4]]) -> &'a [u8] {
        let mut body = data;
        for (i, kind) in path.iter().enumerate() {
            body = boxes(body)
                .into_iter()
                .find(|(k, _)| k == *kind)
                .unwrap_or_else(|| {
                    panic!(
                        "no {:?}",
                        path[..=i]
                            .iter()
                            .map(|k| String::from_utf8_lossy(&k[..]).into_owned())
                            .collect::<Vec<_>>()
                    )
                })
                .1;
        }
        body
    }

    fn u32_at(data: &[u8], at: usize) -> u32 {
        u32::from_be_bytes(data[at..at + 4].try_into().unwrap())
    }

    fn table(body: &[u8], skip: usize, width: usize) -> Vec<&[u8]> {
        let n = u32_at(body, 4 + skip) as usize;
        (0..n)
            .map(|i| &body[8 + skip + i * width..8 + skip + (i + 1) * width])
            .collect()
    }

    /// The Opus audio track's index, as written.
    #[derive(Debug, PartialEq)]
    pub struct Audio {
        pub timescale: u32,
        pub pre_skip: u16,
        pub input_rate: u32,
        /// The edit list's (duration in movie time units, media start in track time units).
        pub edit: (u32, u32),
        pub durations: Vec<u32>,
        pub samples: Vec<Vec<u8>>,
        /// The movie's duration and next track id, from `mvhd`.
        pub movie: (u32, u32),
    }

    /// The file's second track, its audio.
    pub fn audio(file: &[u8]) -> Audio {
        let moov = find(file, &[b"moov"]);
        let trak = boxes(moov)
            .into_iter()
            .filter(|(k, _)| k == b"trak")
            .nth(1)
            .expect("an audio track")
            .1;
        let stbl = find(trak, &[b"mdia", b"minf", b"stbl"]);
        assert_eq!(&find(trak, &[b"mdia", b"hdlr"])[8..12], b"soun");
        let entry = find(&find(stbl, &[b"stsd"])[8..], &[b"Opus"]);
        let dops = find(&entry[28..], &[b"dOps"]);
        let elst = find(trak, &[b"edts", b"elst"]);
        let mdhd = find(trak, &[b"mdia", b"mdhd"]);
        let mvhd = find(moov, &[b"mvhd"]);
        let durations = table(find(stbl, &[b"stts"]), 0, 8)
            .iter()
            .flat_map(|e| std::iter::repeat_n(u32_at(e, 4), u32_at(e, 0) as usize))
            .collect();
        Audio {
            timescale: u32_at(mdhd, 20),
            pre_skip: u16::from_be_bytes(dops[2..4].try_into().unwrap()),
            input_rate: u32_at(dops, 4),
            edit: (u32_at(elst, 8), u32_at(elst, 12)),
            durations,
            samples: samples(file, stbl),
            movie: (u32_at(mvhd, 16), u32_at(mvhd, 96)),
        }
    }

    fn samples(file: &[u8], stbl: &[u8]) -> Vec<Vec<u8>> {
        let sizes = table(find(stbl, &[b"stsz"]), 4, 4);
        let offsets = table(find(stbl, &[b"co64"]), 0, 8);
        sizes
            .iter()
            .zip(offsets)
            .map(|(size, offset)| {
                let at = u64::from_be_bytes(offset.try_into().unwrap()) as usize;
                file[at..at + u32_at(size, 0) as usize].to_vec()
            })
            .collect()
    }

    pub fn track(file: &[u8]) -> Track {
        let kinds: Vec<[u8; 4]> = boxes(file).iter().map(|(k, _)| *k).collect();
        assert_eq!(kinds, [*b"ftyp", *b"mdat", *b"moov"]);
        let stbl = find(file, &[b"moov", b"trak", b"mdia", b"minf", b"stbl"]);
        let entry = find(&find(stbl, &[b"stsd"])[8..], &[b"av01"]);
        let config = find(&entry[78..], &[b"av1C"]).to_vec();
        let mdhd = find(file, &[b"moov", b"trak", b"mdia", b"mdhd"]);
        let durations = table(find(stbl, &[b"stts"]), 0, 8)
            .iter()
            .flat_map(|e| std::iter::repeat_n(u32_at(e, 4), u32_at(e, 0) as usize))
            .collect();
        let keys = table(find(stbl, &[b"stss"]), 0, 4)
            .iter()
            .map(|e| u32_at(e, 0))
            .collect();
        let samples = samples(file, stbl);
        Track {
            width: u32::from(u16::from_be_bytes(entry[24..26].try_into().unwrap())),
            height: u32::from(u16::from_be_bytes(entry[26..28].try_into().unwrap())),
            timescale: u32_at(mdhd, 20),
            config,
            durations,
            keys,
            samples,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;

    #[test]
    fn indexes_samples_written_into_the_file() {
        let mut mp4 = Mp4Writer::start(
            Cursor::new(Vec::new()),
            (64, 36),
            90_000,
            vec![0x81, 0, 0, 0],
        )
        .unwrap();
        mp4.write_sample(b"key one", 3000, true).unwrap();
        mp4.write_sample(b"delta", 3000, false).unwrap();
        mp4.write_sample(b"held!", 87_000, false).unwrap();
        mp4.write_sample(b"key two", 3000, true).unwrap();
        let file = mp4.finish().unwrap().into_inner();

        let track = read::track(&file);
        assert_eq!(
            (track.width, track.height, track.timescale),
            (64, 36, 90_000)
        );
        assert_eq!(track.config, [0x81, 0, 0, 0]);
        assert_eq!(track.durations, [3000, 3000, 87_000, 3000]);
        assert_eq!(track.keys, [1, 4]);
        assert_eq!(
            track.samples,
            [&b"key one"[..], b"delta", b"held!", b"key two"]
        );
    }

    #[test]
    fn the_media_box_holds_exactly_the_samples() {
        let mut mp4 = Mp4Writer::start(Cursor::new(Vec::new()), (2, 2), 30, vec![]).unwrap();
        mp4.write_sample(&[7; 10], 1, true).unwrap();
        let file = mp4.finish().unwrap().into_inner();
        let boxes = read::boxes(&file);
        assert_eq!(&boxes[1].0, b"mdat");
        assert_eq!(boxes[1].1, [7; 10]);
    }

    #[test]
    fn adds_an_opus_track_after_the_video() {
        let mut mp4 = Mp4Writer::start(Cursor::new(Vec::new()), (2, 2), 90_000, vec![]).unwrap();
        mp4.write_sample(b"frame", 90_000, true).unwrap();
        let track = AudioTrack {
            packets: vec![b"one".to_vec(), b"two".to_vec(), b"three".to_vec()],
            pre_skip: 312,
            input_rate: 24_000,
            length: 3 * 960 - 312,
        };
        mp4.write_audio(&track).unwrap();
        let file = mp4.finish().unwrap().into_inner();

        assert_eq!(read::track(&file).samples, [b"frame".to_vec()]);
        let audio = read::audio(&file);
        assert_eq!(audio.timescale, 48_000);
        assert_eq!((audio.pre_skip, audio.input_rate), (312, 24_000));
        assert_eq!(audio.durations, [960; 3]);
        assert_eq!(audio.samples, track.packets);
        // Playback starts after the pre-skip; 3 × 960 − 312 samples is 53 ms.
        assert_eq!(audio.edit, (53, 312));
        // The movie lasts as long as its longest track; the next track would be the third.
        assert_eq!(audio.movie, (1000, 3));
        // The media box holds both tracks' samples.
        assert_eq!(read::boxes(&file)[1].1, b"frameonetwothree");
    }

    #[test]
    fn durations_are_in_the_movie_and_track_timescales() {
        let mut mp4 = Mp4Writer::start(Cursor::new(Vec::new()), (2, 2), 90_000, vec![]).unwrap();
        mp4.write_sample(&[0], 135_000, true).unwrap();
        let file = mp4.finish().unwrap().into_inner();
        let mvhd = read::boxes(read::boxes(&file)[2].1)[0].1;
        assert_eq!(u32::from_be_bytes(mvhd[12..16].try_into().unwrap()), 1000);
        assert_eq!(
            u32::from_be_bytes(mvhd[16..20].try_into().unwrap()),
            1500,
            "1.5 s"
        );
    }
}
