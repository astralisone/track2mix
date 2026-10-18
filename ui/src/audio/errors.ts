/**
 * Turn a Web Audio failure into something a user can act on. WebKitGTK
 * (the Linux webview) drives audio through GStreamer and throws
 * `InvalidStateError: Failed to start the audio device` when the sink
 * plugins aren't installed — a system problem, not an app bug.
 */
export function describeAudioError(e: unknown): string {
  const msg = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
  if (/audio device|InvalidStateError|NotSupportedError/i.test(msg)) {
    return (
      `${msg}. The webview could not open an audio output device. On Linux the ` +
      `webview plays through GStreamer: check that a sound server (PipeWire or ` +
      `PulseAudio) is running and that the GStreamer audio sink plugins are ` +
      `available to this build, then restart Track2Mix.`
    );
  }
  return msg;
}
