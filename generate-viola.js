// Generates the original loop used by the Viola instrument. No source recording is used.
const fs = require('node:fs');
const path = require('node:path');

const sampleRate = 44100;
const seconds = 4;
const samples = sampleRate * seconds;
const fundamental = 1046 / seconds; // 261.5 Hz, an exact number of cycles per loop.
const harmonics = [1, .52, .34, .22, .15, .1, .075, .052, .038, .028, .02, .015];
const pcm = new Int16Array(samples);
let peak = 0;
const values = new Float64Array(samples);

for (let i = 0; i < samples; i++) {
  const t = i / sampleRate;
  const vibrato = .055 * Math.sin(2 * Math.PI * 5 * t) + .014 * Math.sin(2 * Math.PI * 6 * t);
  const phase = 2 * Math.PI * fundamental * t + vibrato;
  let value = 0;
  for (let h = 0; h < harmonics.length; h++) {
    const number = h + 1;
    value += harmonics[h] * Math.sin(number * phase + (h % 3) * .17);
  }
  // Periodic high partials imitate bow friction while keeping the loop seamless.
  value += .018 * Math.sin(2 * Math.PI * 3989.25 * t);
  value += .012 * Math.sin(2 * Math.PI * 5744.5 * t + .8);
  value *= .91 + .06 * Math.sin(2 * Math.PI * t) + .03 * Math.sin(4 * Math.PI * t + .4);
  values[i] = value;
  peak = Math.max(peak, Math.abs(value));
}

for (let i = 0; i < samples; i++) pcm[i] = Math.round(values[i] / peak * 23500);

const dataBytes = pcm.byteLength;
const wav = Buffer.alloc(44 + dataBytes);
wav.write('RIFF', 0);wav.writeUInt32LE(36 + dataBytes, 4);wav.write('WAVE', 8);
wav.write('fmt ', 12);wav.writeUInt32LE(16, 16);wav.writeUInt16LE(1, 20);
wav.writeUInt16LE(1, 22);wav.writeUInt32LE(sampleRate, 24);wav.writeUInt32LE(sampleRate * 2, 28);
wav.writeUInt16LE(2, 32);wav.writeUInt16LE(16, 34);wav.write('data', 36);wav.writeUInt32LE(dataBytes, 40);
for (let i = 0; i < samples; i++) wav.writeInt16LE(pcm[i], 44 + i * 2);

const output = path.join(__dirname, 'public', 'audio', 'viola.wav');
fs.writeFileSync(output, wav);
console.log(`Generated ${output} (${fundamental} Hz, ${seconds} seconds)`);
