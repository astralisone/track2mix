use anyhow::{anyhow, Context, Result};
use std::path::Path;
use symphonia::core::audio::SampleBuffer;
use symphonia::core::codecs::DecoderOptions;
use symphonia::core::formats::FormatOptions;
use symphonia::core::io::MediaSourceStream;
use symphonia::core::meta::MetadataOptions;
use symphonia::core::probe::Hint;

pub struct DecodedAudio {
    pub samples: Vec<f32>,
    pub sample_rate: u32,
}

/// Decode a whole audio file to mono f32 PCM.
///
/// For feature extraction we don't need stereo — downmixing halves the
/// work downstream. For very long tracks (DJ tools, ambient sets) this
/// can eat memory; the sampling strategy in features.rs compensates.
pub fn decode_mono(path: &Path, target_sr: u32) -> Result<DecodedAudio> {
    let file = std::fs::File::open(path).with_context(|| format!("opening {}", path.display()))?;
    let mss = MediaSourceStream::new(Box::new(file), Default::default());

    let mut hint = Hint::new();
    if let Some(ext) = path.extension().and_then(|s| s.to_str()) {
        hint.with_extension(ext);
    }

    let probed = symphonia::default::get_probe()
        .format(
            &hint,
            mss,
            &FormatOptions::default(),
            &MetadataOptions::default(),
        )
        .context("probing audio format")?;

    let mut format = probed.format;
    let track = format
        .default_track()
        .ok_or_else(|| anyhow!("no default track"))?;
    let track_id = track.id;
    let source_sr = track
        .codec_params
        .sample_rate
        .ok_or_else(|| anyhow!("unknown sample rate"))?;
    let mut decoder = symphonia::default::get_codecs()
        .make(&track.codec_params, &DecoderOptions::default())
        .context("creating decoder")?;

    // Resample while decoding so we never hold a whole file at the source
    // sample rate (a 1 h 96 kHz mix is >1 GB of f32), and stop at
    // MAX_DECODE_SECS so one long DJ mix can't exhaust memory on its own.
    let max_out = MAX_DECODE_SECS as usize * target_sr as usize;
    let mut resampler = LinearResampler::new(source_sr, target_sr);
    let mut samples: Vec<f32> = Vec::new();

    'packets: loop {
        let packet = match format.next_packet() {
            Ok(p) => p,
            Err(symphonia::core::errors::Error::IoError(_)) => break, // EOF
            Err(e) => return Err(e.into()),
        };
        if packet.track_id() != track_id {
            continue;
        }
        match decoder.decode(&packet) {
            Ok(decoded) => {
                let spec = *decoded.spec();
                let channels = spec.channels.count().max(1);
                let mut buf = SampleBuffer::<f32>::new(decoded.capacity() as u64, spec);
                buf.copy_interleaved_ref(decoded);
                // Downmix to mono by averaging channels.
                for frame in buf.samples().chunks(channels) {
                    let sum: f32 = frame.iter().sum();
                    resampler.push(sum / channels as f32, &mut samples);
                }
                if samples.len() >= max_out {
                    samples.truncate(max_out);
                    break 'packets;
                }
            }
            Err(symphonia::core::errors::Error::DecodeError(_)) => continue,
            Err(e) => return Err(e.into()),
        }
    }

    if samples.is_empty() {
        return Err(anyhow!("no decodable audio in {}", path.display()));
    }

    Ok(DecodedAudio {
        samples,
        sample_rate: target_sr,
    })
}

/// Longest stretch of a file we decode for analysis.
pub const MAX_DECODE_SECS: u32 = 15 * 60;

/// Streaming linear-interpolation resampler. Cheap and fine for MIR
/// features; swap in `rubato` if you ever need audio-grade conversion.
struct LinearResampler {
    ratio: f64,
    next_src: f64,
    idx: u64,
    prev: f32,
}

impl LinearResampler {
    fn new(from_sr: u32, to_sr: u32) -> Self {
        Self {
            ratio: from_sr as f64 / to_sr as f64,
            next_src: 0.0,
            idx: 0,
            prev: 0.0,
        }
    }

    fn push(&mut self, x: f32, out: &mut Vec<f32>) {
        if self.idx == 0 {
            self.prev = x;
        }
        while self.next_src <= self.idx as f64 {
            let frac = (self.next_src - (self.idx as f64 - 1.0)) as f32;
            out.push(self.prev + (x - self.prev) * frac);
            self.next_src += self.ratio;
        }
        self.prev = x;
        self.idx += 1;
    }
}
