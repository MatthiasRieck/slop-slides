//! A minimal MP4 (ISO base media file) writer for one AV1 video track, as video.rs makes it.
//!
//! Samples are written into `mdat` as they come; the index (`moov`) follows them at the end,
//! when every sample's size, place and duration is known. Each sample may last any number of
//! track time units, so a frame held on screen is stored once.
//! (ISO/IEC 14496-12, and the AV1 binding: <https://aomediacodec.github.io/av1-isobmff/>.)

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

    /// The track's length in its own time units.
    fn duration(&self) -> u64 {
        self.samples.iter().map(|s| u64::from(s.duration)).sum()
    }

    fn moov(&self) -> Vec<u8> {
        let movie_duration = u32::try_from(
            self.duration() * u64::from(MOVIE_TIMESCALE) / u64::from(self.timescale.max(1)),
        )
        .unwrap_or(u32::MAX);

        let mut mvhd = vec![0; 8]; // version 0, created and modified at 0
        put32(&mut mvhd, MOVIE_TIMESCALE);
        put32(&mut mvhd, movie_duration);
        put32(&mut mvhd, 0x0001_0000); // rate 1.0
        put16(&mut mvhd, 0x0100); // volume 1.0
        mvhd.extend_from_slice(&[0; 10]);
        MATRIX.iter().for_each(|v| put32(&mut mvhd, *v));
        mvhd.extend_from_slice(&[0; 24]);
        put32(&mut mvhd, 2); // next track id

        let mut tkhd = vec![0; 8];
        put32(&mut tkhd, 1); // track id
        put32(&mut tkhd, 0);
        put32(&mut tkhd, movie_duration);
        tkhd.extend_from_slice(&[0; 16]); // reserved, layer, group, volume, reserved
        MATRIX.iter().for_each(|v| put32(&mut tkhd, *v));
        put32(&mut tkhd, self.width << 16);
        put32(&mut tkhd, self.height << 16);

        let mut mdhd = vec![0; 16]; // version 1: 64-bit times, so long videos fit
        put32(&mut mdhd, self.timescale);
        put64(&mut mdhd, self.duration());
        put16(&mut mdhd, 0x55c4); // "und"
        put16(&mut mdhd, 0);

        let mut hdlr = vec![0; 4];
        hdlr.extend_from_slice(b"vide");
        hdlr.extend_from_slice(&[0; 12]);
        hdlr.extend_from_slice(b"VideoHandler\0");

        let url = full(b"url ", 0, 1, &[]); // the media is in this file
        let mut dref = Vec::new();
        put32(&mut dref, 1);
        dref.extend_from_slice(&url);
        let dinf = boxed(b"dinf", &full(b"dref", 0, 0, &dref));

        let minf = boxed(
            b"minf",
            &[
                full(b"vmhd", 0, 1, &[0; 8]),
                dinf,
                boxed(b"stbl", &self.stbl()),
            ]
            .concat(),
        );
        let mdia = boxed(
            b"mdia",
            &[full(b"mdhd", 1, 0, &mdhd), full(b"hdlr", 0, 0, &hdlr), minf].concat(),
        );
        let trak = boxed(b"trak", &[full(b"tkhd", 0, 3, &tkhd), mdia].concat());
        boxed(b"moov", &[full(b"mvhd", 0, 0, &mvhd), trak].concat())
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

        // Runs of samples that last as long as each other.
        let mut runs: Vec<(u32, u32)> = Vec::new();
        for s in &self.samples {
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

        let keys: Vec<u32> = (1..)
            .zip(&self.samples)
            .filter(|(_, s)| s.sync)
            .map(|(n, _)| n)
            .collect();
        let mut stss = Vec::new();
        put32(&mut stss, keys.len() as u32);
        keys.iter().for_each(|n| put32(&mut stss, *n));

        // Each sample is a chunk of its own.
        let mut stsc = Vec::new();
        [1, 1, 1, 1].iter().for_each(|v| put32(&mut stsc, *v));

        let count = self.samples.len() as u32;
        let mut stsz = vec![0; 4];
        put32(&mut stsz, count);
        self.samples.iter().for_each(|s| put32(&mut stsz, s.size));

        let mut co64 = Vec::new();
        put32(&mut co64, count);
        self.samples.iter().for_each(|s| put64(&mut co64, s.offset));

        [
            full(b"stsd", 0, 0, &stsd),
            full(b"stts", 0, 0, &stts),
            full(b"stss", 0, 0, &stss),
            full(b"stsc", 0, 0, &stsc),
            full(b"stsz", 0, 0, &stsz),
            full(b"co64", 0, 0, &co64),
        ]
        .concat()
    }
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
        let sizes = table(find(stbl, &[b"stsz"]), 4, 4);
        let offsets = table(find(stbl, &[b"co64"]), 0, 8);
        let samples = sizes
            .iter()
            .zip(offsets)
            .map(|(size, offset)| {
                let at = u64::from_be_bytes(offset.try_into().unwrap()) as usize;
                file[at..at + u32_at(size, 0) as usize].to_vec()
            })
            .collect();
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
