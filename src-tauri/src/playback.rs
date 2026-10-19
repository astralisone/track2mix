use crate::mp3::{encode_mp3, parse_wav, Mp3Tags};
use crate::AppState;
use std::path::{Path, PathBuf};
use tauri::ipc::{InvokeBody, Request, Response};

/// Raw file bytes for a library track. The webview decodes them with
/// `AudioContext.decodeAudioData`, which is the fast path on every platform.
#[tauri::command]
pub async fn read_track_audio(
    state: tauri::State<'_, AppState>,
    track_id: String,
) -> Result<Response, String> {
    let path = state.file_path_for(&track_id)?;
    let bytes = tauri::async_runtime::spawn_blocking(move || {
        std::fs::read(&path).map_err(|e| format!("read {}: {}", path.display(), e))
    })
    .await
    .map_err(|e| format!("read task join failed: {}", e))??;
    Ok(Response::new(bytes))
}

/// Fallback when the webview's decoder rejects a format: decode with
/// Symphonia to mono f32 PCM. Payload layout is `u32 LE sample_rate`
/// followed by little-endian f32 samples.
#[tauri::command]
pub async fn decode_track_pcm(
    state: tauri::State<'_, AppState>,
    track_id: String,
    sample_rate: Option<u32>,
) -> Result<Response, String> {
    let path = state.file_path_for(&track_id)?;
    let sr = sample_rate.unwrap_or(44_100).clamp(8_000, 192_000);
    let bytes = tauri::async_runtime::spawn_blocking(move || {
        let decoded = track2mix_core::audio::decode_mono(&path, sr)
            .map_err(|e| format!("decode {}: {:#}", path.display(), e))?;
        Ok::<Vec<u8>, String>(encode_pcm(decoded.sample_rate, &decoded.samples))
    })
    .await
    .map_err(|e| format!("decode task join failed: {}", e))??;
    Ok(Response::new(bytes))
}

pub(crate) fn encode_pcm(sample_rate: u32, samples: &[f32]) -> Vec<u8> {
    let mut out = Vec::with_capacity(4 + samples.len() * 4);
    out.extend_from_slice(&sample_rate.to_le_bytes());
    for s in samples {
        out.extend_from_slice(&s.to_le_bytes());
    }
    out
}

/// Write a render the webview produced (always WAV-encoded) to the path
/// the user picked in the save dialog. A `.wav` destination gets the bytes
/// as they are; a `.mp3` destination is transcoded with LAME first, at the
/// `x-bitrate` kbps (default 320) and tagged from `x-title` / `x-artist`.
/// The body is the raw bytes; everything else travels percent-encoded in
/// headers because HTTP headers can't carry arbitrary unicode.
#[tauri::command]
pub async fn write_recording(request: Request<'_>) -> Result<usize, String> {
    let path_str =
        header(&request, "x-path")?.ok_or_else(|| "missing x-path header".to_string())?;
    let path = PathBuf::from(&path_str);
    let format = validate_recording_path(&path)?;
    let bytes: Vec<u8> = match request.body() {
        InvokeBody::Raw(b) => b.clone(),
        InvokeBody::Json(_) => return Err("expected a binary body".to_string()),
    };
    let kbps = header(&request, "x-bitrate")?
        .and_then(|v| v.parse::<u32>().ok())
        .unwrap_or(320);
    let tags = Mp3Tags {
        title: header(&request, "x-title")?.unwrap_or_default(),
        artist: header(&request, "x-artist")?.unwrap_or_default(),
        comment: "Rendered with Track2Mix".to_string(),
    };
    // Encoding a long mix takes seconds; keep it off the main thread.
    tauri::async_runtime::spawn_blocking(move || {
        let out: Vec<u8> = match format {
            RecordingFormat::Wav => bytes,
            RecordingFormat::Mp3 => {
                let wav = parse_wav(&bytes)?;
                encode_mp3(&wav, kbps, &tags)?
            }
        };
        std::fs::write(&path, &out).map_err(|e| format!("write {}: {}", path.display(), e))?;
        Ok(out.len())
    })
    .await
    .map_err(|e| format!("write task join failed: {}", e))?
}

fn header(request: &Request<'_>, name: &str) -> Result<Option<String>, String> {
    let Some(raw) = request.headers().get(name).and_then(|v| v.to_str().ok()) else {
        return Ok(None);
    };
    urlencoding::decode(raw)
        .map(|s| Some(s.into_owned()))
        .map_err(|e| format!("bad {} header: {}", name, e))
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum RecordingFormat {
    Wav,
    Mp3,
}

/// Renders may only land in `.wav` or `.mp3` files at an absolute path: the
/// path comes from a save dialog, but the header is still untrusted input.
pub(crate) fn validate_recording_path(path: &Path) -> Result<RecordingFormat, String> {
    if !path.is_absolute() {
        return Err("recording path must be absolute".to_string());
    }
    match path
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_ascii_lowercase())
        .as_deref()
    {
        Some("wav") => Ok(RecordingFormat::Wav),
        Some("mp3") => Ok(RecordingFormat::Mp3),
        _ => Err("recording path must end in .wav or .mp3".to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pcm_layout_is_sample_rate_then_f32_le() {
        let b = encode_pcm(44_100, &[0.5, -1.0]);
        assert_eq!(&b[..4], &44_100u32.to_le_bytes());
        assert_eq!(&b[4..8], &0.5f32.to_le_bytes());
        assert_eq!(&b[8..12], &(-1.0f32).to_le_bytes());
    }

    #[test]
    fn recording_path_must_be_absolute_wav_or_mp3() {
        assert_eq!(
            validate_recording_path(Path::new("/tmp/mix.wav")),
            Ok(RecordingFormat::Wav)
        );
        assert_eq!(
            validate_recording_path(Path::new("/tmp/mix.WAV")),
            Ok(RecordingFormat::Wav)
        );
        assert_eq!(
            validate_recording_path(Path::new("/tmp/mix.mp3")),
            Ok(RecordingFormat::Mp3)
        );
        assert!(validate_recording_path(Path::new("mix.wav")).is_err());
        assert!(validate_recording_path(Path::new("/tmp/mix.flac")).is_err());
        assert!(validate_recording_path(Path::new("/tmp/mix")).is_err());
    }
}
