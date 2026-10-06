export type WaveKind = "sine" | "silence" | "constant" | "noise" | "harmonic";

export function synth(kind: WaveKind, opts: {
  sampleRate: number; frequency?: number; length: number; amplitude?: number; dcOffset?: number; seed?: number;
}): number[] {
  const { sampleRate, frequency = 250, length, amplitude = 0.5, dcOffset = 0, seed = 42 } = opts;
  const out = new Array<number>(length);
  let state = seed >>> 0 || 1;
  const rand = () => { state = (state * 1664525 + 1013904223) >>> 0; return state / 0xffffffff; };
  for (let i = 0; i < length; i++) {
    let v = 0;
    switch (kind) {
      case "sine": v = amplitude * Math.sin((2 * Math.PI * frequency * i) / sampleRate); break;
      case "harmonic": v = amplitude * (0.4 * Math.sin((2 * Math.PI * frequency * i) / sampleRate)
        + 0.6 * Math.sin((4 * Math.PI * frequency * i) / sampleRate)); break;
      case "silence": v = 0; break;
      case "constant": v = amplitude; break;
      case "noise": v = amplitude * (rand() * 2 - 1); break;
    }
    out[i] = Math.max(-1, Math.min(1, v + dcOffset));
  }
  return out;
}
