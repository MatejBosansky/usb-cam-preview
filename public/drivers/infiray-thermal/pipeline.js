// Turns video frames from a thermal camera into a colourised image plus a temperature map.
import { decodeRaw16, toCelsius, checkTemperatures, frameStats, paletteLut, colorizeTemps, colorizeGray } from './decode.js';

const MIN_SPAN = 2; // °C; a narrower auto range would only amplify sensor noise
// The TOOLTOP T256 shifts all readings by about 5 °C some 6 s after it starts sending data,
// presumably its own calibration. Readings are flagged as settling until then.
const SETTLE_MS = 8000;
// Frames in a row that switch between temperatures and 'no-data', so a stray frame changes nothing.
const NO_DATA_FRAMES = 3;
const DATA_FRAMES = 25;

export class ThermalPipeline {
  /** spec is a profile's thermal block, mode the W×2H mode it needs. */
  constructor(spec, mode) {
    this.divisor = spec.divisor || 64;
    this.mode = mode;
    this.model = 'auto';
    this.rawReadable = typeof VideoFrame !== 'undefined';
    this.buf = null;
    this.range = null;
    this.noData = null; // not decided yet
    this.flips = 0;
    this.width = 0;
    this.rows = 0;
  }

  /** True when the stream is the W×2H mode that carries temperatures. */
  fits(video) {
    return !!this.mode && video.videoWidth === this.mode.width && video.videoHeight === this.mode.height;
  }

  ensure(width, rows) {
    if (this.width === width && this.rows === rows) return;
    this.width = width;
    this.rows = rows;
    this.raw = new Uint16Array(width * rows);
    this.temps = new Float32Array(width * rows);
    this.image = new ImageData(width, rows);
    this.canvas = Object.assign(document.createElement('canvas'), { width, height: rows });
    this.ctx = this.canvas.getContext('2d', { willReadFrequently: true });
  }

  /**
   * Resolves to { status, image, temps?, stats?, range? }.
   * status: 'ok' (temperatures), 'warming' (camera still sends empty frames), 'no-data' (the
   * frame holds no temperatures, e.g. a normal camera; no image, the video is shown as it is) or
   * 'image-only' (this browser does not expose the raw frame, so only the camera's picture).
   */
  async process(video, { palette, auto, min, max }) {
    const width = video.videoWidth, rows = video.videoHeight >> 1;
    this.ensure(width, rows);
    const lut = paletteLut(palette);

    if (this.rawReadable) {
      let frame = null;
      try {
        frame = new VideoFrame(video);
        if (frame.format === 'NV12' || frame.format === 'I420') {
          const size = frame.allocationSize();
          if (!this.buf || this.buf.length < size) this.buf = new Uint8Array(size);
          const layout = await frame.copyTo(this.buf);
          const result = decodeRaw16(this.buf, layout, frame.format, width, rows * 2, this.raw, this.model);
          if (result.empty) {
            this.firstDataAt = 0;
            return { status: 'warming', image: this.cameraPicture(video, lut) };
          }
          toCelsius(this.raw, this.divisor, this.temps);
          if (this.follow(checkTemperatures(this.buf, layout, width, rows, this.temps).real)) {
            this.firstDataAt = 0;
            return { status: 'no-data' };
          }
          if (result.confident) this.model = result.model;
          if (!this.firstDataAt) this.firstDataAt = performance.now();
          const stats = frameStats(this.temps, width, rows);
          const range = auto ? this.autoRange(stats) : [min, max];
          colorizeTemps(this.temps, range[0], range[1], lut, this.image.data);
          const settling = performance.now() - this.firstDataAt < SETTLE_MS;
          return { status: 'ok', image: this.image, temps: this.temps, stats, range, width, height: rows, model: result.model, settling };
        }
        // RGB frames: the raw half went through colour conversion and cannot be decoded.
        this.rawReadable = false;
      } catch (err) {
        console.warn('Thermal: cannot read raw frames, showing the camera picture only', err);
        this.rawReadable = false;
      } finally {
        frame?.close();
      }
    }
    return { status: 'image-only', image: this.cameraPicture(video, lut) };
  }

  /** Tracks whether the stream holds temperatures; true while it does not. */
  follow(real) {
    if (this.noData === null) this.noData = !real; // the stream's first frame decides at once
    // Then count the frames in a row whose check disagrees with the current state.
    this.flips = real === this.noData ? this.flips + 1 : 0;
    if (this.flips >= (this.noData ? DATA_FRAMES : NO_DATA_FRAMES)) {
      this.noData = !this.noData;
      this.flips = 0;
    }
    return this.noData;
  }

  /** Recolours the last decoded temperatures, e.g. after a palette change on a frozen frame. */
  recolor({ palette, auto, min, max }, stats) {
    const range = auto ? this.autoRange(stats) : [min, max];
    colorizeTemps(this.temps, range[0], range[1], paletteLut(palette), this.image.data);
    return { image: this.image, range };
  }

  /** The camera's own 8-bit picture (top half of the frame) through the palette. */
  cameraPicture(video, lut) {
    this.ctx.drawImage(video, 0, 0, this.width, this.rows, 0, 0, this.width, this.rows);
    const img = this.ctx.getImageData(0, 0, this.width, this.rows);
    colorizeGray(img.data, lut);
    return img;
  }

  /** Follows the scene's min and max smoothly so the colours do not flicker. */
  autoRange({ min, max }) {
    // Start fresh, and jump instead of easing when the scene leaves the current range entirely.
    if (!this.range || min > this.range[1] || max < this.range[0]) this.range = [min, max];
    else {
      this.range[0] += (min - this.range[0]) * 0.25;
      this.range[1] += (max - this.range[1]) * 0.25;
    }
    let [lo, hi] = this.range;
    if (hi - lo < MIN_SPAN) {
      const mid = (lo + hi) / 2;
      lo = mid - MIN_SPAN / 2;
      hi = mid + MIN_SPAN / 2;
    }
    return [lo, hi];
  }
}
