// Camera profile library: loading, matching a connected camera, and judging compatibility
// against the results of a compatibility test (probe).
import { validateProfile } from './profile-validate.js';

const LOCAL_KEY = 'usbcam.localProfiles';
const FALLBACK = { id: 'generic-uvc', name: 'Generic USB camera', kind: 'other', generic: true, match: { fallback: true }, source: 'builtin' };

const regexCache = new Map();
function regex(src) {
  if (!regexCache.has(src)) {
    let r = null;
    try { r = new RegExp(src, 'i'); } catch { /* validated elsewhere */ }
    regexCache.set(src, r);
  }
  return regexCache.get(src);
}

export function readLocalProfiles() {
  try { return JSON.parse(localStorage.getItem(LOCAL_KEY)) || []; } catch { return []; }
}
function writeLocalProfiles(list) {
  try { localStorage.setItem(LOCAL_KEY, JSON.stringify(list)); } catch { /* private mode */ }
}
export function saveLocalProfile(profile) {
  const { $schema, ...rest } = profile;
  writeLocalProfiles([rest, ...readLocalProfiles().filter((p) => p.id !== rest.id)]);
}
export function removeLocalProfile(id) {
  writeLocalProfiles(readLocalProfiles().filter((p) => p.id !== id));
}

/** Library profiles from cameras/index.json plus profiles loaded in this browser (which win on equal ids). */
export async function loadProfiles() {
  let library = [];
  try {
    const res = await fetch('cameras/index.json', { cache: 'no-cache' });
    if (res.ok) library = (await res.json()).profiles || [];
  } catch (e) {
    console.warn('Could not load the camera library', e);
  }
  const local = readLocalProfiles();
  const localIds = new Set(local.map((p) => p.id));
  const candidates = [
    ...local.map((p) => [p, 'local']),
    ...library.filter((p) => !localIds.has(p.id)).map((p) => [p, 'library']),
  ];
  const profiles = [];
  for (const [p, source] of candidates) {
    const errors = validateProfile(p);
    if (errors.length) console.warn(`Skipping camera profile "${p.id}":`, errors);
    else profiles.push({ ...p, source });
  }
  if (!profiles.some((p) => p.match.fallback)) profiles.push(FALLBACK);
  return profiles;
}

/** How well a profile's match rules recognise a device. Higher score wins. */
export function identify(profile, dev) {
  const m = profile.match || {};
  const usb = m.usb || [];
  if (dev.usb && usb.some((u) => u.vendorId === dev.usb.vendorId && u.productId === dev.usb.productId)) {
    return { level: 'usb', score: 100 };
  }
  const labelHit = (m.labels || []).some((src) => regex(src)?.test(dev.base));
  if (!profile.generic) {
    // A known, different USB ID beats a similar name.
    const otherDevice = dev.usb && usb.length > 0;
    return labelHit && !otherDevice ? { level: 'label', score: 60 } : { level: 'none', score: 0 };
  }
  if (labelHit) return { level: 'keyword', score: 30 };
  if (m.fallback) return { level: 'fallback', score: 1 };
  return { level: 'none', score: 0 };
}

export function bestProfile(profiles, dev) {
  let best = null;
  let bestScore = 0;
  for (const p of profiles) {
    const { score } = identify(p, dev);
    if (score > bestScore) {
      best = p;
      bestScore = score;
    }
  }
  return best || profiles.find((p) => p.match.fallback) || FALLBACK;
}

const STATUS_ORDER = { compatible: 0, partial: 1, incompatible: 2 };

/**
 * Checks every profile against what the probe measured on the connected camera:
 * do its resolutions exist natively, does its default mode work, are its controls exposed.
 */
export function evaluateAll(profiles, dev, probe) {
  const working = probe.modes.filter((m) => m.ok);
  const nativeKnown = working.some((m) => typeof m.native === 'boolean');
  const pool = nativeKnown ? working.filter((m) => m.native) : working;
  const fits = (want) => pool.some((m) =>
    m.width === want.width && m.height === want.height &&
    (!want.frameRate || want.frameRate <= Math.max(m.frameRate || 0, m.maxFrameRate || 0) + 1));
  const caps = probe.capabilities || {};

  const results = profiles.map((profile) => {
    const identity = identify(profile, dev);
    const modes = profile.modes || [];
    const supported = modes.filter(fits).length;
    const defaultOk = profile.defaultMode ? fits(profile.defaultMode) : true;
    const controlsMissing = Object.keys(profile.controls || {}).filter((k) => !(k in caps));
    let status = 'compatible';
    if (modes.length && supported === 0) status = 'incompatible';
    else if (!defaultOk || supported < modes.length || controlsMissing.length) status = 'partial';
    return { profile, identity, status, supported, total: modes.length, defaultOk, controlsMissing, best: false };
  });

  results.sort((a, b) => STATUS_ORDER[a.status] - STATUS_ORDER[b.status] || b.identity.score - a.identity.score);
  if (results[0]?.status === 'compatible' && results[0].identity.score > 0) results[0].best = true;
  return results;
}
