// Photos, video recording, the in-page gallery and saving straight to a folder.

const RECORDER_TYPES = [
  'video/mp4;codecs=avc1.640033',
  'video/mp4;codecs=avc1.4d0033',
  'video/mp4;codecs=avc1',
  'video/mp4',
  'video/webm;codecs=vp9',
  'video/webm;codecs=vp8',
  'video/webm',
];

/** Best supported recording format (MP4 when the browser can, WebM otherwise); null if recording is impossible. */
export function pickRecorderType() {
  if (!('MediaRecorder' in window) || !HTMLCanvasElement.prototype.captureStream) return null;
  return RECORDER_TYPES.find((t) => MediaRecorder.isTypeSupported(t)) ?? '';
}

export function stampName(prefix, ext) {
  const d = new Date();
  const p = (n, l = 2) => String(n).padStart(l, '0');
  return `${prefix}-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}-${p(d.getMilliseconds(), 3)}.${ext}`;
}

export function canvasToBlob(canvas, type, quality) {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('Could not encode the image'))), type, quality);
  });
}

export function downloadBlob(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = Object.assign(document.createElement('a'), { href: url, download: name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

export function formatBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(0)} kB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(2)} GB`;
}

export class Gallery {
  constructor(onChange) {
    this.items = [];
    this.onChange = onChange;
    this.seq = 0;
  }

  add({ blob, name, kind, savedToFolder = false }) {
    const item = { id: ++this.seq, blob, name, kind, savedToFolder, size: blob.size, url: URL.createObjectURL(blob) };
    this.items.unshift(item);
    this.onChange();
    return item;
  }

  remove(id) {
    const i = this.items.findIndex((x) => x.id === id);
    if (i < 0) return;
    URL.revokeObjectURL(this.items[i].url);
    this.items.splice(i, 1);
    this.onChange();
  }
}

/** File System Access API (Chrome, Edge): write captures straight into a folder the user picks. */
export const folder = {
  handle: null,
  get supported() {
    return 'showDirectoryPicker' in window;
  },
  async choose() {
    this.handle = await window.showDirectoryPicker({ id: 'usb-cam-preview', mode: 'readwrite', startIn: 'pictures' });
    return this.handle;
  },
  async write(name, blob) {
    const file = await this.handle.getFileHandle(name, { create: true });
    const writable = await file.createWritable();
    await writable.write(blob);
    await writable.close();
  },
  async open(name) {
    const fileHandle = await this.handle.getFileHandle(name, { create: true });
    return { fileHandle, writable: await fileHandle.createWritable() };
  },
};

// Video encoders, phones' in particular, often refuse pictures much larger than 1080p (a Galaxy S23
// recorded nothing at 3000×4000), so bigger pictures are recorded from a scaled copy. Photos keep
// the full resolution.
const MAX_VIDEO_LONG = 1920;
const MAX_VIDEO_SHORT = 1080;

/**
 * Records a canvas. With a folder target the data is streamed to disk every second,
 * so long recordings do not have to fit in memory. Call frame() after each new picture is drawn.
 */
export class Recorder {
  constructor(source, { type, fps, target = null }) {
    this.source = source;
    const long = Math.max(source.width, source.height), short = Math.min(source.width, source.height);
    const scale = Math.min(1, MAX_VIDEO_LONG / long, MAX_VIDEO_SHORT / short);
    if (scale < 1) {
      const even = (n) => Math.max(2, Math.round((n * scale) / 2) * 2); // encoders want even sizes
      this.canvas = Object.assign(document.createElement('canvas'), { width: even(source.width), height: even(source.height) });
      this.ctx = this.canvas.getContext('2d');
      this.frame();
    } else {
      this.canvas = source;
      this.ctx = null;
    }
    const canvas = this.canvas;
    this.stream = canvas.captureStream(fps);
    const pixels = canvas.width * canvas.height * fps;
    const options = { videoBitsPerSecond: Math.round(Math.min(16e6, Math.max(1.5e6, pixels * 0.2))) };
    if (type) options.mimeType = type;
    this.rec = new MediaRecorder(this.stream, options);
    this.target = target;
    this.chunks = [];
    this.pending = Promise.resolve();
    this.rec.ondataavailable = (e) => {
      if (!e.data.size) return;
      if (this.target) this.pending = this.pending.then(() => this.target.writable.write(e.data));
      else this.chunks.push(e.data);
    };
    this.startedAt = 0;
  }

  get type() {
    return this.rec.mimeType;
  }

  /** Copies the latest picture into the scaled recording canvas (no-op when recording the source itself). */
  frame() {
    if (this.ctx) this.ctx.drawImage(this.source, 0, 0, this.canvas.width, this.canvas.height);
  }

  get elapsed() {
    return this.startedAt ? performance.now() - this.startedAt : 0;
  }

  start() {
    this.rec.start(1000);
    this.startedAt = performance.now();
  }

  /** Resolves to { blob, savedToFolder }. */
  stop() {
    return new Promise((resolve, reject) => {
      this.rec.onstop = async () => {
        try {
          this.stream.getTracks().forEach((t) => t.stop());
          if (this.target) {
            await this.pending;
            await this.target.writable.close();
            resolve({ blob: await this.target.fileHandle.getFile(), savedToFolder: true });
          } else {
            resolve({ blob: new Blob(this.chunks, { type: this.rec.mimeType }), savedToFolder: false });
          }
        } catch (e) {
          reject(e);
        }
      };
      this.rec.stop();
    });
  }
}
