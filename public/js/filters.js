// Image filters live in public/filters/, one file (or folder) each; see public/filters/README.md.
import { validateFilter } from './plugin-validate.js';

/** Loads the filters listed in filters/index.json, sorted by name. Broken ones are skipped with a warning. */
export async function loadFilters() {
  let paths = [];
  try {
    const res = await fetch(new URL('../filters/index.json', import.meta.url), { cache: 'no-cache' });
    if (res.ok) paths = (await res.json()).filters || [];
  } catch (e) {
    console.warn('Could not load the filter list', e);
  }
  const filters = await Promise.all(paths.map(async (path) => {
    const fileId = path.endsWith('/filter.js') ? path.slice(0, -'/filter.js'.length) : path.replace(/\.js$/, '');
    try {
      const filter = (await import(new URL(`../filters/${path}`, import.meta.url))).default;
      const errors = validateFilter(filter, fileId);
      if (!errors.length) return filter;
      console.warn(`Skipping filter "${path}":`, errors);
    } catch (e) {
      console.warn(`Could not load filter "${path}"`, e);
    }
    return null;
  }));
  return filters.filter(Boolean).sort((a, b) => a.name.localeCompare(b.name, 'en'));
}

export function formatParam(param, value) {
  if (param.format === 'percent') return `${Math.round(value * 100)} %`;
  if (param.format === 'degrees') return `${Math.round(value)}°`;
  const decimals = Math.max(0, Math.min(3, -Math.floor(Math.log10(param.step))));
  return value.toFixed(decimals);
}
