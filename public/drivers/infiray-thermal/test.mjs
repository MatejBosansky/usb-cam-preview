#!/usr/bin/env node
// Checks the thermal decoder on synthetic frames of several sensor sizes with known temperatures.
// Each frame is built the way a browser hands it over: an InfiRay-style W×2H YUYV frame converted
// to NV12 or I420, with the chroma row taken from the even row (macOS) or averaged (libyuv).
import { decodeRaw16, toCelsius, frameStats } from './decode.js';

const SIZES = [[80, 60], [160, 120], [256, 192], [384, 288], [512, 384], [640, 512]];
const DIVISOR = 64;

/** A smooth scene from about 15 °C to 45 °C with a warm blob: it crosses many 4 °C (256 raw) steps. */
function scene(width, height) {
  const raw = new Uint16Array(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const u = x / width, v = y / height;
      const blob = 12 * Math.exp(-((u - 0.6) ** 2 + (v - 0.4) ** 2) / 0.02);
      const t = 15 + 18 * u + 6 * Math.sin(v * 9) + blob;
      raw[y * width + x] = Math.round((t + 273.15) * DIVISOR);
    }
  }
  return raw;
}

/** Packs raw temperatures into a browser-style frame. */
function encode(raw, width, rows, format, chroma) {
  const height = rows * 2;
  const ySize = width * height;
  const data = new Uint8Array(ySize + ySize / 2);
  // Top half: the camera's picture (any grey image); bottom half: low bytes.
  for (let r = 0; r < rows; r++) for (let x = 0; x < width; x++) data[r * width + x] = (x + r) & 255;
  for (let r = 0; r < rows; r++) for (let x = 0; x < width; x++) data[(rows + r) * width + x] = raw[r * width + x] & 255;
  const hi = (x, r) => raw[r * width + x] >> 8;
  const pick = (x, k) => {
    // k is the chroma row; it covers frame rows 2k and 2k+1.
    const fr = 2 * k;
    if (fr < rows) return 128; // top half is grey
    const r = fr - rows;
    return chroma === 'even-row' ? hi(x, r) : (hi(x, r) + hi(x, r + 1) + 1) >> 1;
  };
  let layout;
  if (format === 'NV12') {
    for (let k = 0; k < height / 2; k++) for (let x = 0; x < width; x++) data[ySize + k * width + x] = pick(x, k);
    layout = [{ offset: 0, stride: width }, { offset: ySize, stride: width }];
  } else {
    const half = width / 2, uOff = ySize, vOff = ySize + (half * height) / 2;
    for (let k = 0; k < height / 2; k++) {
      for (let i = 0; i < half; i++) {
        data[uOff + k * half + i] = pick(2 * i, k);
        data[vOff + k * half + i] = pick(2 * i + 1, k);
      }
    }
    layout = [{ offset: 0, stride: width }, { offset: uOff, stride: half }, { offset: vOff, stride: half }];
  }
  return { data, layout };
}

let failed = 0;
for (const [width, rows] of SIZES) {
  const truth = scene(width, rows);
  for (const format of ['NV12', 'I420']) {
    for (const chroma of ['even-row', 'averaged']) {
      const { data, layout } = encode(truth, width, rows, format, chroma);
      const out = new Uint16Array(width * rows);
      const result = decodeRaw16(data, layout, format, width, rows * 2, out);
      let wrong = 0, worst = 0;
      for (let i = 0; i < out.length; i++) {
        const err = Math.abs(out[i] - truth[i]) / DIVISOR;
        if (err > 0.01) wrong++;
        worst = Math.max(worst, err);
      }
      const share = wrong / out.length;
      const stats = frameStats(toCelsius(out, DIVISOR, new Float32Array(out.length)), width, rows);
      // Even-row chroma must decode exactly; averaged chroma (untested on hardware) must be nearly exact.
      const ok = result.model === chroma && (chroma === 'even-row' ? wrong === 0 : share < 0.01);
      if (!ok) failed++;
      console.log(`${ok ? 'ok  ' : 'FAIL'} ${width}×${rows} ${format} ${chroma.padEnd(8)} model=${result.model.padEnd(8)} wrong=${(share * 100).toFixed(2)}% worst=${worst.toFixed(2)} °C range=${stats.min.toFixed(1)}..${stats.max.toFixed(1)} °C`);
    }
  }
}

// A warming-up frame (black: Y = 0, chroma = 128) must be reported as empty.
const black = encode(new Uint16Array(256 * 192).fill(128 << 8), 256, 192, 'NV12', 'even-row');
const empty = decodeRaw16(black.data, black.layout, 'NV12', 256, 384, new Uint16Array(256 * 192)).empty;
console.log(`${empty ? 'ok  ' : 'FAIL'} black warm-up frame is reported as empty`);
if (!empty) failed++;

if (failed) {
  console.error(`${failed} thermal decoder check(s) failed`);
  process.exit(1);
}
