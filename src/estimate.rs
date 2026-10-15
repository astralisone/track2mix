//! Tempo and key estimation for tracks whose tags don't carry them (the
//! usual case for freshly scanned folders). These are heuristics tuned for
//! four-on-the-floor dance music and will be wrong on some tracks: tags
//! written by Rekordbox, Traktor, Serato or Mixed In Key always win, and the
//! estimates only fill gaps.

use rustfft::{num_complex::Complex, FftPlanner};

use crate::keys::Camelot;

// ───────────────────────────── tempo ─────────────────────────────

const BPM_FFT: usize = 1024;
const BPM_HOP: usize = 256;
const BPM_MIN: f32 = 70.0;
const BPM_MAX: f32 = 190.0;
/// Soft preference for the usual club range; keeps 87 vs 174 style octave
/// ties from flipping at random without ruling either out.
const BPM_PRIOR_CENTER: f32 = 135.0;
const BPM_PRIOR_SIGMA_OCTAVES: f32 = 1.1;

pub fn estimate_bpm(samples: &[f32], sample_rate: u32) -> Option<f32> {
    let sr = sample_rate as usize;
    if samples.len() < sr * 8 {
        return None;
    }
    // Up to 90 s from the middle of the track (intros and outros are rarely
    // representative).
    let want = 90 * sr;
    let (start, len) = if samples.len() > want {
        ((samples.len() - want) / 2, want)
    } else {
        (0, samples.len())
    };
    let excerpt = &samples[start..start + len];

    let env = onset_envelope(excerpt)?;
    let fps = sample_rate as f32 / BPM_HOP as f32;

    let max_lag = (fps * 60.0 / BPM_MIN * 4.0).ceil() as usize + 2;
    if env.len() <= max_lag * 2 {
        return None;
    }
    let ac = autocorrelate(&env, max_lag);
    if ac[0] <= 1e-9 {
        return None;
    }

    let score = |bpm: f32| -> f32 {
        let lag = fps * 60.0 / bpm;
        let mut s = 0.0;
        let mut w = 1.0;
        for k in 1..=4 {
            s += w * interp(&ac, lag * k as f32);
            w *= 0.75;
        }
        // A real beat period also lines up with its own half (off-beat hats,
        // snares). This separates 174 from the 2:3 sub-harmonic 116, which
        // otherwise ties on pure periodicity.
        s += 0.5 * interp(&ac, lag * 0.5);
        let octaves = (bpm / BPM_PRIOR_CENTER).log2() / BPM_PRIOR_SIGMA_OCTAVES;
        s * (-0.5 * octaves * octaves).exp()
    };

    let mut best = (BPM_MIN, f32::MIN);
    let mut bpm = BPM_MIN;
    while bpm <= BPM_MAX {
        let sc = score(bpm);
        if sc > best.1 {
            best = (bpm, sc);
        }
        bpm += 0.25;
    }
    if best.1 <= 0.0 {
        return None;
    }
    // Fine pass around the winner.
    let (mut fine, mut fine_score) = best;
    let mut b = best.0 - 0.4;
    while b <= best.0 + 0.4 {
        let sc = score(b);
        if sc > fine_score {
            fine = b;
            fine_score = sc;
        }
        b += 0.05;
    }
    // Dance music is almost always produced at a whole BPM.
    let rounded = fine.round();
    let out = if (fine - rounded).abs() < 0.15 {
        rounded
    } else {
        (fine * 10.0).round() / 10.0
    };
    Some(out)
}

/// Half-wave-rectified, log-compressed spectral flux with its local mean
/// removed.
fn onset_envelope(x: &[f32]) -> Option<Vec<f32>> {
    if x.len() < BPM_FFT * 4 {
        return None;
    }
    let mut planner = FftPlanner::<f32>::new();
    let fft = planner.plan_fft_forward(BPM_FFT);
    let hann: Vec<f32> = (0..BPM_FFT)
        .map(|i| 0.5 - 0.5 * (2.0 * std::f32::consts::PI * i as f32 / (BPM_FFT - 1) as f32).cos())
        .collect();
    // Ignore the very top of the spectrum (cymbal hiss, codec lowpass edge).
    let bins = BPM_FFT / 2 * 3 / 4;
    let mut prev = vec![0.0f32; bins];
    let mut env = Vec::with_capacity(x.len() / BPM_HOP);
    let mut buf = vec![Complex::new(0.0f32, 0.0); BPM_FFT];
    let mut pos = 0;
    while pos + BPM_FFT <= x.len() {
        for i in 0..BPM_FFT {
            buf[i] = Complex::new(x[pos + i] * hann[i], 0.0);
        }
        fft.process(&mut buf);
        let mut flux = 0.0f32;
        for k in 0..bins {
            let m = (1.0 + 100.0 * buf[k].norm() / BPM_FFT as f32).ln();
            flux += (m - prev[k]).max(0.0);
            prev[k] = m;
        }
        env.push(flux);
        pos += BPM_HOP;
    }
    // Remove a ~0.5 s centred moving average so slow level changes don't dominate.
    let half = 22usize;
    let mut prefix = vec![0.0f32; env.len() + 1];
    for (i, v) in env.iter().enumerate() {
        prefix[i + 1] = prefix[i] + v;
    }
    let out: Vec<f32> = (0..env.len())
        .map(|i| {
            let lo = i.saturating_sub(half);
            let hi = (i + half + 1).min(env.len());
            let mean = (prefix[hi] - prefix[lo]) / (hi - lo) as f32;
            (env[i] - mean).max(0.0)
        })
        .collect();
    Some(out)
}

fn autocorrelate(x: &[f32], max_lag: usize) -> Vec<f32> {
    let mean = x.iter().sum::<f32>() / x.len() as f32;
    let c: Vec<f32> = x.iter().map(|v| v - mean).collect();
    (0..=max_lag)
        .map(|lag| {
            let n = c.len() - lag;
            c[..n]
                .iter()
                .zip(&c[lag..])
                .map(|(a, b)| a * b)
                .sum::<f32>()
                / n as f32
        })
        .collect()
}

fn interp(ac: &[f32], lag: f32) -> f32 {
    let i = lag.floor() as usize;
    if i + 1 >= ac.len() {
        return 0.0;
    }
    let f = lag - i as f32;
    ac[i] * (1.0 - f) + ac[i + 1] * f
}

// ───────────────────────────── key ─────────────────────────────

const KEY_FFT: usize = 8192;
const KEY_HOP: usize = 4096;

// Krumhansl–Kessler probe-tone profiles, tonic first.
const MAJOR: [f32; 12] = [
    6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88,
];
const MINOR: [f32; 12] = [
    6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17,
];

pub fn estimate_key(samples: &[f32], sample_rate: u32) -> Option<Camelot> {
    let sr = sample_rate as usize;
    // A few seconds of audio says little about the key; don't guess from it.
    if samples.len() < sr * 10 {
        return None;
    }
    let want = 60 * sr;
    let (start, len) = if samples.len() > want {
        ((samples.len() - want) / 2, want)
    } else {
        (0, samples.len())
    };
    let x = &samples[start..start + len];

    let mut planner = FftPlanner::<f32>::new();
    let fft = planner.plan_fft_forward(KEY_FFT);
    let hann: Vec<f32> = (0..KEY_FFT)
        .map(|i| 0.5 - 0.5 * (2.0 * std::f32::consts::PI * i as f32 / (KEY_FFT - 1) as f32).cos())
        .collect();
    let hz_per_bin = sample_rate as f32 / KEY_FFT as f32;
    let lo = (55.0 / hz_per_bin).ceil() as usize;
    let hi = ((2000.0 / hz_per_bin) as usize).min(KEY_FFT / 2 - 2);

    let mut chroma = [0.0f32; 12];
    let mut buf = vec![Complex::new(0.0f32, 0.0); KEY_FFT];
    let mut pos = 0;
    while pos + KEY_FFT <= x.len() {
        for i in 0..KEY_FFT {
            buf[i] = Complex::new(x[pos + i] * hann[i], 0.0);
        }
        fft.process(&mut buf);
        let mag: Vec<f32> = buf[..KEY_FFT / 2].iter().map(|c| c.norm()).collect();
        let frame_max = mag[lo..=hi].iter().cloned().fold(0.0f32, f32::max);
        if frame_max > 1e-6 {
            for k in lo.max(1)..=hi {
                // Spectral peaks only; skirts of strong partials otherwise
                // smear into neighbouring pitch classes.
                if mag[k] > mag[k - 1] && mag[k] >= mag[k + 1] && mag[k] > 0.05 * frame_max {
                    let freq = k as f32 * hz_per_bin;
                    let midi = 69.0 + 12.0 * (freq / 440.0).log2();
                    let pc = (midi.round() as i32).rem_euclid(12) as usize;
                    chroma[pc] += (mag[k] / frame_max).sqrt();
                }
            }
        }
        pos += KEY_HOP;
    }
    if chroma.iter().sum::<f32>() <= 1e-6 {
        return None;
    }

    let mut best: Option<(f32, u8, bool)> = None;
    for tonic in 0..12u8 {
        for (profile, major) in [(&MAJOR, true), (&MINOR, false)] {
            let rotated: Vec<f32> = (0..12).map(|i| chroma[(tonic as usize + i) % 12]).collect();
            let r = pearson(&rotated, profile);
            if best.is_none_or(|(b, _, _)| r > b) {
                best = Some((r, tonic, major));
            }
        }
    }
    let (r, tonic, major) = best?;
    if !r.is_finite() || r <= 0.0 {
        return None;
    }
    Some(Camelot::from_tonic(tonic, major))
}

fn pearson(a: &[f32], b: &[f32]) -> f32 {
    let n = a.len() as f32;
    let ma = a.iter().sum::<f32>() / n;
    let mb = b.iter().sum::<f32>() / n;
    let (mut num, mut da, mut db) = (0.0, 0.0, 0.0);
    for (x, y) in a.iter().zip(b) {
        num += (x - ma) * (y - mb);
        da += (x - ma).powi(2);
        db += (y - mb).powi(2);
    }
    if da <= 1e-12 || db <= 1e-12 {
        return 0.0;
    }
    num / (da.sqrt() * db.sqrt())
}

#[cfg(test)]
mod tests {
    use super::*;

    const SR: u32 = 22050;

    /// Kick-on-the-beat track with off-beat hats, `secs` long.
    fn beat_track(bpm: f32, secs: f32) -> Vec<f32> {
        let n = (secs * SR as f32) as usize;
        let mut out = vec![0.0f32; n];
        let beat = 60.0 / bpm;
        let mut t = 0.0;
        while t < secs {
            let start = (t * SR as f32) as usize;
            // 60 ms decaying 60 Hz thump
            for i in 0..(0.06 * SR as f32) as usize {
                if start + i < n {
                    let tt = i as f32 / SR as f32;
                    out[start + i] +=
                        (2.0 * std::f32::consts::PI * 60.0 * tt).sin() * (-tt * 40.0).exp();
                }
            }
            // off-beat hat: short noise burst (deterministic LCG)
            let hat = ((t + beat / 2.0) * SR as f32) as usize;
            let mut seed = hat as u32;
            for i in 0..(0.015 * SR as f32) as usize {
                seed = seed.wrapping_mul(1664525).wrapping_add(1013904223);
                if hat + i < n {
                    out[hat + i] +=
                        0.25 * ((seed >> 16) as f32 / 32768.0 - 1.0) * (-(i as f32) / 80.0).exp();
                }
            }
            t += beat;
        }
        out
    }

    #[test]
    fn finds_tempo_of_synthetic_beats() {
        for bpm in [
            90.0, 100.0, 110.0, 124.0, 128.0, 135.0, 140.0, 150.0, 160.0, 170.0, 174.0, 178.0,
        ] {
            let est = estimate_bpm(&beat_track(bpm, 40.0), SR).expect("tempo");
            assert!((est - bpm).abs() < 1.0, "wanted {bpm}, got {est}");
        }
    }

    #[test]
    fn refuses_clips_that_are_too_short() {
        assert!(estimate_bpm(&vec![0.1; SR as usize * 3], SR).is_none());
        assert!(estimate_key(&vec![0.1; 1000], SR).is_none());
    }

    /// Sustained triads (with a few harmonics) following a chord progression.
    fn progression(chords: &[[u8; 3]], secs_each: f32) -> Vec<f32> {
        let mut out = Vec::new();
        for chord in chords {
            let n = (secs_each * SR as f32) as usize;
            let mut seg = vec![0.0f32; n];
            for &midi in chord {
                let f0 = 440.0 * 2f32.powf((midi as f32 - 69.0) / 12.0);
                for (h, amp) in [(1.0, 1.0), (2.0, 0.5), (3.0, 0.25)] {
                    for (i, s) in seg.iter_mut().enumerate() {
                        *s += amp
                            * (2.0 * std::f32::consts::PI * f0 * h * i as f32 / SR as f32).sin()
                            * 0.1;
                    }
                }
            }
            out.extend(seg);
        }
        out
    }

    #[test]
    fn detects_minor_and_major_keys() {
        // A minor: Am – Dm – E – Am
        let am = progression(
            &[[57, 60, 64], [62, 65, 69], [64, 68, 71], [57, 60, 64]],
            6.0,
        );
        assert_eq!(estimate_key(&am, SR).unwrap().to_string(), "8A");
        // C major: C – F – G – C
        let c = progression(
            &[[48, 52, 55], [53, 57, 60], [55, 59, 62], [48, 52, 55]],
            6.0,
        );
        assert_eq!(estimate_key(&c, SR).unwrap().to_string(), "8B");
        // F# minor: F#m – Bm – C# – F#m
        let fsm = progression(
            &[[54, 57, 61], [59, 62, 66], [61, 65, 68], [54, 57, 61]],
            6.0,
        );
        assert_eq!(estimate_key(&fsm, SR).unwrap().to_string(), "11A");
    }
}
