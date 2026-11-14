import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

const midis = [48, 52, 55, 60, 64, 67, 72, 76, 79, 84];
const sampleRate = 22050;
const seconds = 1.1;
const outDir = join("apps", "web", "public", "samples", "piano");
mkdirSync(outDir, { recursive: true });

for (const midi of midis) {
  const freq = 440 * 2 ** ((midi - 69) / 12);
  const count = Math.floor(sampleRate * seconds);
  const samples = new Float32Array(count);
  const harmonics = [1, 0.55, 0.32, 0.18, 0.1, 0.06];
  for (let i = 0; i < count; i++) {
    const t = i / sampleRate;
    const env = Math.exp(-3.1 * t) * (1 - Math.exp(-90 * t));
    let sample = 0;
    for (let h = 0; h < harmonics.length; h++) {
      sample += harmonics[h] * Math.sin(2 * Math.PI * freq * (h + 1) * (1 + 0.0005 * (h + 1)) * t);
    }
    samples[i] = Math.max(-1, Math.min(1, sample * env * 0.45));
  }
  writeFileSync(join(outDir, `${midi}.wav`), wav(samples, sampleRate));
}

function wav(samples, sampleRate) {
  const dataSize = samples.length * 2;
  const buffer = Buffer.alloc(44 + dataSize);
  buffer.write("RIFF", 0);
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write("WAVE", 8);
  buffer.write("fmt ", 12);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * 2, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write("data", 36);
  buffer.writeUInt32LE(dataSize, 40);
  for (let i = 0; i < samples.length; i++) {
    buffer.writeInt16LE(Math.round(samples[i] * 32767), 44 + i * 2);
  }
  return buffer;
}
