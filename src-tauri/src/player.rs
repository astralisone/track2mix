//! In-app audio preview.
//!
//! rodio's output stream (`MixerDeviceSink`) is `!Send`, so a dedicated audio
//! thread owns it together with the current `Player` and the queue. Tauri
//! commands talk to that thread over an `mpsc` channel; the thread publishes a
//! `PlayerState` snapshot (shared via a mutex for `player_status`) and emits it
//! as the `player:state` event on every change and about 4 Hz while playing.
//!
//! Paths come only from the loaded library cache, resolved at play time by the
//! caller, so no file-system scope or asset protocol is involved.

use serde::Serialize;
use std::fs::File;
use std::path::{Path, PathBuf};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError, Sender};
use std::sync::{Arc, Mutex, MutexGuard};
use std::thread::JoinHandle;
use std::time::Duration;

/// Event name the frontend listens on.
pub const STATE_EVENT: &str = "player:state";

/// How often the audio thread wakes while idle or playing, for position ticks
/// and end-of-track detection.
const TICK: Duration = Duration::from_millis(250);

/// `prev` restarts the current track when we are past this many seconds.
const PREV_RESTART_SECS: f64 = 3.0;

/// Snapshot of the player, matching `PlayerState` in `ui/src/lib/tauri.ts`.
#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct PlayerState {
    pub queue: Vec<String>,
    /// Position in `queue`, -1 when idle.
    pub index: i64,
    pub playing: bool,
    pub position: f64,
    pub duration: Option<f64>,
    pub volume: f32,
    /// `<code>: <detail>`, code one of nofile | nopath | decode | device |
    /// seek | skipped. The UI maps on the code only.
    pub error: Option<String>,
    /// Bumped once per processed command (and per auto-advance); periodic
    /// ticks repeat the current value.
    pub seq: u64,
}

impl Default for PlayerState {
    fn default() -> Self {
        Self {
            queue: Vec::new(),
            index: -1,
            playing: false,
            position: 0.0,
            duration: None,
            volume: 1.0,
            error: None,
            seq: 0,
        }
    }
}

/// One queue entry: the track id and its file path, if the library has one.
#[derive(Debug, Clone)]
pub struct QueueItem {
    pub track_id: String,
    pub path: Option<PathBuf>,
}

enum Cmd {
    Play { items: Vec<QueueItem>, start: usize },
    Toggle,
    Next,
    Prev,
    Seek(f64),
    Volume(f32),
    Stop,
    Shutdown,
}

/// Sink for state snapshots. The real app emits a Tauri event; tests can
/// collect them.
pub type Emit = Box<dyn Fn(&PlayerState) + Send + 'static>;

/// Handle held in Tauri state. Cheap to call from any command thread.
pub struct PlayerHandle {
    tx: Mutex<Option<Sender<Cmd>>>,
    state: Arc<Mutex<PlayerState>>,
    thread: Mutex<Option<JoinHandle<()>>>,
}

fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    // A panic while holding one of these locks leaves plain data behind, so
    // carrying on with it is safe and better than cascading panics.
    m.lock().unwrap_or_else(|e| e.into_inner())
}

impl PlayerHandle {
    pub fn spawn(emit: Emit) -> Self {
        let (tx, rx) = mpsc::channel();
        let state = Arc::new(Mutex::new(PlayerState::default()));
        let shared = Arc::clone(&state);
        let thread = std::thread::Builder::new()
            .name("track2mix-audio".into())
            .spawn(move || AudioThread::new(shared, emit).run(rx))
            .ok();
        if thread.is_none() {
            lock(&state).error = Some("device: could not start audio thread".into());
        }
        Self {
            tx: Mutex::new(thread.as_ref().map(|_| tx)),
            state,
            thread: Mutex::new(thread),
        }
    }

    fn send(&self, cmd: Cmd) -> Result<(), String> {
        let guard = lock(&self.tx);
        let tx = guard
            .as_ref()
            .ok_or_else(|| "audio player is not running".to_string())?;
        tx.send(cmd)
            .map_err(|_| "audio player has stopped".to_string())
    }

    pub fn play(&self, items: Vec<QueueItem>, start: usize) -> Result<(), String> {
        self.send(Cmd::Play { items, start })
    }
    pub fn toggle(&self) -> Result<(), String> {
        self.send(Cmd::Toggle)
    }
    pub fn next(&self) -> Result<(), String> {
        self.send(Cmd::Next)
    }
    pub fn prev(&self) -> Result<(), String> {
        self.send(Cmd::Prev)
    }
    pub fn seek(&self, secs: f64) -> Result<(), String> {
        self.send(Cmd::Seek(secs))
    }
    pub fn volume(&self, v: f32) -> Result<(), String> {
        self.send(Cmd::Volume(v))
    }
    pub fn stop(&self) -> Result<(), String> {
        self.send(Cmd::Stop)
    }
    pub fn status(&self) -> PlayerState {
        lock(&self.state).clone()
    }

    /// Stop the audio thread and wait for it. Safe to call more than once.
    pub fn shutdown(&self) {
        if let Some(tx) = lock(&self.tx).take() {
            let _ = tx.send(Cmd::Shutdown);
        }
        if let Some(h) = lock(&self.thread).take() {
            let _ = h.join();
        }
    }
}

impl Drop for PlayerHandle {
    fn drop(&mut self) {
        self.shutdown();
    }
}

// ---------------------------------------------------------------------------
// Queue logic, kept free of audio types so it can be unit tested.

/// Ordered queue with a cursor. Navigation returns the index to try next;
/// callers skip unplayable entries by stepping again.
#[derive(Debug, Default, Clone)]
pub struct Queue {
    items: Vec<QueueItem>,
    index: Option<usize>,
}

impl Queue {
    pub fn new(items: Vec<QueueItem>) -> Self {
        Self { items, index: None }
    }
    pub fn len(&self) -> usize {
        self.items.len()
    }
    pub fn is_empty(&self) -> bool {
        self.items.is_empty()
    }
    pub fn index(&self) -> Option<usize> {
        self.index
    }
    pub fn ids(&self) -> Vec<String> {
        self.items.iter().map(|i| i.track_id.clone()).collect()
    }
    pub fn set_index(&mut self, i: Option<usize>) {
        self.index = i.filter(|&i| i < self.items.len());
    }
    pub fn clear(&mut self) {
        self.items.clear();
        self.index = None;
    }
    /// Index after `from`, if any.
    pub fn after(&self, from: usize) -> Option<usize> {
        (from + 1 < self.items.len()).then_some(from + 1)
    }
    /// Index before `from`, if any.
    pub fn before(&self, from: usize) -> Option<usize> {
        from.checked_sub(1)
    }
}

/// Direction to walk when the chosen entry cannot be played.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Dir {
    Forward,
    Backward,
}

/// Starting at `start`, walk in `dir` until `try_open` succeeds. Returns the
/// index that opened plus its payload, and collects an error message for
/// each entry skipped on the way. Pure apart from `try_open`.
pub fn find_playable<T>(
    q: &Queue,
    start: usize,
    dir: Dir,
    mut try_open: impl FnMut(&QueueItem) -> Result<T, String>,
    errors: &mut Vec<String>,
) -> Option<(usize, T)> {
    let mut i = Some(start).filter(|&s| s < q.len());
    while let Some(idx) = i {
        match try_open(&q.items[idx]) {
            Ok(v) => return Some((idx, v)),
            Err(e) => errors.push(e),
        }
        i = match dir {
            Dir::Forward => q.after(idx),
            Dir::Backward => q.before(idx),
        };
    }
    None
}

/// What `prev` should do given the current playback position.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PrevAction {
    Restart,
    GoTo(usize),
}

pub fn prev_action(current: usize, position_secs: f64) -> PrevAction {
    if position_secs > PREV_RESTART_SECS || current == 0 {
        PrevAction::Restart
    } else {
        PrevAction::GoTo(current - 1)
    }
}

/// Clamp a seek target to `[0, duration]` (leaving a hair of room at the end
/// so the seek doesn't land past the last decodable packet).
pub fn clamp_seek(secs: f64, duration: Option<f64>) -> f64 {
    let s = if secs.is_finite() { secs.max(0.0) } else { 0.0 };
    match duration {
        Some(d) if d > 0.0 => s.min((d - 0.05).max(0.0)),
        _ => s,
    }
}

// ---------------------------------------------------------------------------
// Audio side.

type Source = rodio::Decoder<std::io::BufReader<File>>;

struct Opened {
    source: Source,
    duration: Option<f64>,
}

fn open_item(item: &QueueItem) -> Result<Opened, String> {
    let path = item
        .path
        .as_ref()
        .ok_or_else(|| format!("nopath: track {} has no file path", item.track_id))?;
    let file = File::open(path).map_err(|e| format!("nofile: {}: {}", path.display(), e))?;
    let source =
        Source::try_from(file).map_err(|e| format!("decode: {}: {}", path.display(), e))?;
    let duration = rodio::Source::total_duration(&source)
        .map(|d| d.as_secs_f64())
        .or_else(|| probe_duration(path));
    Ok(Opened { source, duration })
}

/// Fallback duration from the container header: n_frames / sample_rate.
fn probe_duration(path: &Path) -> Option<f64> {
    use symphonia::core::formats::FormatOptions;
    use symphonia::core::io::MediaSourceStream;
    use symphonia::core::meta::MetadataOptions;
    use symphonia::core::probe::Hint;

    let file = File::open(path).ok()?;
    let mss = MediaSourceStream::new(Box::new(file), Default::default());
    let mut hint = Hint::new();
    if let Some(ext) = path.extension().and_then(|e| e.to_str()) {
        hint.with_extension(ext);
    }
    let probed = symphonia::default::get_probe()
        .format(
            &hint,
            mss,
            &FormatOptions::default(),
            &MetadataOptions::default(),
        )
        .ok()?;
    let track = probed.format.default_track()?;
    let params = &track.codec_params;
    let frames = params.n_frames?;
    let rate = params.sample_rate?;
    (rate > 0).then(|| frames as f64 / rate as f64)
}

struct AudioThread {
    shared: Arc<Mutex<PlayerState>>,
    emit: Emit,
    device: Option<rodio::MixerDeviceSink>,
    player: Option<rodio::Player>,
    queue: Queue,
    duration: Option<f64>,
    volume: f32,
    error: Option<String>,
    seq: u64,
    last: Option<PlayerState>,
}

impl AudioThread {
    fn new(shared: Arc<Mutex<PlayerState>>, emit: Emit) -> Self {
        Self {
            shared,
            emit,
            device: None,
            player: None,
            queue: Queue::default(),
            duration: None,
            volume: 1.0,
            error: None,
            seq: 0,
            last: None,
        }
    }

    fn run(mut self, rx: Receiver<Cmd>) {
        loop {
            match rx.recv_timeout(TICK) {
                Ok(Cmd::Shutdown) | Err(RecvTimeoutError::Disconnected) => break,
                Ok(cmd) => self.handle(cmd),
                Err(RecvTimeoutError::Timeout) => {}
            }
            self.check_track_end();
            self.publish();
        }
        self.halt();
        self.queue.clear();
        self.publish();
    }

    fn is_playing(&self) -> bool {
        self.player
            .as_ref()
            .is_some_and(|p| !p.is_paused() && !p.empty())
    }

    fn position(&self) -> f64 {
        self.player
            .as_ref()
            .map_or(0.0, |p| p.get_pos().as_secs_f64())
    }

    fn handle(&mut self, cmd: Cmd) {
        if !matches!(cmd, Cmd::Shutdown) {
            self.seq += 1;
        }
        match cmd {
            Cmd::Play { items, start } => {
                self.error = None;
                self.halt();
                self.queue = Queue::new(items);
                if self.queue.is_empty() {
                    return;
                }
                let start = start.min(self.queue.len() - 1);
                self.start_at(start, Dir::Forward);
            }
            Cmd::Toggle => match (&self.player, self.queue.index()) {
                (Some(p), Some(_)) if !p.empty() => {
                    if p.is_paused() {
                        p.play();
                    } else {
                        p.pause();
                    }
                }
                // Finished or never started: replay the current (or first) entry.
                (_, idx) if !self.queue.is_empty() => {
                    self.error = None;
                    self.start_at(idx.unwrap_or(0), Dir::Forward);
                }
                _ => {}
            },
            Cmd::Next => {
                self.error = None;
                if let Some(next) = self.queue.index().and_then(|i| self.queue.after(i)) {
                    self.start_at(next, Dir::Forward);
                } else {
                    // End of the queue: stop but keep the queue for the UI.
                    self.halt();
                    self.queue.set_index(None);
                }
            }
            Cmd::Prev => {
                self.error = None;
                if let Some(cur) = self.queue.index() {
                    match prev_action(cur, self.position()) {
                        PrevAction::Restart => self.seek_to(0.0),
                        PrevAction::GoTo(i) => {
                            // Only leave the current track if something earlier
                            // actually plays; otherwise restart it rather than
                            // halting a playable track.
                            let mut skipped = Vec::new();
                            let earlier = find_playable(
                                &self.queue,
                                i,
                                Dir::Backward,
                                open_item,
                                &mut skipped,
                            );
                            if earlier.is_some() {
                                self.start_at(i, Dir::Backward);
                            } else {
                                self.seek_to(0.0);
                            }
                        }
                    }
                }
            }
            Cmd::Seek(secs) => self.seek_to(secs),
            Cmd::Volume(v) => {
                self.volume = if v.is_finite() {
                    v.clamp(0.0, 1.0)
                } else {
                    1.0
                };
                if let Some(p) = &self.player {
                    p.set_volume(self.volume);
                }
            }
            Cmd::Stop => {
                self.error = None;
                self.halt();
                self.queue.clear();
            }
            Cmd::Shutdown => {}
        }
    }

    fn seek_to(&mut self, secs: f64) {
        let target = clamp_seek(secs, self.duration);
        if let Some(p) = &self.player {
            if let Err(e) = p.try_seek(Duration::from_secs_f64(target)) {
                self.error = Some(format!("seek: {}", e));
            }
        }
    }

    /// Drop the current player (stops output) and forget the duration.
    fn halt(&mut self) {
        if let Some(p) = self.player.take() {
            p.stop();
        }
        self.duration = None;
    }

    fn ensure_device(&mut self) -> Result<(), String> {
        if self.device.is_none() {
            let mut dev = rodio::DeviceSinkBuilder::open_default_sink()
                .map_err(|e| format!("device: no audio output: {}", e))?;
            dev.log_on_drop(false);
            self.device = Some(dev);
        }
        Ok(())
    }

    /// Start playing at `idx`, skipping unplayable entries in `dir`.
    fn start_at(&mut self, idx: usize, dir: Dir) {
        self.halt();
        if let Err(e) = self.ensure_device() {
            self.error = Some(e);
            self.queue.set_index(None);
            return;
        }
        let mut errors = Vec::new();
        let found = find_playable(&self.queue, idx, dir, open_item, &mut errors);
        if !errors.is_empty() {
            // One skip keeps its own code; several collapse into `skipped`.
            self.error = Some(if errors.len() == 1 {
                errors.remove(0)
            } else {
                format!(
                    "skipped: {} tracks; last: {}",
                    errors.len(),
                    errors[errors.len() - 1]
                )
            });
        }
        let Some((i, opened)) = found else {
            self.queue.set_index(None);
            return;
        };
        let Some(device) = self.device.as_ref() else {
            return;
        };
        let player = rodio::Player::connect_new(device.mixer());
        player.set_volume(self.volume);
        player.append(opened.source);
        self.duration = opened.duration;
        self.player = Some(player);
        self.queue.set_index(Some(i));
    }

    /// Auto-advance when the current track has run out.
    fn check_track_end(&mut self) {
        let finished = self
            .player
            .as_ref()
            .is_some_and(|p| p.empty() && !p.is_paused());
        if !finished {
            return;
        }
        self.seq += 1;
        // A skip message from an earlier track shouldn't outlive the next one.
        self.error = None;
        match self.queue.index().and_then(|i| self.queue.after(i)) {
            Some(next) => self.start_at(next, Dir::Forward),
            None => {
                self.halt();
                self.queue.set_index(None);
            }
        }
    }

    fn snapshot(&self) -> PlayerState {
        let position = match self.duration {
            Some(d) => self.position().min(d),
            None => self.position(),
        };
        PlayerState {
            queue: self.queue.ids(),
            index: self.queue.index().map_or(-1, |i| i as i64),
            playing: self.is_playing(),
            position,
            duration: self.duration,
            volume: self.volume,
            error: self.error.clone(),
            seq: self.seq,
        }
    }

    /// Publish if anything changed, and always while playing (position tick).
    fn publish(&mut self) {
        let s = self.snapshot();
        if s.playing || self.last.as_ref() != Some(&s) {
            *lock(&self.shared) = s.clone();
            (self.emit)(&s);
            self.last = Some(s);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn q(paths: &[Option<&str>]) -> Queue {
        Queue::new(
            paths
                .iter()
                .enumerate()
                .map(|(i, p)| QueueItem {
                    track_id: format!("t{}", i),
                    path: p.map(PathBuf::from),
                })
                .collect(),
        )
    }

    fn opener(item: &QueueItem) -> Result<String, String> {
        match &item.path {
            Some(p) if !p.to_string_lossy().contains("bad") => Ok(item.track_id.clone()),
            Some(_) => Err(format!("{} undecodable", item.track_id)),
            None => Err(format!("{} has no path", item.track_id)),
        }
    }

    #[test]
    fn next_and_prev_bounds() {
        let qu = q(&[Some("a"), Some("b"), Some("c")]);
        assert_eq!(qu.after(0), Some(1));
        assert_eq!(qu.after(2), None);
        assert_eq!(qu.before(0), None);
        assert_eq!(qu.before(2), Some(1));
    }

    #[test]
    fn skips_pathless_and_undecodable_forward() {
        let qu = q(&[Some("a"), None, Some("bad.mp3"), Some("d")]);
        let mut errs = Vec::new();
        let r = find_playable(&qu, 1, Dir::Forward, opener, &mut errs);
        assert_eq!(r.map(|(i, _)| i), Some(3));
        assert_eq!(errs.len(), 2);
    }

    #[test]
    fn skips_backward() {
        let qu = q(&[Some("a"), None, Some("c")]);
        let mut errs = Vec::new();
        let r = find_playable(&qu, 1, Dir::Backward, opener, &mut errs);
        assert_eq!(r.map(|(i, _)| i), Some(0));
        assert_eq!(errs.len(), 1);
    }

    #[test]
    fn nothing_playable() {
        let qu = q(&[None, Some("bad")]);
        let mut errs = Vec::new();
        assert!(find_playable(&qu, 0, Dir::Forward, opener, &mut errs).is_none());
        assert_eq!(errs.len(), 2);
        let mut errs = Vec::new();
        assert!(find_playable(&qu, 5, Dir::Forward, opener, &mut errs).is_none());
        assert!(errs.is_empty());
    }

    #[test]
    fn prev_restarts_after_three_seconds() {
        assert_eq!(prev_action(2, 3.5), PrevAction::Restart);
        assert_eq!(prev_action(2, 1.0), PrevAction::GoTo(1));
        assert_eq!(prev_action(0, 1.0), PrevAction::Restart);
    }

    #[test]
    fn seek_is_clamped() {
        assert_eq!(clamp_seek(-4.0, Some(100.0)), 0.0);
        assert_eq!(clamp_seek(f64::NAN, Some(100.0)), 0.0);
        assert!(clamp_seek(500.0, Some(100.0)) < 100.0);
        assert_eq!(clamp_seek(42.0, None), 42.0);
    }

    #[test]
    fn set_index_rejects_out_of_range() {
        let mut qu = q(&[Some("a")]);
        qu.set_index(Some(3));
        assert_eq!(qu.index(), None);
        qu.set_index(Some(0));
        assert_eq!(qu.index(), Some(0));
    }

    #[test]
    fn open_errors_use_stable_codes() {
        let code = |path: Option<PathBuf>| {
            let item = QueueItem {
                track_id: "x".into(),
                path,
            };
            open_item(&item).err().unwrap_or_default()
        };
        assert!(code(None).starts_with("nopath: "));
        assert!(code(Some("/definitely/not/here.mp3".into())).starts_with("nofile: "));
        let junk = std::env::temp_dir().join(format!("t2m-junk-{}.mp3", std::process::id()));
        std::fs::write(&junk, b"not audio at all").unwrap();
        let c = code(Some(junk.clone()));
        let _ = std::fs::remove_file(&junk);
        assert!(c.starts_with("decode: "), "{c}");
    }

    #[test]
    fn handle_without_audio_reports_state() {
        // Stop/volume never touch the device, so this runs headless.
        let seen = Arc::new(Mutex::new(Vec::<PlayerState>::new()));
        let sink = Arc::clone(&seen);
        let h = PlayerHandle::spawn(Box::new(move |s| lock(&sink).push(s.clone())));
        h.volume(0.25).unwrap();
        h.stop().unwrap();
        h.shutdown();
        assert!((h.status().volume - 0.25).abs() < 1e-6);
        assert_eq!(h.status().index, -1);
        assert!(lock(&seen).iter().any(|s| (s.volume - 0.25).abs() < 1e-6));
        assert_eq!(h.status().seq, 2);
        let seqs: Vec<u64> = lock(&seen).iter().map(|s| s.seq).collect();
        assert!(seqs.windows(2).all(|w| w[0] <= w[1]));
        assert!(h.volume(0.5).is_err());
    }
}
