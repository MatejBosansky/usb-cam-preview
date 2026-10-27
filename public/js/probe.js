// Compatibility test: finds out which resolutions a camera really delivers, and turns the
// result into a camera report with a draft profile that contributors can submit.
import { APP_NAME, APP_VERSION } from './config.js';

export const CANDIDATE_MODES = [
  [160, 120], [176, 144], [320, 240], [352, 288], [640, 360], [640, 480], [800, 600],
  [960, 540], [1024, 576], [1024, 768], [1280, 720], [1280, 960], [1280, 1024], [1600, 1200],
  [1920, 1080], [2048, 1536], [2560, 1440], [2592, 1944], [3264, 2448], [3840, 2160], [4096, 2160],
];

const PRIVATE_FIELDS = ['deviceId', 'groupId'];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const gum = (video) => navigator.mediaDevices.getUserMedia({ video, audio: false });
const stop = (stream) => stream?.getTracks().forEach((t) => t.stop());
const round1 = (n) => (typeof n === 'number' ? Math.round(n * 10) / 10 : null);

function withoutPrivate(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj || {})) if (!PRIVATE_FIELDS.includes(k)) out[k] = v;
  return out;
}

function waitForFrame(video, timeout) {
  return new Promise((resolve) => {
    if (video.readyState >= 2) return resolve(true);
    video.addEventListener('loadeddata', () => resolve(true), { once: true });
    setTimeout(() => resolve(false), timeout);
  });
}

/** Measures real frame rate and average brightness of a running stream. */
async function measure(stream, ms = 800) {
  const video = Object.assign(document.createElement('video'), { muted: true, playsInline: true, srcObject: stream });
  video.style.cssText = 'position:fixed;right:0;bottom:0;width:2px;height:2px;opacity:0;pointer-events:none';
  document.body.append(video);
  try {
    await video.play().catch(() => {});
    if (!(await waitForFrame(video, 3000))) return { measuredFps: 0, meanLuma: null };
    await sleep(250);
    let measuredFps = null;
    if ('requestVideoFrameCallback' in video) {
      measuredFps = await new Promise((resolve) => {
        let first = 0, last = 0, frames = 0;
        const deadline = performance.now() + ms;
        const finish = () => resolve(frames > 1 ? round1(((frames - 1) * 1000) / (last - first)) : 0);
        const timer = setTimeout(finish, ms + 1500);
        const onFrame = (now) => {
          if (!first) first = now;
          last = now;
          frames++;
          if (now < deadline) video.requestVideoFrameCallback(onFrame);
          else { clearTimeout(timer); finish(); }
        };
        video.requestVideoFrameCallback(onFrame);
      });
    }
    const canvas = Object.assign(document.createElement('canvas'), { width: 32, height: 24 });
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(video, 0, 0, 32, 24);
    const px = ctx.getImageData(0, 0, 32, 24).data;
    let sum = 0;
    for (let i = 0; i < px.length; i += 4) sum += 0.2126 * px[i] + 0.7152 * px[i + 1] + 0.0722 * px[i + 2];
    return { measuredFps, meanLuma: Math.round(sum / (px.length / 4)) };
  } finally {
    video.srcObject = null;
    video.remove();
  }
}

/**
 * Opens the camera once per candidate resolution and records what it delivers.
 * Chrome and Edge report resizeMode, which tells native modes apart from scaled ones.
 */
/** extraModes: more [width, height] sizes to try, e.g. from drivers' probeModes. */
export async function probeDevice(deviceId, { onProgress, extraModes = [] } = {}) {
  const base = { deviceId: { exact: deviceId } };

  let stream = await gum(base);
  let track = stream.getVideoTracks()[0];
  const label = track.label;
  const defaultSettings = withoutPrivate(track.getSettings());
  stop(stream);

  stream = await gum({ ...base, width: { ideal: 8192 }, height: { ideal: 8192 } });
  track = stream.getVideoTracks()[0];
  const capabilities = withoutPrivate(track.getCapabilities?.() || {});
  const largest = withoutPrivate(track.getSettings());
  stop(stream);

  const maxW = capabilities.width?.max || largest.width || 1920;
  const maxH = capabilities.height?.max || largest.height || 1080;
  const list = [];
  for (const [w, h] of [...CANDIDATE_MODES, ...extraModes]) {
    if (w <= maxW && h <= maxH && !list.some(([a, b]) => a === w && b === h)) list.push([w, h]);
  }
  // Also the halves of the largest mode: some cameras pair W×2H with W×H (e.g. thermal ones).
  const extra = [[defaultSettings.width, defaultSettings.height], [largest.width, largest.height], [maxW, maxH / 2], [maxW / 2, maxH / 2]];
  for (const [w, h] of extra) {
    if (Number.isInteger(w) && Number.isInteger(h) && w > 0 && h > 0 && !list.some(([a, b]) => a === w && b === h)) list.push([w, h]);
  }
  list.sort((x, y) => x[0] * x[1] - y[0] * y[1]);

  const modes = [];
  for (let i = 0; i < list.length; i++) {
    const [width, height] = list[i];
    onProgress?.({ i: i + 1, n: list.length, width, height });
    const entry = { width, height, ok: false };
    let s = null;
    try {
      s = await gum({ ...base, width: { exact: width }, height: { exact: height }, resizeMode: 'none' });
      const t = s.getVideoTracks()[0];
      const settings = t.getSettings();
      entry.ok = settings.width === width && settings.height === height;
      entry.native = typeof settings.resizeMode === 'string' ? settings.resizeMode === 'none' : null;
      entry.frameRate = round1(settings.frameRate);
      const fr = t.getCapabilities?.().frameRate;
      if (fr?.max) entry.maxFrameRate = round1(fr.max);
      if (entry.ok && entry.native !== false) Object.assign(entry, await measure(s));
    } catch (err) {
      entry.error = err?.name || String(err);
    } finally {
      stop(s);
    }
    modes.push(entry);
    await sleep(80);
  }

  return { label, defaultSettings, capabilities, modes, testedAt: new Date().toISOString() };
}

const BRAND_NAMES = { 'Google Chrome': 'Chrome', 'Microsoft Edge': 'Edge' };

export async function describeEnvironment() {
  const ua = navigator.userAgent;
  let os = '';
  let browser = '';
  const uad = navigator.userAgentData;
  if (uad) {
    try {
      const hi = await uad.getHighEntropyValues(['platformVersion', 'fullVersionList']);
      const brands = hi.fullVersionList || uad.brands || [];
      const brand = brands.find((b) => !/not.?a.?brand|chromium/i.test(b.brand)) || brands.find((b) => /chromium/i.test(b.brand));
      if (brand) browser = `${BRAND_NAMES[brand.brand] || brand.brand} ${brand.version.split('.')[0]}`;
      const version = hi.platformVersion || '';
      if (uad.platform === 'macOS') os = `macOS ${version.split('.').slice(0, 2).join('.')}`.trim();
      else if (uad.platform === 'Windows') os = parseInt(version, 10) >= 13 ? 'Windows 11' : 'Windows 10';
      else os = `${uad.platform} ${version}`.trim();
    } catch { /* fall back to the user agent string */ }
  }
  if (!browser) {
    const m = ua.match(/(Firefox|Edg|OPR|Chrome)\/(\d+)/) || ua.match(/Version\/(\d+).*(Safari)/);
    if (m) browser = m[2] === 'Safari' ? `Safari ${m[1]}` : `${{ Edg: 'Edge', OPR: 'Opera' }[m[1]] || m[1]} ${m[2]}`;
  }
  if (!os) {
    const android = ua.match(/Android (\d+)/);
    os = android ? `Android ${android[1]}` : /iPad|iPhone/.test(ua) ? 'iOS' : /Mac OS X/.test(ua) ? 'macOS' : /Windows/.test(ua) ? 'Windows' : /Linux/.test(ua) ? 'Linux' : 'unknown';
  }
  return { os, browser: browser || 'unknown', userAgent: ua };
}

/** Names like "USB Camera" or "USB2.0 HD UVC WebCam" say nothing about the device. */
export function isGenericName(name) {
  const rest = name.toLowerCase()
    .replace(/usb\s*\d(\.\d)?/g, ' ')
    .replace(/\b(usb|uvc|hd|fhd|full|pc|web|webcam|cam|camera|video|device|digital|generic|global|default|\d+p|\d+(\.\d+)?)\b/g, ' ')
    .replace(/[^a-z]+/g, '');
  return rest.length === 0;
}

export function guessKind(name) {
  if (/thermal|infiray|topdon|tooltop|\bir ?cam/i.test(name)) return 'thermal';
  if (/endo|borescope|inspection|snake/i.test(name)) return 'endoscope';
  if (/micro|dino-?lite|digital ?viewer/i.test(name)) return 'microscope';
  if (/facetime|webcam|integrated|built-?in/i.test(name) && !isGenericName(name)) return 'webcam';
  return 'other';
}

const KIND_NAMES = {
  webcam: 'USB webcam',
  endoscope: 'USB endoscope',
  microscope: 'USB microscope',
  thermal: 'Thermal camera',
  'document-camera': 'Document camera',
  other: 'USB camera',
};

const slug = (s) => s.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'camera';
const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export function draftProfile({ dev, probe, kind, notes, github, button, needsHub, env, drivers = [] }) {
  const native = probe.modes.filter((m) => m.ok && m.native !== false);
  const modes = native
    .map((m) => ({ width: m.width, height: m.height, ...(m.frameRate ? { frameRate: Math.round(m.frameRate) } : {}) }))
    .sort((a, b) => b.width * b.height - a.width * a.height);
  const smooth = modes.filter((m) => !m.frameRate || m.frameRate >= 15);
  let defaultMode = smooth[0] || modes[0];
  // A driver may recognise the camera from what the test measured (e.g. a thermal frame layout).
  let driver = null;
  for (const d of drivers) {
    let suggestion = null;
    try { suggestion = d.suggest?.({ kind, modes, device: dev }); } catch (e) { console.warn(`Driver "${d.id}" suggest() failed`, e); }
    if (suggestion) {
      driver = { id: d.id, ...(suggestion.options ? { options: suggestion.options } : {}) };
      if (suggestion.defaultMode) defaultMode = suggestion.defaultMode;
      break;
    }
  }
  const generic = isGenericName(dev.base);
  const usb = dev.usb ? `${dev.usb.vendorId}-${dev.usb.productId}` : '';
  const nativeKnown = native.some((m) => typeof m.native === 'boolean');

  const profile = {
    $schema: './schema.json',
    id: usb ? `${generic ? kind : slug(dev.base)}-${usb}` : slug(dev.base),
    name: generic && dev.usb ? `${KIND_NAMES[kind] || KIND_NAMES.other} (${dev.usb.vendorId}:${dev.usb.productId})` : dev.base,
    kind,
    match: {
      ...(dev.usb ? { usb: [{ vendorId: dev.usb.vendorId, productId: dev.usb.productId }] } : {}),
      ...(!generic ? { labels: [`^${escapeRegex(dev.base)}$`] } : {}),
    },
  };
  if (modes.length) profile.modes = modes;
  if (defaultMode) profile.defaultMode = defaultMode;
  profile.view = { mirror: kind === 'webcam', rotate: 0, overlay: kind === 'microscope' ? 'crosshair' : 'none' };
  if (driver) profile.driver = driver;
  if (needsHub) profile.connection = { needsHub: true, notes: `Did not connect when plugged straight into the computer (${env.os}); works through a USB hub.` };
  if (button) profile.button = button.type === 'keyboard' ? { type: 'keyboard', keys: button.keys } : { type: button.type };
  if (notes) profile.notes = notes;
  profile.tested = [{
    date: new Date().toISOString().slice(0, 10),
    os: env.os,
    browser: env.browser,
    result: 'works',
    ...(nativeKnown ? {} : { notes: 'This browser cannot tell native and scaled modes apart; re-test in Chrome or Edge.' }),
  }];
  if (github) profile.contributors = [github.replace(/^@/, '')];
  return profile;
}

export async function buildReport({ dev, probe, kind, notes, github, button, needsHub, evaluations, drivers }) {
  const env = await describeEnvironment();
  return {
    reportVersion: 1,
    app: `${APP_NAME} ${APP_VERSION}`,
    createdAt: new Date().toISOString(),
    environment: env,
    device: { label: probe.label || dev.label, name: dev.base, usb: dev.usb },
    defaultSettings: probe.defaultSettings,
    capabilities: probe.capabilities,
    modes: probe.modes,
    button: button || { type: 'not tested' },
    connection: { needsHub: !!needsHub },
    libraryMatches: (evaluations || []).map((e) => ({ id: e.profile.id, status: e.status, best: e.best, identity: e.identity.level })),
    draftProfile: draftProfile({ dev, probe, kind, notes, github, button, needsHub, env, drivers }),
  };
}
