#!/usr/bin/env node
// CI helper: clone each engine at its latest release tag (blobless, sparse
// where configured, depth 1) plus tc39/ecma262 (main), under the given
// destination root.
//
// Usage: node scripts/impl-links/ci-checkout.mjs <dest-root> [engine…]
//
// The last stdout line is the `--root …` argument string for build.mjs.

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

import { engines, ENGINE_ORDER } from './config.mjs';
import { latestTag } from './resolve-tag.mjs';

function git(args, opts = {}) {
  execFileSync('git', args, { stdio: ['ignore', 'inherit', 'inherit'], ...opts });
}

async function main() {
  const [destRoot, ...keys] = process.argv.slice(2);
  if (!destRoot) {
    console.error('usage: ci-checkout.mjs <dest-root> [engine…]');
    process.exit(1);
  }
  for (const key of keys) {
    if (!Object.hasOwn(engines, key)) {
      console.error(`error: unknown engine ${key}`);
      process.exit(1);
    }
  }
  const selected = keys.length > 0 ? keys : ENGINE_ORDER;
  mkdirSync(destRoot, { recursive: true });

  const roots = [];
  for (const key of selected) {
    const config = engines[key];
    const tag = latestTag(key);
    const dir = join(destRoot, key);
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
    const sparse = config.sparsePaths.length > 0;
    console.log(`[${key}] cloning ${config.repo} at ${tag}${sparse ? ' (sparse)' : ''}`);
    git([
      'clone',
      '--filter=blob:none',
      '--depth',
      '1',
      ...(sparse ? ['--sparse'] : []),
      '--branch',
      tag,
      `https://github.com/${config.repo}.git`,
      dir,
    ]);
    if (sparse) git(['-C', dir, 'sparse-checkout', 'set', ...config.sparsePaths]);
    roots.push(`--root ${key}=${dir}`);
  }

  const specDir = join(destRoot, 'ecma262');
  if (existsSync(specDir)) rmSync(specDir, { recursive: true, force: true });
  console.log('[ecma262] cloning tc39/ecma262 (main)');
  git(['clone', '--depth', '1', 'https://github.com/tc39/ecma262.git', specDir]);
  roots.push(`--root ecma262=${specDir}`);

  console.log(roots.join(' '));
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
