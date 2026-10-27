// What the page shows at the bottom so you can tell which release you are looking at:
// the version, when it was built (= deployed) and from which commit.
import { readFile, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { PUBLIC_DIR } from './library.mjs';

const GENERATED = new Set(['index.json', 'build.json']);

function gitCommit() {
  // Cloudflare Pages and GitHub Actions provide the commit; locally ask git, if there is a repository.
  const fromEnv = process.env.CF_PAGES_COMMIT_SHA || process.env.GITHUB_SHA;
  if (fromEnv) return fromEnv.slice(0, 7);
  try {
    return execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: PUBLIC_DIR, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim() || null;
  } catch {
    return null;
  }
}

async function packageVersion() {
  const pkg = JSON.parse(await readFile(new URL('../../package.json', import.meta.url), 'utf8'));
  return pkg.version;
}

/** Newest modification time of the site's own files: when the local copy last changed. */
async function newestChange(dir = PUBLIC_DIR) {
  let newest = 0;
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.') || GENERATED.has(entry.name)) continue;
    const path = join(dir, entry.name);
    newest = Math.max(newest, entry.isDirectory() ? await newestChange(path) : (await stat(path)).mtimeMs);
  }
  return newest;
}

/** For `npm run build`: the time of the build, i.e. of the deployment. */
export async function releaseInfo() {
  return { version: await packageVersion(), updatedAt: new Date().toISOString(), commit: gitCommit(), source: 'build' };
}

/** For `npm run dev`: when the files were last edited. */
export async function devInfo() {
  return { version: await packageVersion(), updatedAt: new Date(await newestChange()).toISOString(), commit: gitCommit(), source: 'dev' };
}
