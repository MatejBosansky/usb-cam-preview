// Checks the shape of filters (public/filters/) and drivers (public/drivers/).
// Shared by the app and the Node scripts, so a broken plugin is caught by `npm run check`
// and skipped (with a console warning) instead of breaking the page.
import { KINDS } from './profile-validate.js';

export const PLUGIN_API = 1;

const ID = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const PARAM_ID = /^[a-z][a-zA-Z0-9]*$/;
const FORMATS = ['number', 'percent', 'degrees'];
const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isFunction = (v) => typeof v === 'function';

/** fileId is the file name without .js (or the folder name for a filter folder). */
export function validateFilter(f, fileId) {
  const errors = [];
  if (!isObject(f)) return ['the module must `export default` an object'];
  if (f.apiVersion !== PLUGIN_API) errors.push(`apiVersion must be ${PLUGIN_API}`);
  if (typeof f.id !== 'string' || !ID.test(f.id)) errors.push('id must be kebab-case');
  else if (fileId !== undefined && f.id !== fileId) errors.push(`id "${f.id}" must match the file or folder name "${fileId}"`);
  if (typeof f.name !== 'string' || !f.name.trim()) errors.push('name is required');
  if ('description' in f && typeof f.description !== 'string') errors.push('description must be a string');
  if (typeof f.glsl !== 'string' || !/vec3\s+applyFilter\s*\(\s*vec2\s+\w+\s*,\s*vec3\s+\w+\s*\)/.test(f.glsl)) {
    errors.push('glsl must define `vec3 applyFilter(vec2 uv, vec3 color)`');
  }
  if ('params' in f) {
    if (!Array.isArray(f.params)) errors.push('params must be an array');
    else {
      const seen = new Set();
      f.params.forEach((p, i) => {
        const where = `params[${i}]`;
        if (!isObject(p)) return errors.push(`${where} must be an object`);
        if (typeof p.id !== 'string' || !PARAM_ID.test(p.id)) errors.push(`${where}.id must be camelCase letters and digits (it becomes the GLSL uniform p_<id>)`);
        else if (seen.has(p.id)) errors.push(`${where}.id "${p.id}" is used twice`);
        seen.add(p.id);
        if (typeof p.name !== 'string' || !p.name.trim()) errors.push(`${where}.name is required`);
        if (![p.min, p.max, p.step, p.default].every((v) => typeof v === 'number' && Number.isFinite(v))) errors.push(`${where} needs numeric min, max, step and default`);
        else {
          if (!(p.max > p.min)) errors.push(`${where}.max must be greater than min`);
          if (!(p.step > 0)) errors.push(`${where}.step must be positive`);
          if (p.default < p.min || p.default > p.max) errors.push(`${where}.default must lie between min and max`);
        }
        if ('format' in p && !FORMATS.includes(p.format)) errors.push(`${where}.format must be one of: ${FORMATS.join(', ')}`);
      });
    }
  }
  return errors;
}

/** folderId is the driver's folder name. */
export function validateDriver(d, folderId) {
  const errors = [];
  if (!isObject(d)) return ['driver.js must `export default` an object'];
  if (d.apiVersion !== PLUGIN_API) errors.push(`apiVersion must be ${PLUGIN_API}`);
  if (typeof d.id !== 'string' || !ID.test(d.id)) errors.push('id must be kebab-case');
  else if (folderId !== undefined && d.id !== folderId) errors.push(`id "${d.id}" must match the folder name "${folderId}"`);
  if (typeof d.name !== 'string' || !d.name.trim()) errors.push('name is required');
  if ('description' in d && typeof d.description !== 'string') errors.push('description must be a string');
  if (!isFunction(d.create)) errors.push('create(ctx) is required');
  for (const fn of ['validateOptions', 'suggest']) {
    if (fn in d && !isFunction(d[fn])) errors.push(`${fn} must be a function`);
  }
  if ('kinds' in d && !(Array.isArray(d.kinds) && d.kinds.every((k) => KINDS.includes(k)))) {
    errors.push(`kinds must list profile kinds (${KINDS.join(', ')})`);
  }
  if ('styles' in d && !(Array.isArray(d.styles) && d.styles.every((s) => typeof s === 'string' && /^[\w./-]+\.css$/.test(s) && !s.includes('..')))) {
    errors.push('styles must list .css files inside the driver folder');
  }
  if ('probeModes' in d && !(Array.isArray(d.probeModes) && d.probeModes.every((m) => Array.isArray(m) && m.length === 2 && m.every((n) => Number.isInteger(n) && n > 0)))) {
    errors.push('probeModes must be a list of [width, height] pairs');
  }
  return errors;
}
