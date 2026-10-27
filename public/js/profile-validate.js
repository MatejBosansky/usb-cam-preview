// Camera profile validation shared by the app and scripts/build-camera-index.mjs.
// Mirrors public/cameras/schema.json; keep the two in sync.

export const KINDS = ['webcam', 'endoscope', 'microscope', 'thermal', 'document-camera', 'other'];

const TOP_LEVEL = new Set([
  '$schema', 'id', 'name', 'aliases', 'kind', 'generic', 'match', 'modes', 'defaultMode',
  'view', 'controls', 'button', 'driver', 'connection', 'notes', 'tested', 'contributors',
]);
const HEX4 = /^[0-9a-f]{4}$/;
const ID = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isPositiveInt = (v) => Number.isInteger(v) && v > 0;

function checkKeys(obj, allowed, where, errors) {
  for (const key of Object.keys(obj)) {
    if (!allowed.includes(key)) errors.push(`${where}: unknown field "${key}"`);
  }
}

function checkMode(mode, where, errors) {
  if (!isObject(mode)) return errors.push(`${where} must be an object`);
  checkKeys(mode, ['width', 'height', 'frameRate'], where, errors);
  if (!isPositiveInt(mode.width) || !isPositiveInt(mode.height)) errors.push(`${where} needs integer width and height`);
  if ('frameRate' in mode && !(typeof mode.frameRate === 'number' && mode.frameRate > 0)) errors.push(`${where}.frameRate must be a positive number`);
}

/** Returns a list of human readable problems; empty when the profile is valid. */
export function validateProfile(p, { fileId } = {}) {
  const errors = [];
  if (!isObject(p)) return ['profile must be a JSON object'];

  for (const key of Object.keys(p)) {
    if (!TOP_LEVEL.has(key)) errors.push(`unknown field "${key}"`);
  }
  if (typeof p.id !== 'string' || !ID.test(p.id)) errors.push('id must be kebab-case (a-z, 0-9 and dashes)');
  if (fileId !== undefined && p.id !== fileId) errors.push(`id "${p.id}" must match the file name "${fileId}.json"`);
  if (typeof p.name !== 'string' || p.name.trim().length < 3) errors.push('name is required (at least 3 characters)');
  if ('aliases' in p && !(Array.isArray(p.aliases) && p.aliases.every((a) => typeof a === 'string' && a.trim()))) {
    errors.push('aliases must be a list of names');
  }
  if (!KINDS.includes(p.kind)) errors.push(`kind must be one of: ${KINDS.join(', ')}`);
  if ('generic' in p && typeof p.generic !== 'boolean') errors.push('generic must be true or false');

  if (!isObject(p.match)) {
    errors.push('match is required');
  } else {
    const m = p.match;
    checkKeys(m, ['usb', 'labels', 'fallback'], 'match', errors);
    if ('usb' in m) {
      if (!Array.isArray(m.usb)) errors.push('match.usb must be an array');
      else m.usb.forEach((u, i) => {
        if (!isObject(u)) return errors.push(`match.usb[${i}] must be an object`);
        checkKeys(u, ['vendorId', 'productId'], `match.usb[${i}]`, errors);
        if (!HEX4.test(u.vendorId ?? '') || !HEX4.test(u.productId ?? '')) {
          errors.push(`match.usb[${i}] needs vendorId and productId as 4 lowercase hex digits, e.g. "0bda"`);
        }
      });
    }
    if ('labels' in m) {
      if (!Array.isArray(m.labels)) errors.push('match.labels must be an array');
      else m.labels.forEach((src, i) => {
        if (typeof src !== 'string' || !src) return errors.push(`match.labels[${i}] must be a non-empty string`);
        try { new RegExp(src, 'i'); } catch (e) { errors.push(`match.labels[${i}] is not a valid regular expression: ${e.message}`); }
      });
    }
    if ('fallback' in m && typeof m.fallback !== 'boolean') errors.push('match.fallback must be true or false');
    if (m.fallback && !p.generic) errors.push('match.fallback is only allowed on generic profiles');
    if (!p.generic && !(m.usb?.length || m.labels?.length)) errors.push('a device profile needs match.usb or match.labels');
  }

  if ('modes' in p) {
    if (!Array.isArray(p.modes)) errors.push('modes must be an array');
    else p.modes.forEach((mode, i) => checkMode(mode, `modes[${i}]`, errors));
  }
  if ('defaultMode' in p) {
    checkMode(p.defaultMode, 'defaultMode', errors);
    const modes = Array.isArray(p.modes) ? p.modes : [];
    if (modes.length && !modes.some((m) => m.width === p.defaultMode?.width && m.height === p.defaultMode?.height)) {
      errors.push('defaultMode must be one of modes');
    }
  }

  if ('view' in p) {
    if (!isObject(p.view)) errors.push('view must be an object');
    else {
      checkKeys(p.view, ['mirror', 'rotate', 'overlay'], 'view', errors);
      if ('mirror' in p.view && typeof p.view.mirror !== 'boolean') errors.push('view.mirror must be true or false');
      if ('rotate' in p.view && ![0, 90, 180, 270].includes(p.view.rotate)) errors.push('view.rotate must be 0, 90, 180 or 270');
      if ('overlay' in p.view && !['none', 'crosshair', 'grid'].includes(p.view.overlay)) errors.push('view.overlay must be none, crosshair or grid');
    }
  }

  if ('controls' in p) {
    if (!isObject(p.controls)) errors.push('controls must be an object');
    else for (const [key, value] of Object.entries(p.controls)) {
      if (!['number', 'string', 'boolean'].includes(typeof value)) errors.push(`controls.${key} must be a number, string or boolean`);
    }
  }

  if ('button' in p) {
    if (!isObject(p.button)) errors.push('button must be an object');
    else {
      checkKeys(p.button, ['type', 'keys', 'notes'], 'button', errors);
      if (!['none', 'keyboard', 'unknown'].includes(p.button.type)) errors.push('button.type must be none, keyboard or unknown');
      if ('keys' in p.button && !(Array.isArray(p.button.keys) && p.button.keys.every((k) => typeof k === 'string' && k))) errors.push('button.keys must be a list of key names');
      if (p.button.type === 'keyboard' && !p.button.keys?.length) errors.push('button.keys is required when button.type is keyboard');
    }
  }

  if ('driver' in p) {
    // Which driver (public/drivers/<id>/) handles this camera. The driver checks its own options;
    // `npm run check` runs that check too.
    if (!isObject(p.driver)) errors.push('driver must be an object');
    else {
      checkKeys(p.driver, ['id', 'options'], 'driver', errors);
      if (typeof p.driver.id !== 'string' || !ID.test(p.driver.id)) errors.push('driver.id must be the kebab-case name of a folder in public/drivers/');
      if ('options' in p.driver && !isObject(p.driver.options)) errors.push('driver.options must be an object');
    }
  }

  if ('connection' in p) {
    if (!isObject(p.connection)) errors.push('connection must be an object');
    else {
      checkKeys(p.connection, ['needsHub', 'notes'], 'connection', errors);
      if ('needsHub' in p.connection && typeof p.connection.needsHub !== 'boolean') errors.push('connection.needsHub must be true or false');
      if ('notes' in p.connection && typeof p.connection.notes !== 'string') errors.push('connection.notes must be a string');
    }
  }

  if ('notes' in p && typeof p.notes !== 'string') errors.push('notes must be a string');

  if ('tested' in p) {
    if (!Array.isArray(p.tested)) errors.push('tested must be an array');
    else p.tested.forEach((entry, i) => {
      const where = `tested[${i}]`;
      if (!isObject(entry)) return errors.push(`${where} must be an object`);
      checkKeys(entry, ['date', 'os', 'browser', 'result', 'notes'], where, errors);
      if (!DATE.test(entry.date ?? '')) errors.push(`${where}.date must look like 2026-01-31`);
      if (typeof entry.os !== 'string' || !entry.os) errors.push(`${where}.os is required`);
      if (typeof entry.browser !== 'string' || !entry.browser) errors.push(`${where}.browser is required`);
      if (!['works', 'partial', 'broken'].includes(entry.result)) errors.push(`${where}.result must be works, partial or broken`);
    });
  }

  if ('contributors' in p && !(Array.isArray(p.contributors) && p.contributors.every((c) => typeof c === 'string'))) {
    errors.push('contributors must be a list of GitHub usernames');
  }

  return errors;
}
