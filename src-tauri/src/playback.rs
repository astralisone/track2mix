use crate::AppState;
use std::path::Path;
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

/// Write a recording the webview produced (already WAV-encoded) to the path
/// the user picked in the save dialog. The body is the raw bytes; the
/// destination path travels percent-encoded in the `x-path` header because
/// HTTP headers can't carry arbitrary unicode.
#[tauri::command]
pub fn write_recording(request: Request<'_>) -> Result<usize, String> {
    let raw = request
        .headers()
        .get("x-path")
        .and_then(|v| v.to_str().ok())
        .ok_or_else(|| "missing x-path header".to_string())?;
    let path_str = urlencoding::decode(raw)
        .map_err(|e| format!("bad x-path header: {}", e))?
        .into_owned();
    let path = Path::new(&path_str);
    validate_recording_path(path)?;
    let bytes: &[u8] = match request.body() {
        InvokeBody::Raw(b) => b,
        InvokeBody::Json(_) => return Err("expected a binary body".to_string()),
    };
    std::fs::write(path, bytes).map_err(|e| format!("write {}: {}", path.display(), e))?;
    Ok(bytes.len())
}

/// Recordings may only land in `.wav` files at an absolute path: the path
/// comes from a save dialog, but the header is still untrusted input.
pub(crate) fn validate_recording_path(path: &Path) -> Result<(), String> {
    if !path.is_absolute() {
        return Err("recording path must be absolute".to_string());
    }
    let ok_ext = path
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.eq_ignore_ascii_case("wav"))
        .unwrap_or(false);
    if !ok_ext {
        return Err("recording path must end in .wav".to_string());
    }
    Ok(())
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
    fn recording_path_must_be_absolute_wav() {
        assert!(validate_recording_path(Path::new("/tmp/mix.wav")).is_ok());
        assert!(validate_recording_path(Path::new("/tmp/mix.WAV")).is_ok());
        assert!(validate_recording_path(Path::new("mix.wav")).is_err());
        assert!(validate_recording_path(Path::new("/tmp/mix.mp3")).is_err());
        assert!(validate_recording_path(Path::new("/tmp/mix")).is_err());
    }
}
