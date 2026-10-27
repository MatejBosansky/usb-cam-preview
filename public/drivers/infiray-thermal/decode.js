// Radiometric thermal cameras with the InfiRay layout (TOOLTOP, Topdon TC001, InfiRay P2 Pro, …).
//
// The camera sends a W×2H YUYV frame. The top half is the camera's own 8-bit picture; the bottom
// half holds one little-endian uint16 per pixel, Kelvin × divisor. In YUYV the low byte of each
// value lands in Y, the high byte in U (even pixels) or V (odd pixels).
//
// Browsers hand frames over as NV12 or I420: Y survives untouched, but there is only one chroma
// row per two pixel rows, so each high byte is shared by a row pair. macOS takes that chroma from
// the even row (measured with a TOOLTOP T256), so even rows are exact and the odd row's high byte
// is rebuilt from the exact rows above and below. Converters that average the two rows instead
// (libyuv does) are detected and decoded per pair; that path has not been tested on hardware.

export const KELVIN = 273.15;

/** High byte of pixel x in full-frame row r, for NV12 or I420 chroma. */
function chromaReader(data, layout, format) {
  if (format === 'NV12') {
    const { offset, stride } = layout[1];
    return (x, r) => data[offset + (r >> 1) * stride + x];
  }
  const u = layout[1], v = layout[2];
  return (x, r) => (x & 1 ? data[v.offset + (r >> 1) * v.stride + (x >> 1)] : data[u.offset + (r >> 1) * u.stride + (x >> 1)]);
}

/**
 * Reads the raw half of a frame copied with VideoFrame.copyTo().
 * Fills out (Uint16Array, width × height/2) and returns the decoding model used and whether the
 * frame holds data at all (the camera sends zeros while it warms up).
 */
export function decodeRaw16(data, layout, format, width, height, out, model = 'auto') {
  const rows = height >> 1;
  const y = layout[0];
  const hiAt = chromaReader(data, layout, format);
  const loAt = (x, r) => data[y.offset + r * y.stride + x];

  // Naive decode: every row takes the chroma of its pair.
  let min = 65535, max = 0;
  for (let r = 0; r < rows; r++) {
    const fr = rows + r;
    for (let x = 0; x < width; x++) {
      const v = hiAt(x, fr) * 256 + loAt(x, fr);
      out[r * width + x] = v;
      if (v < min) min = v;
      if (v > max) max = v;
    }
  }
  // While warming up the camera sends a black frame (one value everywhere, 32768 after YUV conversion).
  if (min === max) return { model, empty: true, confident: false };

  let confident = model !== 'auto';
  if (model === 'auto') ({ model, confident } = detectModel(out, width, rows));

  if (model === 'even-row') {
    for (let r = 1; r < rows; r += 2) {
      for (let x = 0; x < width; x++) {
        const above = out[(r - 1) * width + x];
        const below = r + 1 < rows ? out[(r + 1) * width + x] : above;
        out[r * width + x] = nearestWithLowByte((above + below) / 2, loAt(x, rows + r));
      }
    }
  } else {
    // Averaged chroma: choose the pair of high bytes, consistent with the average, that makes
    // the two rows most alike.
    for (let r = 0; r + 1 < rows; r += 2) {
      for (let x = 0; x < width; x++) {
        const h = hiAt(x, rows + r);
        const lt = loAt(x, rows + r), lb = loAt(x, rows + r + 1);
        let best = [h, h], bestDiff = Math.abs(lt - lb);
        for (const [ht, hb] of [[h - 1, h], [h, h - 1]]) {
          const diff = Math.abs(ht * 256 + lt - (hb * 256 + lb));
          if (ht >= 0 && hb >= 0 && diff < bestDiff) { best = [ht, hb]; bestDiff = diff; }
        }
        out[r * width + x] = best[0] * 256 + lt;
        out[(r + 1) * width + x] = best[1] * 256 + lb;
      }
    }
  }
  return { model, empty: false, confident };
}

/** The value closest to ref whose low byte is lo. */
function nearestWithLowByte(ref, lo) {
  const hi = Math.max(0, Math.round((ref - lo) / 256));
  return hi * 256 + lo;
}

/**
 * Counts jumps of about 256 (one high-byte step) between horizontal neighbours in even and odd
 * rows of a naive decode. With even-row chroma the odd rows carry almost all of them.
 */
export function detectModel(values, width, rows) {
  let even = 0, odd = 0;
  for (let r = 0; r < rows; r++) {
    let n = 0;
    for (let x = 1; x < width; x++) {
      const d = Math.abs(values[r * width + x] - values[r * width + x - 1]);
      if (d >= 160 && d <= 352) n++;
    }
    if (r & 1) odd += n; else even += n;
  }
  // Too few jumps to tell (a scene within one 4 °C step): even-row is right for macOS and harmless otherwise.
  if (odd + even < 40) return { model: 'even-row', confident: false };
  return { model: odd > even * 3 ? 'even-row' : 'averaged', confident: true };
}

export function toCelsius(raw, divisor, out) {
  for (let i = 0; i < raw.length; i++) out[i] = raw[i] / divisor - KELVIN;
  return out;
}

const STEP = 2; // °C between horizontal neighbours that counts as a step
const MAX_STEPS = 0.3; // share of neighbours a step apart that temperatures never reach
const MIN_SPREAD = 1; // °C standard deviation; a more even scene is too flat to compare with the picture
const MIN_CORRELATION = 0.3;

/**
 * Whether decoded temperatures are real. Any camera at the W×2H size decodes to numbers, e.g. a
 * normal camera under the wrong camera type or scaled by the browser, but then they mean nothing.
 * Two checks, both with wide margins on frames measured with a TOOLTOP T256, an endoscope and a
 * microscope in Chrome and Firefox:
 * - temperatures change smoothly: real frames had 0.01 % of neighbours 2 °C or more apart, a
 *   normal picture decoded the same way 66–94 %;
 * - the top half is the camera's own picture of the same temperatures, so whenever the scene
 *   has some contrast the two correlate (0.97–0.99 measured; unrelated pictures ≈ 0).
 * A very even scene with an unrelated picture cannot be told apart and counts as real.
 */
export function checkTemperatures(data, layout, width, rows, temps) {
  const y = layout[0];
  let steps = 0, sp = 0, st = 0, spp = 0, stt = 0, spt = 0;
  for (let r = 0; r < rows; r++) {
    const row = r * width, picRow = y.offset + r * y.stride;
    for (let x = 0; x < width; x++) {
      const t = temps[row + x], p = data[picRow + x];
      if (x && Math.abs(t - temps[row + x - 1]) >= STEP) steps++;
      sp += p; st += t; spp += p * p; stt += t * t; spt += p * t;
    }
  }
  const n = width * rows;
  const varP = spp / n - (sp / n) ** 2, varT = stt / n - (st / n) ** 2;
  const stepShare = steps / (rows * (width - 1));
  const spread = Math.sqrt(Math.max(0, varT));
  const correlation = varP > 0 && varT > 0 ? (spt / n - (sp / n) * (st / n)) / Math.sqrt(varP * varT) : 0;
  const real = stepShare <= MAX_STEPS && (spread < MIN_SPREAD || Math.abs(correlation) >= MIN_CORRELATION);
  return { real, stepShare, spread, correlation };
}

export function frameStats(temps, width, height) {
  let min = Infinity, max = -Infinity, minAt = 0, maxAt = 0;
  for (let i = 0; i < temps.length; i++) {
    const t = temps[i];
    if (t < min) { min = t; minAt = i; }
    if (t > max) { max = t; maxAt = i; }
  }
  const cx = width >> 1, cy = height >> 1;
  const center = (temps[cy * width + cx] + temps[cy * width + cx - 1] + temps[(cy - 1) * width + cx] + temps[(cy - 1) * width + cx - 1]) / 4;
  return {
    min, max, center,
    minAt: { x: minAt % width, y: Math.floor(minAt / width) },
    maxAt: { x: maxAt % width, y: Math.floor(maxAt / width) },
  };
}

// ---------- palettes ----------

const STOPS = {
  iron: [[0, 0, 0], [25, 0, 85], [95, 0, 140], [170, 20, 110], [215, 60, 40], [245, 125, 0], [255, 200, 20], [255, 250, 210]],
  rainbow: [[20, 0, 120], [0, 60, 255], [0, 200, 255], [0, 220, 90], [190, 240, 0], [255, 170, 0], [255, 40, 0], [170, 0, 0]],
  'white-hot': [[0, 0, 0], [255, 255, 255]],
  'black-hot': [[255, 255, 255], [0, 0, 0]],
};
export const PALETTES = Object.keys(STOPS);

const luts = new Map();
/** 256 × RGB lookup table, interpolated from the palette's colour stops. */
export function paletteLut(name) {
  if (luts.has(name)) return luts.get(name);
  const stops = STOPS[name] || STOPS.iron;
  const lut = new Uint8Array(256 * 3);
  for (let i = 0; i < 256; i++) {
    const pos = (i / 255) * (stops.length - 1);
    const k = Math.min(stops.length - 2, Math.floor(pos));
    const f = pos - k;
    for (let c = 0; c < 3; c++) lut[i * 3 + c] = Math.round(stops[k][c] + (stops[k + 1][c] - stops[k][c]) * f);
  }
  luts.set(name, lut);
  return lut;
}

/** Maps temperatures in [lo, hi] through a palette into RGBA pixels. */
export function colorizeTemps(temps, lo, hi, lut, rgba) {
  const scale = hi > lo ? 255 / (hi - lo) : 0;
  for (let i = 0, j = 0; i < temps.length; i++, j += 4) {
    let v = Math.round((temps[i] - lo) * scale);
    v = v < 0 ? 0 : v > 255 ? 255 : v;
    rgba[j] = lut[v * 3];
    rgba[j + 1] = lut[v * 3 + 1];
    rgba[j + 2] = lut[v * 3 + 2];
    rgba[j + 3] = 255;
  }
}

/** Maps an 8-bit grey picture (the camera's own image) through a palette, in place. */
export function colorizeGray(rgba, lut) {
  for (let j = 0; j < rgba.length; j += 4) {
    const v = rgba[j];
    rgba[j] = lut[v * 3];
    rgba[j + 1] = lut[v * 3 + 1];
    rgba[j + 2] = lut[v * 3 + 2];
    rgba[j + 3] = 255;
  }
}

export function temperaturesCsv(temps, width, height) {
  const lines = [];
  for (let r = 0; r < height; r++) {
    const row = new Array(width);
    for (let x = 0; x < width; x++) row[x] = temps[r * width + x].toFixed(2);
    lines.push(row.join(','));
  }
  return `${lines.join('\n')}\n`;
}
