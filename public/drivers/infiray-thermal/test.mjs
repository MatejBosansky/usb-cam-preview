#!/usr/bin/env node
// Checks the thermal decoder on synthetic frames of several sensor sizes with known temperatures.
// Each frame is built the way a browser hands it over: an InfiRay-style W×2H YUYV frame converted
// to NV12 or I420, with the chroma row taken from the even row (macOS) or averaged (libyuv).
// Pictures from normal cameras at the same size must be recognised as holding no temperatures.
import { decodeRaw16, toCelsius, checkTemperatures, frameStats } from './decode.js';

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

/** The camera's own picture of the temperatures: their range stretched to 0–255, as its AGC does. */
function picture(raw) {
  let min = Infinity, max = -Infinity;
  for (const v of raw) { min = Math.min(min, v); max = Math.max(max, v); }
  return Uint8Array.from(raw, (v) => (max > min ? Math.round(((v - min) * 255) / (max - min)) : 128));
}

/** Packs the camera's picture and raw temperatures into a browser-style frame. */
function encode(raw, width, rows, format, chroma, pic = picture(raw)) {
  const height = rows * 2;
  const ySize = width * height;
  const data = new Uint8Array(ySize + ySize / 2);
  // Top half: the camera's picture; bottom half: low bytes.
  data.set(pic, 0);
  for (let r = 0; r < rows; r++) for (let x = 0; x < width; x++) data[(rows + r) * width + x] = raw[r * width + x] & 255;
  const hi = (x, r) => raw[r * width + x] >> 8;
  const pick = (x, k) => {
    // k is the chroma row; it covers frame rows 2k and 2k+1.
    const fr = 2 * k;
    if (fr < rows) return 128; // top half is grey
    const r = fr - rows;
    return chroma === 'even-row' ? hi(x, r) : (hi(x, r) + hi(x, r + 1) + 1) >> 1;
  };
  return pack(data, width, height, format, pick);
}

/** Fills the chroma of a frame from pick(x, chromaRow), x counting bytes of an NV12 row (U, V, U, …). */
function pack(data, width, height, format, pick) {
  const ySize = width * height;
  if (format === 'NV12') {
    for (let k = 0; k < height / 2; k++) for (let x = 0; x < width; x++) data[ySize + k * width + x] = pick(x, k);
    return { data, layout: [{ offset: 0, stride: width }, { offset: ySize, stride: width }] };
  }
  const half = width / 2, uOff = ySize, vOff = ySize + (half * height) / 2;
  for (let k = 0; k < height / 2; k++) {
    for (let i = 0; i < half; i++) {
      data[uOff + k * half + i] = pick(2 * i, k);
      data[vOff + k * half + i] = pick(2 * i + 1, k);
    }
  }
  return { data, layout: [{ offset: 0, stride: width }, { offset: uOff, stride: half }, { offset: vOff, stride: half }] };
}

/** Repeatable pseudo-random numbers in [0, 1). */
function random(seed) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Pictures a normal camera might deliver at the W×2H size, as RGB functions of the pixel. */
const PICTURES = {
  // A colourful scene with sensor noise, like the endoscope and microscope.
  webcam: (rnd) => (x, y) => {
    const n = () => (rnd() - 0.5) * 6;
    const box = x > 40 && x < 90 && y > 30 && y < 70 ? 60 : 0;
    return [128 + 80 * Math.sin(x / 23 + y / 41) + box + n(), 120 + 70 * Math.cos(x / 37 - y / 19) + box + n(), 100 + 60 * Math.sin((x + y) / 29) + n()];
  },
  // A dim room: little light, little colour, some noise.
  dark: (rnd) => (x, y) => {
    const base = 12 + 6 * Math.sin(x / 31) * Math.cos(y / 27);
    return [base + (rnd() - 0.5) * 4, base + (rnd() - 0.5) * 4, base + 2 + (rnd() - 0.5) * 4];
  },
  // A noiseless test pattern on black, like Safari's mock cameras.
  pattern: () => (x, y, w, h) => {
    const bars = [[255, 255, 255], [255, 255, 0], [0, 255, 255], [0, 128, 0], [255, 0, 255], [255, 0, 0], [0, 0, 255]];
    if (y > h * 0.55 && y < h * 0.62 && x < w * 0.6) return bars[Math.floor((x / (w * 0.6)) * bars.length)];
    if ((x - w * 0.7) ** 2 + (y - h * 0.25) ** 2 < (w * 0.1) ** 2) return [160, 160, 160];
    if (y > h * 0.1 && y < h * 0.16 && x > w * 0.1 && x < w * 0.45 && (x >> 2) % 2) return [255, 255, 255];
    return [0, 0, 0];
  },
};

/** A normal camera picture (BT.601 YUV, 2×2 chroma) at width × height. */
function normalFrame(width, height, format, rgbAt) {
  const yuv = (x, y) => {
    const [r, g, b] = rgbAt(x, y, width, height).map((c) => Math.max(0, Math.min(255, c)));
    return [16 + (65.481 * r + 128.553 * g + 24.966 * b) / 255, 128 + (-37.797 * r - 74.203 * g + 112 * b) / 255, 128 + (112 * r - 93.786 * g - 18.214 * b) / 255];
  };
  const pixels = [];
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) pixels.push(yuv(x, y));
  const data = new Uint8Array(width * height * 1.5);
  for (let i = 0; i < pixels.length; i++) data[i] = Math.round(pixels[i][0]);
  const chroma = (x, k) => {
    const i = x >> 1, c = (x & 1) + 1; // U for even bytes, V for odd ones
    const at = (dx, dy) => pixels[(2 * k + dy) * width + 2 * i + dx][c];
    return Math.round((at(0, 0) + at(1, 0) + at(0, 1) + at(1, 1)) / 4);
  };
  return pack(data, width, height, format, chroma);
}

/** Decodes a frame and checks whether it holds temperatures. */
function decodeAndCheck({ data, layout }, format, width, rows) {
  const raw = new Uint16Array(width * rows);
  const result = decodeRaw16(data, layout, format, width, rows * 2, raw);
  const temps = toCelsius(raw, DIVISOR, new Float32Array(raw.length));
  return { raw, result, temps, check: checkTemperatures(data, layout, width, rows, temps) };
}

const describe = (c) => `steps=${(c.stepShare * 100).toFixed(2)}% spread=${c.spread.toFixed(1)} °C correlation=${c.correlation.toFixed(2)}`;

let failed = 0;
for (const [width, rows] of SIZES) {
  const truth = scene(width, rows);
  for (const format of ['NV12', 'I420']) {
    for (const chroma of ['even-row', 'averaged']) {
      const { raw: out, result, temps, check } = decodeAndCheck(encode(truth, width, rows, format, chroma), format, width, rows);
      let wrong = 0, worst = 0;
      for (let i = 0; i < out.length; i++) {
        const err = Math.abs(out[i] - truth[i]) / DIVISOR;
        if (err > 0.01) wrong++;
        worst = Math.max(worst, err);
      }
      const share = wrong / out.length;
      const stats = frameStats(temps, width, rows);
      // Even-row chroma must decode exactly; averaged chroma (untested on hardware) must be nearly exact.
      const ok = result.model === chroma && (chroma === 'even-row' ? wrong === 0 : share < 0.01) && check.real;
      if (!ok) failed++;
      console.log(`${ok ? 'ok  ' : 'FAIL'} ${width}×${rows} ${format} ${chroma.padEnd(8)} model=${result.model.padEnd(8)} wrong=${(share * 100).toFixed(2)}% worst=${worst.toFixed(2)} °C range=${stats.min.toFixed(1)}..${stats.max.toFixed(1)} °C real=${check.real} ${describe(check)}`);
    }
  }
}

// Normal cameras at the W×2H size must not pass as temperatures.
for (const [width, rows] of SIZES) {
  for (const format of ['NV12', 'I420']) {
    for (const [name, make] of Object.entries(PICTURES)) {
      const { check } = decodeAndCheck(normalFrame(width, rows * 2, format, make(random(width * rows))), format, width, rows);
      if (check.real) failed++;
      console.log(`${check.real ? 'FAIL' : 'ok  '} ${width}×${rows * 2} ${format} ${name.padEnd(7)} picture holds no temperatures: ${describe(check)}`);
    }
  }
}

// A very even scene is real however its picture looks: there is too little to compare.
{
  const rnd = random(7);
  const even = Uint16Array.from({ length: 256 * 192 }, () => Math.round((22 + (rnd() - 0.5) * 0.2 + 273.15) * DIVISOR));
  const { check } = decodeAndCheck(encode(even, 256, 192, 'NV12', 'even-row', new Uint8Array(256 * 192).fill(128)), 'NV12', 256, 192);
  console.log(`${check.real ? 'ok  ' : 'FAIL'} an even 22 °C scene counts as temperatures: ${describe(check)}`);
  if (!check.real) failed++;
}

// A warming-up frame (black: Y = 0, chroma = 128) must be reported as empty.
const black = encode(new Uint16Array(256 * 192).fill(128 << 8), 256, 192, 'NV12', 'even-row', new Uint8Array(256 * 192));
const empty = decodeRaw16(black.data, black.layout, 'NV12', 256, 384, new Uint16Array(256 * 192)).empty;
console.log(`${empty ? 'ok  ' : 'FAIL'} black warm-up frame is reported as empty`);
if (!empty) failed++;

if (failed) {
  console.error(`${failed} thermal decoder check(s) failed`);
  process.exit(1);
}
