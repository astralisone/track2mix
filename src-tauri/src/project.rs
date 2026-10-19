//! Composition project files (`.t2m`): JSON written by the frontend. The
//! Rust side only moves bytes and guards the path, the schema lives in
//! `ui/src/audio/project.ts`.

use std::path::Path;

pub const PROJECT_EXT: &str = "t2m";
/// A project is a few KB of JSON; anything near this is not one of ours.
const MAX_PROJECT_BYTES: u64 = 16 * 1024 * 1024;

/// Projects may only be read from and written to absolute `.t2m` paths.
/// The path comes from a file dialog, but it still crosses the IPC boundary
/// as untrusted input.
pub(crate) fn validate_project_path(path: &Path) -> Result<(), String> {
    if !path.is_absolute() {
        return Err("project path must be absolute".to_string());
    }
    let ok = path
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.eq_ignore_ascii_case(PROJECT_EXT))
        .unwrap_or(false);
    if !ok {
        return Err(format!("project path must end in .{}", PROJECT_EXT));
    }
    Ok(())
}

#[tauri::command]
pub async fn read_project(path: String) -> Result<String, String> {
    let p = std::path::PathBuf::from(&path);
    validate_project_path(&p)?;
    tauri::async_runtime::spawn_blocking(move || {
        let meta = std::fs::metadata(&p).map_err(|e| format!("open {}: {}", p.display(), e))?;
        if meta.len() > MAX_PROJECT_BYTES {
            return Err(format!(
                "{} is {} MB; a project file should be a few KB",
                p.display(),
                meta.len() / 1_048_576
            ));
        }
        std::fs::read_to_string(&p).map_err(|e| format!("read {}: {}", p.display(), e))
    })
    .await
    .map_err(|e| format!("read task join failed: {}", e))?
}

/// Write atomically (temp file in the same directory, then rename) so a
/// crash mid-write never leaves a half project where a good one was.
#[tauri::command]
pub async fn write_project(path: String, contents: String) -> Result<usize, String> {
    let p = std::path::PathBuf::from(&path);
    validate_project_path(&p)?;
    tauri::async_runtime::spawn_blocking(move || write_atomic(&p, contents.as_bytes()))
        .await
        .map_err(|e| format!("write task join failed: {}", e))?
}

pub(crate) fn write_atomic(path: &Path, bytes: &[u8]) -> Result<usize, String> {
    let dir = path
        .parent()
        .ok_or_else(|| "project path has no parent directory".to_string())?;
    let stem = path
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or("project");
    let tmp = dir.join(format!(".{}.{}.tmp", stem, std::process::id()));
    std::fs::write(&tmp, bytes).map_err(|e| format!("write {}: {}", tmp.display(), e))?;
    if let Err(e) = std::fs::rename(&tmp, path) {
        let _ = std::fs::remove_file(&tmp);
        return Err(format!("rename to {}: {}", path.display(), e));
    }
    Ok(bytes.len())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn project_path_must_be_absolute_t2m() {
        assert!(validate_project_path(Path::new("/tmp/mix.t2m")).is_ok());
        assert!(validate_project_path(Path::new("/tmp/mix.T2M")).is_ok());
        assert!(validate_project_path(Path::new("mix.t2m")).is_err());
        assert!(validate_project_path(Path::new("/tmp/mix.json")).is_err());
        assert!(validate_project_path(Path::new("/tmp/mix")).is_err());
    }

    #[test]
    fn atomic_write_replaces_and_leaves_no_temp() {
        let dir = std::env::temp_dir().join(format!("t2m-proj-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let p = dir.join("a.t2m");
        write_atomic(&p, b"one").unwrap();
        write_atomic(&p, b"two").unwrap();
        assert_eq!(std::fs::read_to_string(&p).unwrap(), "two");
        let leftovers: Vec<_> = std::fs::read_dir(&dir)
            .unwrap()
            .filter_map(|e| e.ok())
            .filter(|e| e.file_name().to_string_lossy().ends_with(".tmp"))
            .collect();
        assert!(leftovers.is_empty());
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
