/** Encode de-interleaved float channels as a 16-bit PCM RIFF/WAVE file. */
export function encodeWav(
  channels: Float32Array[],
  sampleRate: number,
): ArrayBuffer {
  const numChannels = channels.length;
  if (numChannels === 0) throw new Error("encodeWav: no channels");
  const frames = channels[0].length;
  for (const c of channels) {
    if (c.length !== frames) throw new Error("encodeWav: channel length mismatch");
  }
  const bytesPerSample = 2;
  const blockAlign = numChannels * bytesPerSample;
  const dataBytes = frames * blockAlign;
  const buf = new ArrayBuffer(44 + dataBytes);
  const v = new DataView(buf);

  writeAscii(v, 0, "RIFF");
  v.setUint32(4, 36 + dataBytes, true);
  writeAscii(v, 8, "WAVE");
  writeAscii(v, 12, "fmt ");
  v.setUint32(16, 16, true); // PCM chunk size
  v.setUint16(20, 1, true); // PCM format
  v.setUint16(22, numChannels, true);
  v.setUint32(24, sampleRate, true);
  v.setUint32(28, sampleRate * blockAlign, true);
  v.setUint16(32, blockAlign, true);
  v.setUint16(34, bytesPerSample * 8, true);
  writeAscii(v, 36, "data");
  v.setUint32(40, dataBytes, true);

  let o = 44;
  for (let i = 0; i < frames; i++) {
    for (let c = 0; c < numChannels; c++) {
      const s = Math.max(-1, Math.min(1, channels[c][i]));
      v.setInt16(o, s < 0 ? s * 0x8000 : s * 0x7fff, true);
      o += 2;
    }
  }
  return buf;
}

function writeAscii(v: DataView, offset: number, s: string) {
  for (let i = 0; i < s.length; i++) v.setUint8(offset + i, s.charCodeAt(i));
}

/** Concatenate chunked float captures (one array per channel per chunk). */
export function concatChunks(chunks: Float32Array[][], numChannels: number): Float32Array[] {
  const total = chunks.reduce((n, ch) => n + (ch[0]?.length ?? 0), 0);
  const out: Float32Array[] = [];
  for (let c = 0; c < numChannels; c++) {
    const arr = new Float32Array(total);
    let o = 0;
    for (const ch of chunks) {
      const src = ch[c] ?? ch[0];
      arr.set(src, o);
      o += src.length;
    }
    out.push(arr);
  }
  return out;
}
