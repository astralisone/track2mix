import { describe, expect, it } from "vitest";
import { concatChunks, encodeWav } from "@/audio/wav";

const ascii = (v: DataView, o: number, n: number) =>
  Array.from({ length: n }, (_, i) => String.fromCharCode(v.getUint8(o + i))).join("");

describe("encodeWav", () => {
  it("writes a valid 16-bit PCM header", () => {
    const l = new Float32Array([0, 0.5, -0.5]);
    const r = new Float32Array([0.25, 0, 1]);
    const buf = encodeWav([l, r], 48_000);
    const v = new DataView(buf);
    expect(buf.byteLength).toBe(44 + 3 * 2 * 2);
    expect(ascii(v, 0, 4)).toBe("RIFF");
    expect(v.getUint32(4, true)).toBe(36 + 12);
    expect(ascii(v, 8, 4)).toBe("WAVE");
    expect(ascii(v, 12, 4)).toBe("fmt ");
    expect(v.getUint32(16, true)).toBe(16);
    expect(v.getUint16(20, true)).toBe(1);
    expect(v.getUint16(22, true)).toBe(2);
    expect(v.getUint32(24, true)).toBe(48_000);
    expect(v.getUint32(28, true)).toBe(48_000 * 4);
    expect(v.getUint16(32, true)).toBe(4);
    expect(v.getUint16(34, true)).toBe(16);
    expect(ascii(v, 36, 4)).toBe("data");
    expect(v.getUint32(40, true)).toBe(12);
  });

  it("interleaves channels L,R,L,R and scales samples", () => {
    const l = new Float32Array([0.5, -0.5]);
    const r = new Float32Array([0, 1]);
    const v = new DataView(encodeWav([l, r], 44_100));
    expect(v.getInt16(44, true)).toBe(Math.trunc(0.5 * 0x7fff));
    expect(v.getInt16(46, true)).toBe(0);
    expect(v.getInt16(48, true)).toBe(-0x4000);
    expect(v.getInt16(50, true)).toBe(0x7fff);
  });

  it("clips out-of-range samples", () => {
    const v = new DataView(encodeWav([new Float32Array([2, -2, 1, -1])], 44_100));
    expect(v.getInt16(44, true)).toBe(0x7fff);
    expect(v.getInt16(46, true)).toBe(-0x8000);
    expect(v.getInt16(48, true)).toBe(0x7fff);
    expect(v.getInt16(50, true)).toBe(-0x8000);
  });

  it("handles mono", () => {
    const v = new DataView(encodeWav([new Float32Array(10)], 22_050));
    expect(v.getUint16(22, true)).toBe(1);
    expect(v.getUint16(32, true)).toBe(2);
    expect(v.getUint32(40, true)).toBe(20);
  });

  it("rejects bad input", () => {
    expect(() => encodeWav([], 44_100)).toThrow(/no channels/);
    expect(() =>
      encodeWav([new Float32Array(2), new Float32Array(3)], 44_100),
    ).toThrow(/length mismatch/);
  });
});

describe("concatChunks", () => {
  it("concatenates per-channel chunks in order", () => {
    const chunks = [
      [new Float32Array([1, 2]), new Float32Array([10, 20])],
      [new Float32Array([3]), new Float32Array([30])],
    ];
    const out = concatChunks(chunks, 2);
    expect(Array.from(out[0])).toEqual([1, 2, 3]);
    expect(Array.from(out[1])).toEqual([10, 20, 30]);
  });

  it("duplicates channel 0 when a chunk is missing a channel", () => {
    const out = concatChunks([[new Float32Array([1, 2])]], 2);
    expect(Array.from(out[1])).toEqual([1, 2]);
  });

  it("returns empty arrays for no chunks", () => {
    const out = concatChunks([], 2);
    expect(out).toHaveLength(2);
    expect(out[0].length).toBe(0);
  });
});
