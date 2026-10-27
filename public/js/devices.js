// Camera discovery. Chrome and Edge append the USB ID to camera labels, e.g.
// "USB Camera (0bda:5806)"; Firefox and Safari do not, so usb is null there.
const USB_SUFFIX = /\s*\(([0-9a-f]{4}):([0-9a-f]{4})\)\s*$/i;
const BUILT_IN = /facetime|built-?in|integrated|macbook|imac|desk view|virtual|obs |snap camera|continuity|iphone|ipad/i;

export function parseLabel(label = '') {
  const m = label.match(USB_SUFFIX);
  // Built-in Mac cameras get a placeholder "(0000:0001)"; vendor 0000 is not a real USB vendor.
  const real = m && m[1] !== '0000';
  return {
    label,
    base: (m ? label.slice(0, m.index) : label).trim() || 'Camera',
    usb: real ? { vendorId: m[1].toLowerCase(), productId: m[2].toLowerCase() } : null,
  };
}

/**
 * Stable key for per-camera settings. With a USB ID (Chrome, Edge) it is the same for every camera
 * of that model. Without one (Firefox, Safari) the name is not enough, since different cameras are
 * often all called "USB Camera", so the browser's id for this device on this site is added.
 */
export const deviceKey = (dev) => (dev.usb ? `usb:${dev.usb.vendorId}:${dev.usb.productId}` : `label:${dev.base}:${dev.deviceId}`);
export const isLikelyExternal = (dev) => !BUILT_IN.test(dev.label);
export const usbText = (usb) => (usb ? `${usb.vendorId}:${usb.productId}` : '');

export async function listCameras() {
  const all = await navigator.mediaDevices.enumerateDevices();
  return all
    .filter((d) => d.kind === 'videoinput' && d.deviceId)
    .map((d, i) => ({ deviceId: d.deviceId, ...parseLabel(d.label || `Camera ${i + 1}`) }));
}

/** Labels are only exposed once the user has allowed camera access. */
export async function hasCameraPermission() {
  const all = await navigator.mediaDevices.enumerateDevices();
  return all.some((d) => d.kind === 'videoinput' && d.label);
}

export async function requestPermission() {
  const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
  stream.getTracks().forEach((t) => t.stop());
}

/** mode null asks for the largest picture at about 30 fps. */
export function constraintsFor(deviceId, mode) {
  const video = { deviceId: { exact: deviceId }, resizeMode: 'none' };
  if (mode) {
    video.width = { ideal: mode.width };
    video.height = { ideal: mode.height };
    if (mode.frameRate) video.frameRate = { ideal: mode.frameRate };
  } else {
    video.width = { ideal: 7680 };
    video.height = { ideal: 4320 };
    video.frameRate = { ideal: 30 };
  }
  return { video, audio: false };
}

/**
 * 'iphone', 'android' (phones, not tablets) or null. Phones can use their own cameras, but practically
 * never offer USB cameras to a browser; iPads with USB-C and computers can.
 */
export function phoneType() {
  const ua = navigator.userAgent;
  if (/iPhone|iPod/.test(ua)) return 'iphone';
  const mobile = navigator.userAgentData?.mobile ?? /Mobile/.test(ua);
  return /Android/.test(ua) && mobile ? 'android' : null;
}

export function errorKey(err) {
  switch (err?.name) {
    case 'NotAllowedError':
    case 'PermissionDeniedError':
    case 'SecurityError':
      return 'err_permission';
    case 'NotReadableError':
    case 'TrackStartError':
    case 'AbortError':
      return 'err_busy';
    case 'NotFoundError':
    case 'DevicesNotFoundError':
    case 'OverconstrainedError':
      return 'err_notFound';
    default:
      return null;
  }
}
