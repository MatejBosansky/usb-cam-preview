// Reads and checks the three extension folders and builds the lists the app loads:
//   public/cameras/*.json             camera profiles        -> cameras/index.json
//   public/drivers/<id>/driver.js     camera drivers         -> drivers/index.json
//   public/filters/<id>.js            filters (or <id>/filter.js) -> filters/index.json
// The lists are generated, never edited by hand: `npm run dev` serves them on the fly and
// `npm run build` writes them for deployment.
import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { validateProfile } from '../../public/js/profile-validate.js';
import { validateDriver, validateFilter } from '../../public/js/plugin-validate.js';

export const PUBLIC_DIR = fileURLToPath(new URL('../../public/', import.meta.url));
export const CAMERAS_DIR = join(PUBLIC_DIR, 'cameras');
export const DRIVERS_DIR = join(PUBLIC_DIR, 'drivers');
export const FILTERS_DIR = join(PUBLIC_DIR, 'filters');
export const INDEX_FILES = {
  cameras: join(CAMERAS_DIR, 'index.json'),
  drivers: join(DRIVERS_DIR, 'index.json'),
  filters: join(FILTERS_DIR, 'index.json'),
};

const NOT_PROFILES = new Set(['index.json', 'schema.json']);
const hidden = (name) => name.startsWith('_') || name.startsWith('.');
const exists = (path) => stat(path).then(() => true, () => false);

/** fresh: bypass Node's module cache, so edits show up in a running dev server. */
async function importDefault(file, fresh) {
  const url = pathToFileURL(file);
  if (fresh) url.search = `?t=${Date.now()}`;
  return (await import(url.href)).default;
}

export async function loadDrivers({ fresh = false } = {}) {
  const drivers = new Map();
  const errors = [];
  for (const entry of (await readdir(DRIVERS_DIR, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isDirectory() || hidden(entry.name)) continue;
    const file = join(DRIVERS_DIR, entry.name, 'driver.js');
    if (!(await exists(file))) {
      errors.push(`drivers/${entry.name}: driver.js is missing`);
      continue;
    }
    try {
      const driver = await importDefault(file, fresh);
      const problems = validateDriver(driver, entry.name);
      errors.push(...problems.map((p) => `drivers/${entry.name}/driver.js: ${p}`));
      if (!problems.length) drivers.set(entry.name, driver);
    } catch (e) {
      errors.push(`drivers/${entry.name}/driver.js: cannot be loaded (${e.message})`);
    }
  }
  return { drivers, errors };
}

export async function loadFilters({ fresh = false } = {}) {
  const filters = [];
  const errors = [];
  for (const entry of (await readdir(FILTERS_DIR, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    if (hidden(entry.name)) continue;
    let path, fileId;
    if (entry.isFile() && entry.name.endsWith('.js')) {
      path = entry.name;
      fileId = entry.name.slice(0, -3);
    } else if (entry.isDirectory() && (await exists(join(FILTERS_DIR, entry.name, 'filter.js')))) {
      path = `${entry.name}/filter.js`;
      fileId = entry.name;
    } else {
      continue;
    }
    try {
      const filter = await importDefault(join(FILTERS_DIR, path), fresh);
      const problems = validateFilter(filter, fileId);
      errors.push(...problems.map((p) => `filters/${path}: ${p}`));
      if (!problems.length) filters.push({ path, filter });
    } catch (e) {
      errors.push(`filters/${path}: cannot be loaded (${e.message})`);
    }
  }
  return { filters, errors };
}

export async function loadProfiles({ drivers }) {
  const files = (await readdir(CAMERAS_DIR)).filter((f) => f.endsWith('.json') && !NOT_PROFILES.has(f)).sort();
  const profiles = [];
  const errors = [];

  for (const file of files) {
    let profile;
    try {
      profile = JSON.parse(await readFile(join(CAMERAS_DIR, file), 'utf8'));
    } catch (e) {
      errors.push(`cameras/${file}: invalid JSON (${e.message})`);
      continue;
    }
    const problems = validateProfile(profile, { fileId: file.slice(0, -'.json'.length) });
    if (profile?.driver?.id && !problems.length) {
      const driver = drivers.get(profile.driver.id);
      if (!driver) problems.push(`driver "${profile.driver.id}" does not exist in public/drivers/ (or has errors)`);
      else {
        if (driver.kinds && !driver.kinds.includes(profile.kind)) problems.push(`driver "${driver.id}" is for kind ${driver.kinds.join(' or ')}, not "${profile.kind}"`);
        if (driver.validateOptions) problems.push(...driver.validateOptions(profile.driver.options || {}).map((p) => `driver.options: ${p}`));
      }
    }
    errors.push(...problems.map((p) => `cameras/${file}: ${p}`));
    if (!problems.length) {
      const { $schema, ...rest } = profile;
      profiles.push(rest);
    }
  }

  const owners = new Map();
  for (const p of profiles) {
    for (const { vendorId, productId } of p.match.usb || []) {
      const usb = `${vendorId}:${productId}`;
      if (owners.has(usb)) errors.push(`cameras/: USB ID ${usb} is in both ${owners.get(usb)}.json and ${p.id}.json. Keep one profile per USB ID: add new test results to the existing profile's "tested" list instead.`);
      else owners.set(usb, p.id);
    }
  }

  // Device profiles first (by name), generic fallbacks last, the catch-all at the very end.
  const rank = (p) => (p.match.fallback ? 2 : p.generic ? 1 : 0);
  profiles.sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name, 'en'));
  return { profiles, errors };
}

/** Everything the app loads, plus every problem found. Invalid items are left out of the lists. */
export async function buildLibrary({ fresh = false } = {}) {
  const [{ drivers, errors: driverErrors }, { filters, errors: filterErrors }] = await Promise.all([loadDrivers({ fresh }), loadFilters({ fresh })]);
  const { profiles, errors: profileErrors } = await loadProfiles({ drivers });
  return {
    indexes: {
      cameras: { version: 1, profiles },
      drivers: { version: 1, drivers: [...drivers.keys()] },
      filters: { version: 1, filters: filters.map((f) => f.path) },
    },
    counts: { cameras: profiles.length, drivers: drivers.size, filters: filters.length },
    errors: [...driverErrors, ...filterErrors, ...profileErrors],
  };
}

export const serialize = (data) => `${JSON.stringify(data, null, 2)}\n`;
