//! MP3 export: parse the 16-bit WAV the webview renders and encode it with
//! LAME (compiled in through `mp3lame-encoder`, so there is no runtime
//! dependency on a system `libmp3lame`).

use mp3lame_encoder::{Bitrate, Builder, FlushNoGap, Id3Tag, InterleavedPcm, MonoPcm, Quality};

/// Interleaved 16-bit PCM as read from a RIFF/WAVE file.
#[derive(Debug, Clone, PartialEq)]
pub struct Wav {
    pub sample_rate: u32,
    pub channels: u16,
    pub samples: Vec<i16>,
}

impl Wav {
    pub fn frames(&self) -> usize {
        if self.channels == 0 {
            0
        } else {
            self.samples.len() / self.channels as usize
        }
    }
}

/// Parse a PCM WAV. Only what the in-app writer produces is accepted
/// (integer PCM, 16-bit, one or two channels); anything else is an error
/// rather than a silent mis-decode.
pub fn parse_wav(bytes: &[u8]) -> Result<Wav, String> {
    if bytes.len() < 12 || &bytes[0..4] != b"RIFF" || &bytes[8..12] != b"WAVE" {
        return Err("not a RIFF/WAVE file".to_string());
    }
    let mut pos = 12;
    let mut fmt: Option<(u16, u16, u32, u16)> = None; // (format, channels, rate, bits)
    let mut data: Option<&[u8]> = None;
    while pos + 8 <= bytes.len() {
        let id = &bytes[pos..pos + 4];
        let size = u32::from_le_bytes([
            bytes[pos + 4],
            bytes[pos + 5],
            bytes[pos + 6],
            bytes[pos + 7],
        ]) as usize;
        let body_start = pos + 8;
        // A truncated data chunk (writer died mid-file) still yields what is there.
        let body_end = body_start.saturating_add(size).min(bytes.len());
        let body = &bytes[body_start..body_end];
        match id {
            b"fmt " => {
                if body.len() < 16 {
                    return Err("fmt chunk too short".to_string());
                }
                let format = u16::from_le_bytes([body[0], body[1]]);
                let channels = u16::from_le_bytes([body[2], body[3]]);
                let rate = u32::from_le_bytes([body[4], body[5], body[6], body[7]]);
                let bits = u16::from_le_bytes([body[14], body[15]]);
                fmt = Some((format, channels, rate, bits));
            }
            b"data" => {
                data = Some(body);
                break;
            }
            _ => {}
        }
        // Chunks are word-aligned.
        pos = body_start + size + (size & 1);
    }
    let (format, channels, sample_rate, bits) = fmt.ok_or("missing fmt chunk")?;
    let data = data.ok_or("missing data chunk")?;
    if format != 1 {
        return Err(format!("unsupported WAV format tag {} (want PCM)", format));
    }
    if bits != 16 {
        return Err(format!("unsupported WAV bit depth {} (want 16)", bits));
    }
    if channels != 1 && channels != 2 {
        return Err(format!(
            "unsupported channel count {} (want 1 or 2)",
            channels
        ));
    }
    if sample_rate == 0 {
        return Err("sample rate is 0".to_string());
    }
    let frame_bytes = 2 * channels as usize;
    let usable = data.len() - data.len() % frame_bytes;
    let samples = (0..usable)
        .step_by(2)
        .map(|i| i16::from_le_bytes([data[i], data[i + 1]]))
        .collect();
    Ok(Wav {
        sample_rate,
        channels,
        samples,
    })
}

/// Tags written into the ID3v2 header of the exported file.
#[derive(Debug, Default, Clone)]
pub struct Mp3Tags {
    pub title: String,
    pub artist: String,
    pub comment: String,
}

/// Round an arbitrary kbps request to the nearest rate LAME supports.
pub fn bitrate_for(kbps: u32) -> Bitrate {
    const TABLE: [(u32, Bitrate); 11] = [
        (64, Bitrate::Kbps64),
        (80, Bitrate::Kbps80),
        (96, Bitrate::Kbps96),
        (112, Bitrate::Kbps112),
        (128, Bitrate::Kbps128),
        (160, Bitrate::Kbps160),
        (192, Bitrate::Kbps192),
        (224, Bitrate::Kbps224),
        (256, Bitrate::Kbps256),
        (320, Bitrate::Kbps320),
        (u32::MAX, Bitrate::Kbps320),
    ];
    let mut best = TABLE[0];
    for entry in TABLE {
        if kbps.abs_diff(entry.0) < kbps.abs_diff(best.0) {
            best = entry;
        }
    }
    best.1
}

/// CBR-encode `wav` at `kbps`. Output is a complete file: ID3v2 tag, LAME
/// info frame, then audio. LAME caps ID3 text fields at 250 bytes, so the
/// tags are truncated on a char boundary before they go in.
pub fn encode_mp3(wav: &Wav, kbps: u32, tags: &Mp3Tags) -> Result<Vec<u8>, String> {
    if wav.samples.is_empty() {
        return Err("nothing to encode: no samples".to_string());
    }
    let mut b = Builder::new().ok_or("LAME: could not create encoder")?;
    b.set_num_channels(wav.channels as u8)
        .map_err(|e| format!("LAME channels: {:?}", e))?;
    b.set_sample_rate(wav.sample_rate)
        .map_err(|e| format!("LAME sample rate: {:?}", e))?;
    b.set_brate(bitrate_for(kbps))
        .map_err(|e| format!("LAME bitrate: {:?}", e))?;
    b.set_quality(Quality::Best)
        .map_err(|e| format!("LAME quality: {:?}", e))?;
    let title = clip_utf8(&tags.title, 250);
    let artist = clip_utf8(&tags.artist, 250);
    let comment = clip_utf8(&tags.comment, 250);
    let tag = Id3Tag {
        title: title.as_bytes(),
        artist: artist.as_bytes(),
        album: &[],
        album_art: &[],
        year: &[],
        comment: comment.as_bytes(),
    };
    if tag.is_any_set() {
        b.set_id3_tag(tag)
            .map_err(|e| format!("LAME id3: {:?}", e))?;
    }
    let mut enc = b.build().map_err(|e| format!("LAME init: {:?}", e))?;

    // LAME's documented worst case: 1.25 × samples + 7200 bytes.
    let frames = wav.frames();
    let mut out: Vec<u8> = Vec::with_capacity(frames * 5 / 4 + 7200 + 4096);
    // Feed in slices so the reserved spare capacity bound holds per call.
    const CHUNK_FRAMES: usize = 1 << 16;
    let ch = wav.channels as usize;
    for chunk in wav.samples.chunks(CHUNK_FRAMES * ch) {
        out.reserve(chunk.len() / ch * 5 / 4 + 7200);
        let written = if ch == 1 {
            enc.encode_to_vec(MonoPcm(chunk), &mut out)
        } else {
            enc.encode_to_vec(InterleavedPcm(chunk), &mut out)
        };
        written.map_err(|e| format!("LAME encode: {:?}", e))?;
    }
    out.reserve(7200);
    enc.flush_to_vec::<FlushNoGap>(&mut out)
        .map_err(|e| format!("LAME flush: {:?}", e))?;

    // The Xing/Info frame carries the frame count players use for accurate
    // duration and gapless trimming. It goes between the ID3v2 tag and the
    // first audio frame.
    if enc.lame_tag_size() > 0 {
        let boundary = enc.id3v2_tag_size();
        let mut lame_tag = Vec::new();
        lame_tag.reserve(enc.lame_tag_size());
        if let Some(n) = enc.lame_tag_encode_to_vec(&mut lame_tag) {
            let mut file = Vec::with_capacity(out.len() + n.get());
            file.extend_from_slice(&out[..boundary]);
            file.extend_from_slice(&lame_tag);
            file.extend_from_slice(&out[boundary..]);
            return Ok(file);
        }
    }
    Ok(out)
}

fn clip_utf8(s: &str, max_bytes: usize) -> String {
    if s.len() <= max_bytes {
        return s.to_string();
    }
    let mut end = max_bytes;
    while !s.is_char_boundary(end) {
        end -= 1;
    }
    s[..end].to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn wav_bytes(sample_rate: u32, channels: u16, samples: &[i16]) -> Vec<u8> {
        let data_len = (samples.len() * 2) as u32;
        let mut v = Vec::new();
        v.extend_from_slice(b"RIFF");
        v.extend_from_slice(&(36 + data_len).to_le_bytes());
        v.extend_from_slice(b"WAVE");
        v.extend_from_slice(b"fmt ");
        v.extend_from_slice(&16u32.to_le_bytes());
        v.extend_from_slice(&1u16.to_le_bytes());
        v.extend_from_slice(&channels.to_le_bytes());
        v.extend_from_slice(&sample_rate.to_le_bytes());
        v.extend_from_slice(&(sample_rate * 2 * channels as u32).to_le_bytes());
        v.extend_from_slice(&(2 * channels).to_le_bytes());
        v.extend_from_slice(&16u16.to_le_bytes());
        v.extend_from_slice(b"data");
        v.extend_from_slice(&data_len.to_le_bytes());
        for s in samples {
            v.extend_from_slice(&s.to_le_bytes());
        }
        v
    }

    fn sine(seconds: f32, sample_rate: u32, hz: f32) -> Vec<i16> {
        let n = (seconds * sample_rate as f32) as usize;
        (0..n)
            .flat_map(|i| {
                let t = i as f32 / sample_rate as f32;
                let s = ((t * hz * std::f32::consts::TAU).sin() * 0.5 * i16::MAX as f32) as i16;
                [s, s]
            })
            .collect()
    }

    #[test]
    fn parses_pcm16_stereo() {
        let bytes = wav_bytes(48_000, 2, &[1, -1, 2, -2]);
        let w = parse_wav(&bytes).unwrap();
        assert_eq!(w.sample_rate, 48_000);
        assert_eq!(w.channels, 2);
        assert_eq!(w.samples, vec![1, -1, 2, -2]);
        assert_eq!(w.frames(), 2);
    }

    #[test]
    fn skips_unknown_chunks_and_odd_padding() {
        let mut v = Vec::new();
        v.extend_from_slice(b"RIFF");
        v.extend_from_slice(&0u32.to_le_bytes());
        v.extend_from_slice(b"WAVE");
        v.extend_from_slice(b"LIST");
        v.extend_from_slice(&3u32.to_le_bytes());
        v.extend_from_slice(b"abc\0"); // 3 bytes + pad
        let rest = wav_bytes(44_100, 1, &[7, 8, 9]);
        v.extend_from_slice(&rest[12..]);
        let w = parse_wav(&v).unwrap();
        assert_eq!(w.channels, 1);
        assert_eq!(w.samples, vec![7, 8, 9]);
    }

    #[test]
    fn rejects_non_wav_and_float_wav() {
        assert!(parse_wav(b"ID3\x03\0\0\0").is_err());
        let mut bytes = wav_bytes(44_100, 2, &[0; 4]);
        bytes[20] = 3; // IEEE float
        assert!(parse_wav(&bytes).unwrap_err().contains("format tag"));
        let mut bytes = wav_bytes(44_100, 2, &[0; 4]);
        bytes[34] = 24;
        assert!(parse_wav(&bytes).unwrap_err().contains("bit depth"));
    }

    #[test]
    fn bitrate_rounds_to_supported() {
        assert!(matches!(bitrate_for(320), Bitrate::Kbps320));
        assert!(matches!(bitrate_for(300), Bitrate::Kbps320));
        assert!(matches!(bitrate_for(200), Bitrate::Kbps192));
        assert!(matches!(bitrate_for(1), Bitrate::Kbps64));
    }

    #[test]
    fn encodes_a_second_of_sine_with_tags() {
        let samples = sine(1.0, 44_100, 440.0);
        let wav = Wav {
            sample_rate: 44_100,
            channels: 2,
            samples,
        };
        let tags = Mp3Tags {
            title: "Test mix".into(),
            artist: "Track2Mix".into(),
            comment: "unit test".into(),
        };
        let mp3 = encode_mp3(&wav, 320, &tags).unwrap();
        assert_eq!(&mp3[..3], b"ID3", "starts with an ID3v2 tag");
        // 320 kbps × 1 s ≈ 40 KB, plus tag and info frame.
        assert!(
            mp3.len() > 35_000 && mp3.len() < 60_000,
            "size {}",
            mp3.len()
        );
        let text = String::from_utf8_lossy(&mp3[..1024]);
        assert!(text.contains("Test mix"));
        // Audio frames follow the tag: an MPEG sync word somewhere after it.
        assert!(mp3
            .windows(2)
            .any(|w| w[0] == 0xFF && (w[1] & 0xE0) == 0xE0));
    }

    #[test]
    fn mono_encodes_too() {
        let wav = Wav {
            sample_rate: 44_100,
            channels: 1,
            samples: vec![0; 44_100],
        };
        let mp3 = encode_mp3(&wav, 128, &Mp3Tags::default()).unwrap();
        assert!(mp3.len() > 10_000);
    }

    #[test]
    fn empty_input_is_an_error() {
        let wav = Wav {
            sample_rate: 44_100,
            channels: 2,
            samples: vec![],
        };
        assert!(encode_mp3(&wav, 320, &Mp3Tags::default()).is_err());
    }

    #[test]
    fn clip_respects_char_boundaries() {
        let s = "ééééé"; // 2 bytes each
        assert_eq!(clip_utf8(s, 5), "éé");
        assert_eq!(clip_utf8("abc", 10), "abc");
    }
}
