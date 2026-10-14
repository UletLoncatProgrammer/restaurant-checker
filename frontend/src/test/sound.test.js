import { describe, it, expect, vi, beforeEach } from "vitest";
import { buildWav, SOUNDS, playSound, setSoundEnabled, getSoundState, _resetForTests } from "../lib/sound";

describe("buildWav", () => {
  it("produces a valid 16-bit mono PCM WAV with the right sizes", () => {
    const wav = buildWav([{ f: 880, d: 0.1 }, { f: 0, d: 0.05 }]);
    const v = new DataView(wav.buffer);
    const tag = (o) => String.fromCharCode(...wav.slice(o, o + 4));
    expect(tag(0)).toBe("RIFF");
    expect(tag(8)).toBe("WAVE");
    expect(tag(12)).toBe("fmt ");
    expect(v.getUint16(20, true)).toBe(1); // PCM
    expect(v.getUint16(22, true)).toBe(1); // mono
    expect(v.getUint16(34, true)).toBe(16);
    expect(tag(36)).toBe("data");
    const dataBytes = v.getUint32(40, true);
    expect(dataBytes).toBe(wav.length - 44);
    expect(v.getUint32(4, true)).toBe(wav.length - 8);
    expect(dataBytes / 2 / 22050).toBeCloseTo(0.15, 2);
  });

  it("is audible for tones and silent for rests; never clips", () => {
    for (const [name, notes] of Object.entries(SOUNDS)) {
      const wav = buildWav(notes);
      const pcm = new Int16Array(wav.buffer, 44);
      const peak = Math.max(...pcm.map(Math.abs));
      expect(peak, name).toBeGreaterThan(8000);
      expect(peak, name).toBeLessThan(32768);
    }
    const silent = new Int16Array(buildWav([{ f: 0, d: 0.1 }]).buffer, 44);
    expect(silent.every((s) => s === 0)).toBe(true);
  });

  it("each alert is distinguishable (different length/pattern)", () => {
    const lens = Object.values(SOUNDS).map((n) => buildWav(n).length);
    expect(new Set(lens).size).toBe(3);
  });
});

describe("playSound", () => {
  let play;
  beforeEach(() => {
    play = vi.fn().mockResolvedValue(undefined);
    globalThis.Audio = class {
      constructor() { this.play = play; this.currentTime = 0; }
    };
    URL.createObjectURL = vi.fn(() => "blob:x");
    _resetForTests();
  });

  it("plays when enabled and reports unlocked after success", async () => {
    expect(await playSound("newOrder")).toBe(true);
    expect(play).toHaveBeenCalledTimes(1);
    expect(getSoundState().unlocked).toBe(true);
  });

  it("does nothing when muted", async () => {
    setSoundEnabled(false);
    expect(await playSound("ready")).toBe(false);
    expect(play).not.toHaveBeenCalled();
  });

  it("flags audio as locked when the browser refuses (so the UI can ask for a tap)", async () => {
    expect(await playSound("ready")).toBe(true); // unlocked now
    play.mockRejectedValueOnce(new DOMException("NotAllowedError"));
    expect(await playSound("ready")).toBe(false);
    expect(getSoundState().unlocked).toBe(false);
  });

  it("ignores unknown sound names", async () => {
    expect(await playSound("nope")).toBe(false);
  });
});
