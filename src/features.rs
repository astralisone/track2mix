use rustfft::{num_complex::Complex, FftPlanner};

/// Compact per-track feature vector for playlist intelligence.
/// All values normalized to roughly 0..1 for easy comparison.
#[derive(Debug, Clone)]
pub struct Features {
    /// Overall loudness — your "how loud is this track" proxy
    pub rms_mean: f32,
    /// How much the loudness varies — dynamic tracks score high
    pub rms_variance: f32,
    /// Brightness: low = dark/bassy, high = crisp/trebly
    pub spectral_centroid_mean: f32,
    /// How much the spectrum changes frame-to-frame — movement proxy
    pub spectral_flux_mean: f32,
    /// Onsets per second — rhythmic density
    pub onset_rate: f32,
    /// Our derived "energy" 0..1, a weighted combo of the above
    pub energy: f32,
}

const FFT_SIZE: usize = 2048;
const HOP_SIZE: usize = 512;

/// Sample the audio file in three 30-second windows (20%, 50%, 80%)
/// rather than analyzing the whole thing. For playlist use this
/// captures enough character at ~5-10x the speed.
pub fn sampled_windows(samples: &[f32], sample_rate: u32) -> Vec<&[f32]> {
    let window_len = (30 * sample_rate) as usize;
    let total = samples.len();
    if total <= window_len * 3 {
        return vec![samples];
    }
    let positions = [0.20, 0.50, 0.80];
    positions
        .iter()
        .map(|p| {
            let start = ((total as f32 * p) as usize).min(total - window_len);
            &samples[start..start + window_len]
        })
        .collect()
}

pub fn extract(samples: &[f32], sample_rate: u32) -> Features {
    let windows = sampled_windows(samples, sample_rate);

    let mut rms_values: Vec<f32> = Vec::new();
    let mut centroid_values: Vec<f32> = Vec::new();
    let mut flux_values: Vec<f32> = Vec::new();
    let mut total_onsets = 0usize;
    let mut total_seconds = 0.0f32;

    let mut planner = FftPlanner::<f32>::new();
    let fft = planner.plan_fft_forward(FFT_SIZE);
    let hann: Vec<f32> = (0..FFT_SIZE)
        .map(|i| 0.5 - 0.5 * (2.0 * std::f32::consts::PI * i as f32 / (FFT_SIZE - 1) as f32).cos())
        .collect();

    for window in &windows {
        let mut prev_mag: Vec<f32> = vec![0.0; FFT_SIZE / 2];
        let mut onsets = 0usize;
        let mut frames = 0usize;

        for chunk_start in (0..window.len().saturating_sub(FFT_SIZE)).step_by(HOP_SIZE) {
            let chunk = &window[chunk_start..chunk_start + FFT_SIZE];

            // RMS on the raw windowed signal
            let rms = (chunk.iter().map(|s| s * s).sum::<f32>() / chunk.len() as f32).sqrt();
            rms_values.push(rms);

            // Windowed FFT
            let mut buf: Vec<Complex<f32>> = chunk
                .iter()
                .zip(hann.iter())
                .map(|(s, w)| Complex::new(s * w, 0.0))
                .collect();
            fft.process(&mut buf);

            let mag: Vec<f32> = buf[..FFT_SIZE / 2].iter().map(|c| c.norm()).collect();

            // Spectral centroid = frequency-weighted magnitude mean
            let total_mag: f32 = mag.iter().sum();
            if total_mag > 1e-6 {
                let weighted: f32 = mag.iter().enumerate().map(|(i, m)| i as f32 * m).sum();
                let centroid_bin = weighted / total_mag;
                // Normalize to 0..1 (Nyquist = FFT_SIZE/2 bins)
                centroid_values.push(centroid_bin / (FFT_SIZE / 2) as f32);
            }

            // Spectral flux = positive magnitude deltas (onset indicator)
            let flux: f32 = mag
                .iter()
                .zip(prev_mag.iter())
                .map(|(m, p)| (m - p).max(0.0))
                .sum();
            flux_values.push(flux);

            // Very simple onset detector: flux spike above local mean
            if frames > 4 {
                let recent_mean = flux_values
                    [flux_values.len().saturating_sub(5)..flux_values.len() - 1]
                    .iter()
                    .sum::<f32>()
                    / 4.0;
                if flux > recent_mean * 1.8 && flux > 0.05 {
                    onsets += 1;
                }
            }

            prev_mag = mag;
            frames += 1;
        }

        total_onsets += onsets;
        total_seconds += window.len() as f32 / sample_rate as f32;
    }

    let rms_mean = mean(&rms_values);
    let rms_variance = variance(&rms_values, rms_mean);
    let spectral_centroid_mean = mean(&centroid_values);
    let spectral_flux_mean = normalize_flux(mean(&flux_values));
    let onset_rate = if total_seconds > 0.0 {
        total_onsets as f32 / total_seconds
    } else {
        0.0
    };

    // Composite energy score. Tuned by ear — adjust weights to taste.
    let energy = (0.4 * rms_mean.min(1.0)
        + 0.2 * spectral_centroid_mean
        + 0.2 * spectral_flux_mean.min(1.0)
        + 0.2 * (onset_rate / 10.0).min(1.0))
    .clamp(0.0, 1.0);

    Features {
        rms_mean,
        rms_variance,
        spectral_centroid_mean,
        spectral_flux_mean,
        onset_rate,
        energy,
    }
}

fn mean(v: &[f32]) -> f32 {
    if v.is_empty() {
        0.0
    } else {
        v.iter().sum::<f32>() / v.len() as f32
    }
}

fn variance(v: &[f32], mean: f32) -> f32 {
    if v.is_empty() {
        0.0
    } else {
        v.iter().map(|x| (x - mean).powi(2)).sum::<f32>() / v.len() as f32
    }
}

fn normalize_flux(raw: f32) -> f32 {
    // Flux is unbounded; this squashes it into roughly 0..1 for typical music.
    // You'll want to empirically recalibrate on your own library.
    (raw / 50.0).clamp(0.0, 1.0)
}
