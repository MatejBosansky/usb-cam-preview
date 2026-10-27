#!/usr/bin/env node
// Validates camera profiles, drivers and filters.
//   node scripts/build.mjs          validate and write the generated lists (cameras/, drivers/,
//                                   filters/index.json) and build.json (version, build time,
//                                   commit) for deployment, e.g. on Cloudflare Pages
//   node scripts/build.mjs --check  validate only (CI, contributors)
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { buildLibrary, serialize, INDEX_FILES, PUBLIC_DIR } from './lib/library.mjs';
import { releaseInfo } from './lib/build-info.mjs';

const check = process.argv.includes('--check');
const { indexes, counts, errors } = await buildLibrary();

if (errors.length) {
  console.error(`Problems:\n${errors.map((e) => `  - ${e}`).join('\n')}`);
  process.exit(1);
}

const summary = `${counts.cameras} camera profiles, ${counts.drivers} drivers, ${counts.filters} filters`;
if (check) {
  console.log(`OK: ${summary} are valid.`);
} else {
  await Promise.all(Object.entries(INDEX_FILES).map(([key, file]) => writeFile(file, serialize(indexes[key]))));
  const info = await releaseInfo();
  await writeFile(join(PUBLIC_DIR, 'build.json'), serialize(info));
  console.log(`Wrote the lists for ${summary}, and build.json (${info.version}, ${info.updatedAt}${info.commit ? `, ${info.commit}` : ''}).`);
}
