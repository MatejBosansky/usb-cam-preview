// InfiRay-family radiometric thermal cameras (TOOLTOP T256, Topdon TC001, InfiRay P2 Pro, …).
// Their W×2H frame carries the camera's own picture over raw 16-bit temperatures (see decode.js).
// Everything thermal lives in this folder; the app only provides the host services in ctx.
import { PALETTES, paletteLut, temperaturesCsv } from './decode.js';
import { ThermalPipeline, SENSORS } from './pipeline.js';

// Sensor sizes of common thermal cameras, alone and as picture-over-temperature frames.
const THERMAL_MODES = SENSORS.flatMap(([w, h]) => [[w, h], [w, h * 2]]);
const PALETTE_NAMES = { iron: 'Iron', rainbow: 'Rainbow', 'white-hot': 'White hot', 'black-hot': 'Black hot' };
const DEFAULT_PREFS = { palette: 'iron', auto: true, min: 20, max: 40, extremes: true, center: true, burnIn: true };
const SVG = 'http://www.w3.org/2000/svg';
const fmtTemp = (v) => `${v.toFixed(1)} °C`;

export default {
  apiVersion: 1,
  id: 'infiray-thermal',
  name: 'InfiRay thermal',
  description: 'Radiometric thermal cameras with the InfiRay frame layout: the camera\'s picture over 16-bit temperatures (TOOLTOP T256, Topdon TC001, InfiRay P2 Pro).',
  kinds: ['thermal'],
  styles: ['style.css'],
  probeModes: THERMAL_MODES,

  /**
   * Profile options: { divisor } — °C = raw / divisor − 273.15, 64 for the cameras seen so far.
   * The profile's defaultMode is the W×2H mode to expect; without one (the generic profile) the
   * W×2H frame of any known sensor size is accepted.
   */
  validateOptions(options) {
    const errors = [];
    for (const key of Object.keys(options)) if (key !== 'divisor') errors.push(`unknown option "${key}"`);
    if ('divisor' in options && !(typeof options.divisor === 'number' && options.divisor > 0)) errors.push('divisor must be a positive number');
    return errors;
  },

  /** A thermal camera that offers both W×H and W×2H is most likely InfiRay-style. */
  suggest({ kind, modes }) {
    if (kind !== 'thermal') return null;
    const mode = modes.find((m) => modes.some((n) => n.width === m.width && n.height * 2 === m.height));
    return mode ? { options: { divisor: 64 }, defaultMode: mode } : null;
  },

  create(ctx) {
    return new ThermalView(ctx);
  },
};

class ThermalView {
  constructor(ctx) {
    this.ctx = ctx;
    this.prefs = ctx.prefs.get(DEFAULT_PREFS);
    this.pipeline = new ThermalPipeline({ divisor: ctx.options.divisor ?? 64 }, ctx.profile.defaultMode);
    this.last = null; // last pipeline result
    this.fits = true; // the stream is the W×2H mode that carries temperatures
    this.seenFrame = false;
    this.size = null; // the stream's width and height
    this.pointerInfo = null;
    this.buildPanel();
    this.buildLayers();
    this.syncControls();
  }

  // ---------- host hooks ----------

  async processFrame(video) {
    this.seenFrame = true;
    this.size = [video.videoWidth, video.videoHeight];
    this.fits = this.pipeline.fits(video);
    if (!this.fits) {
      this.last = null;
      return null; // show the video as it is
    }
    this.last = await this.pipeline.process(video, this.prefs);
    return this.last.image ?? null; // no image: show the video as it is
  }

  layout() {
    this.renderMarks();
    this.renderLegend();
    this.renderTip();
    this.renderStatus();
  }

  hud() {
    const res = this.last;
    if (this.seenFrame && !this.fits) return 'No temperature data';
    if (!res) return '';
    if (res.status === 'warming') return 'The thermal camera is warming up…';
    if (res.status === 'no-data') return 'No temperature data';
    if (res.status !== 'ok') return '';
    const center = this.centerTemp();
    const parts = [];
    if (this.prefs.center && center != null) parts.push(`⌖ ${fmtTemp(center)}`);
    parts.push(`▲ ${fmtTemp(res.stats.max)}`, `▼ ${fmtTemp(res.stats.min)}`);
    if (res.settling) parts.push('settling…');
    return parts.join(' · ');
  }

  pointer(info) {
    this.pointerInfo = info;
    this.renderTip();
  }

  photo(canvas) {
    return this.prefs.burnIn && this.ready() ? this.composePhoto(canvas) : null;
  }

  // ---------- state ----------

  ready() {
    return this.fits && this.last?.status === 'ok';
  }

  set(patch) {
    Object.assign(this.prefs, patch);
    this.ctx.prefs.set(this.prefs);
    this.syncControls();
    // A frozen frame is not decoded again, so recolour the temperatures we have.
    if (this.ctx.isFrozen() && this.ready()) {
      Object.assign(this.last, this.pipeline.recolor(this.prefs, this.last.stats));
      this.ctx.show(this.last.image);
    }
    this.ctx.refresh();
  }

  tempAt({ x, y }) {
    const res = this.last;
    const col = Math.floor(x), row = Math.floor(y);
    if (!res?.temps || col < 0 || row < 0 || col >= res.width || row >= res.height) return null;
    return res.temps[row * res.width + col];
  }

  /** Temperature under the crosshair in the middle of the view (follows zoom and pan). */
  centerTemp() {
    const { width, height } = this.ctx.frameSize();
    return this.tempAt(this.ctx.frameToSource(width / 2, height / 2));
  }

  // ---------- panel ----------

  buildPanel() {
    const panel = this.ctx.panel;
    panel.innerHTML = `
      <h3>Thermal camera</h3>
      <p class="muted small">Temperature data: InfiRay format (the camera's picture over 16-bit temperatures, as InfiRay P2 Pro and Topdon TC001).</p>
      <div class="chips" data-ref="palettes"></div>
      <div class="field block">
        <span>Color range</span>
        <div class="segmented" role="group">
          <button type="button" data-ref="auto">Auto</button>
          <button type="button" data-ref="manual">Manual</button>
        </div>
      </div>
      <div class="row">
        <label class="field"><span>Min °C</span><input data-ref="min" type="number" step="0.5"></label>
        <label class="field"><span>Max °C</span><input data-ref="max" type="number" step="0.5"></label>
      </div>
      <p class="muted small">Auto follows the scene. Manual keeps the colors fixed, so the same color always means the same temperature. Typing a value switches to Manual.</p>
      <label class="check"><input type="checkbox" data-ref="extremes"><span>Mark the hottest and coldest point</span></label>
      <label class="check"><input type="checkbox" data-ref="center"><span>Show the temperature at the center</span></label>
      <label class="check"><input type="checkbox" data-ref="burnIn"><span>Draw the temperatures and the legend into photos</span></label>
      <button type="button" class="btn small" data-ref="csv" disabled>Export temperatures (CSV)</button>
      <p class="muted small" data-ref="status" aria-live="polite"></p>`;
    const r = this.refs = Object.fromEntries([...panel.querySelectorAll('[data-ref]')].map((el) => [el.dataset.ref, el]));

    r.palettes.append(...PALETTES.map((name) => {
      const b = Object.assign(document.createElement('button'), { type: 'button', className: 'chip', textContent: PALETTE_NAMES[name] || name });
      b.dataset.palette = name;
      b.addEventListener('click', () => this.set({ palette: name }));
      return b;
    }));
    r.auto.addEventListener('click', () => this.set({ auto: true }));
    r.manual.addEventListener('click', () => {
      // Manual starts from the range currently on screen.
      const range = this.last?.range;
      this.set(this.prefs.auto && range ? { auto: false, min: Math.floor(range[0]), max: Math.ceil(range[1]) } : { auto: false });
    });
    // Typing a value fixes the range, keeping the other field as shown.
    const typed = () => {
      const a = Number(r.min.value), b = Number(r.max.value);
      if (r.min.value === '' || r.max.value === '' || !Number.isFinite(a) || !Number.isFinite(b)) return this.syncControls();
      const min = Math.min(a, b);
      this.set({ auto: false, min, max: b > a ? b : min + 1 });
    };
    r.min.addEventListener('change', typed);
    r.max.addEventListener('change', typed);
    for (const key of ['extremes', 'center', 'burnIn']) r[key].addEventListener('change', () => this.set({ [key]: r[key].checked }));
    r.csv.addEventListener('click', () => this.exportCsv().catch((e) => this.ctx.toast(e.message)));
  }

  syncControls() {
    const { refs: r, prefs } = this;
    for (const chip of r.palettes.children) chip.setAttribute('aria-pressed', String(chip.dataset.palette === prefs.palette));
    r.auto.setAttribute('aria-pressed', String(prefs.auto));
    r.manual.setAttribute('aria-pressed', String(!prefs.auto));
    if (!prefs.auto) {
      r.min.value = prefs.min;
      r.max.value = prefs.max;
    }
    r.extremes.checked = prefs.extremes;
    r.center.checked = prefs.center;
    r.burnIn.checked = prefs.burnIn;
    const lut = paletteLut(prefs.palette);
    const stops = Array.from({ length: 9 }, (_, i) => {
      const k = Math.round((i * 255) / 8) * 3;
      return `rgb(${lut[k]} ${lut[k + 1]} ${lut[k + 2]}) ${i * 12.5}%`;
    });
    this.legendBar.style.background = `linear-gradient(to right, ${stops.join(', ')})`;
  }

  renderStatus() {
    const { refs: r, last: res } = this;
    let status = '';
    if (this.seenFrame && !this.fits) {
      status = this.wrongSizeMessage();
    } else if (res?.status === 'warming') {
      status = 'The thermal camera is warming up…';
    } else if (res?.status === 'no-data') {
      status = 'This camera sends no temperature data, so none are shown: its picture is not in the InfiRay thermal format. Check the Camera type at the top.';
    } else if (res?.status === 'image-only') {
      status = 'This browser does not expose the temperature data, so only the camera\'s own picture is shown. Use Chrome or Edge for temperatures.';
    } else if (res?.status === 'ok') {
      status = res.model === 'averaged'
        ? 'This browser delivers the temperature data differently than tested so far; readings may be off by 4 °C in places. Please report your OS and browser.'
        : res.settling
          ? 'Readings can still shift for the first few seconds while the camera calibrates itself.'
          : 'Point at the image to read the temperature anywhere.';
    }
    r.status.textContent = status;
    const ready = this.ready();
    r.csv.disabled = !ready;
    const editing = document.activeElement === r.min || document.activeElement === r.max;
    if (this.prefs.auto && !editing) {
      // Without temperatures there is no range to show.
      r.min.value = ready ? res.range[0].toFixed(1) : '';
      r.max.value = ready ? res.range[1].toFixed(1) : '';
    }
  }

  wrongSizeMessage() {
    const m = this.ctx.profile.defaultMode;
    if (m) return `Temperatures need the ${m.width}×${m.height} resolution (Camera tab).`;
    const [w, h] = this.size;
    if (SENSORS.some(([sw, sh]) => sw === w && sh === h)) {
      return `This ${w}×${h} picture holds no temperatures; they come at ${w}×${h * 2}: pick it in the Camera tab (run the compatibility test if it is not listed).`;
    }
    return `A ${w}×${h} picture is not an InfiRay thermal frame (such as 256×384 for a 256×192 sensor), so no temperatures are shown. Check the Camera type at the top.`;
  }

  // ---------- marks, legend and pointer readout ----------

  buildLayers() {
    this.marks = document.createElementNS(SVG, 'svg');
    this.marks.setAttribute('class', 'thermal-marks');
    this.ctx.frameLayer.append(this.marks);
    this.legend = Object.assign(document.createElement('div'), { className: 'thermal-legend', hidden: true });
    this.legendLo = document.createElement('span');
    this.legendBar = Object.assign(document.createElement('span'), { className: 'bar' });
    this.legendHi = document.createElement('span');
    this.legend.append(this.legendLo, this.legendBar, this.legendHi);
    this.tip = Object.assign(document.createElement('div'), { className: 'thermal-tip', hidden: true });
    this.ctx.viewerLayer.append(this.legend, this.tip);
  }

  renderMarks() {
    const { width: w, height: h } = this.ctx.frameSize();
    this.marks.setAttribute('viewBox', `0 0 ${w} ${h}`);
    if (!this.ready()) {
      this.marks.innerHTML = '';
      return;
    }
    const { stats } = this.last;
    const parts = [];
    const label = (x, y, text) => {
      const tx = x + 10 + 64 > w ? x - 74 : x + 10;
      return `<text x="${tx}" y="${Math.max(12, Math.min(h - 4, y + 4))}">${text}</text>`;
    };
    const mark = (at, cls, value) => {
      const p = this.ctx.sourceToFrame(at.x + 0.5, at.y + 0.5);
      if (p.x < 0 || p.y < 0 || p.x > w || p.y > h) return;
      parts.push(`<g class="${cls}"><circle cx="${p.x}" cy="${p.y}" r="6"/>${label(p.x, p.y, fmtTemp(value))}</g>`);
    };
    if (this.prefs.extremes) {
      mark(stats.maxAt, 'hot', stats.max);
      mark(stats.minAt, 'cold', stats.min);
    }
    const center = this.centerTemp();
    if (this.prefs.center && center != null) {
      const x = w / 2, y = h / 2;
      parts.push(`<g class="center"><path d="M${x - 11} ${y}h7M${x + 4} ${y}h7M${x} ${y - 11}v7M${x} ${y + 4}v7"/>${label(x + 2, y - 12, fmtTemp(center))}</g>`);
    }
    this.marks.innerHTML = parts.join('');
  }

  renderLegend() {
    const ready = this.ready();
    this.legend.hidden = !ready;
    if (!ready) return;
    this.legendLo.textContent = fmtTemp(this.last.range[0]);
    this.legendHi.textContent = fmtTemp(this.last.range[1]);
  }

  renderTip() {
    const info = this.pointerInfo;
    const value = info && this.ready() ? this.tempAt({ x: info.sourceX, y: info.sourceY }) : null;
    if (value == null) {
      this.tip.hidden = true;
      return;
    }
    this.tip.textContent = fmtTemp(value);
    this.tip.style.left = `${info.viewerX + 14}px`;
    this.tip.style.top = `${info.viewerY + 14}px`;
    this.tip.hidden = false;
  }

  // ---------- photos and data ----------

  /**
   * The current view, enlarged, with the hottest and coldest point, the centre reading and a
   * colour legend drawn in: what the screen shows, as one picture.
   */
  composePhoto(src) {
    const { stats, range } = this.last;
    const scale = Math.max(1, Math.round(1024 / Math.max(src.width, src.height)));
    const w = src.width * scale, h = src.height * scale;
    const canvas = Object.assign(document.createElement('canvas'), { width: w, height: h });
    const g = canvas.getContext('2d');
    g.imageSmoothingEnabled = true;
    g.imageSmoothingQuality = 'high';
    g.drawImage(src, 0, 0, w, h);

    const fs = Math.max(12, Math.round(Math.min(w, h) * 0.032));
    g.font = `600 ${fs}px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace`;
    g.textBaseline = 'middle';
    g.lineJoin = 'round';
    const text = (str, x, y, align) => {
      g.textAlign = align;
      g.lineWidth = fs * 0.25;
      g.strokeStyle = 'rgb(0 0 0 / 0.85)';
      g.strokeText(str, x, y);
      g.fillStyle = '#fff';
      g.fillText(str, x, y);
    };
    const label = (x, y, str) => {
      const right = x + fs * 0.8 + g.measureText(str).width < w;
      text(str, right ? x + fs * 0.8 : x - fs * 0.8, Math.min(h - fs, Math.max(fs, y)), right ? 'left' : 'right');
    };
    const outlined = (color, width) => {
      g.lineWidth = width * 2.2;
      g.strokeStyle = 'rgb(0 0 0 / 0.7)';
      g.stroke();
      g.lineWidth = width;
      g.strokeStyle = color;
      g.stroke();
    };

    if (this.prefs.extremes) {
      for (const [at, color, value] of [[stats.maxAt, '#ff3b30', stats.max], [stats.minAt, '#3fa9ff', stats.min]]) {
        const p = this.ctx.sourceToFrame(at.x + 0.5, at.y + 0.5, w, h);
        if (p.x < 0 || p.y < 0 || p.x > w || p.y > h) continue;
        g.beginPath();
        g.arc(p.x, p.y, fs * 0.45, 0, Math.PI * 2);
        outlined(color, fs * 0.14);
        label(p.x, p.y, fmtTemp(value));
      }
    }

    const center = this.tempAt(this.ctx.frameToSource(w / 2, h / 2, w, h));
    if (this.prefs.center && center != null) {
      const x = w / 2, y = h / 2, arm = fs * 0.9, gap = fs * 0.3;
      g.beginPath();
      g.moveTo(x - arm, y); g.lineTo(x - gap, y);
      g.moveTo(x + gap, y); g.lineTo(x + arm, y);
      g.moveTo(x, y - arm); g.lineTo(x, y - gap);
      g.moveTo(x, y + gap); g.lineTo(x, y + arm);
      outlined('#fff', fs * 0.12);
      label(x + fs * 0.2, y - fs * 1.1, fmtTemp(center));
    }

    // Legend in the bottom right corner: low end, palette bar, high end.
    const lo = fmtTemp(range[0]), hi = fmtTemp(range[1]);
    const pad = Math.round(fs * 0.5), barW = Math.round(w * 0.28), barH = Math.round(fs * 0.6);
    const loW = g.measureText(lo).width, hiW = g.measureText(hi).width;
    const boxW = loW + barW + hiW + pad * 4, boxH = fs + pad * 2;
    const bx = w - boxW - pad, by = h - boxH - pad, cy = by + boxH / 2;
    g.fillStyle = 'rgb(0 0 0 / 0.6)';
    g.beginPath();
    if (g.roundRect) g.roundRect(bx, by, boxW, boxH, pad * 0.8);
    else g.rect(bx, by, boxW, boxH);
    g.fill();
    g.fillStyle = '#fff';
    g.textAlign = 'left';
    g.fillText(lo, bx + pad, cy);
    const gx = bx + pad * 2 + loW;
    const lut = paletteLut(this.prefs.palette);
    const gradient = g.createLinearGradient(gx, 0, gx + barW, 0);
    for (let i = 0; i <= 16; i++) {
      const k = Math.round((i * 255) / 16) * 3;
      gradient.addColorStop(i / 16, `rgb(${lut[k]} ${lut[k + 1]} ${lut[k + 2]})`);
    }
    g.fillStyle = gradient;
    g.fillRect(gx, cy - barH / 2, barW, barH);
    g.fillStyle = '#fff';
    g.fillText(hi, gx + barW + pad, cy);
    return canvas;
  }

  /** The current temperature map as CSV, one row per sensor row, in °C. */
  async exportCsv() {
    if (!this.ready()) return;
    const { temps, width, height } = this.last;
    const blob = new Blob([temperaturesCsv(temps, width, height)], { type: 'text/csv' });
    await this.ctx.saveFile(blob, this.ctx.fileName('temperatures', 'csv'));
    this.ctx.toast('Temperatures saved');
  }
}
