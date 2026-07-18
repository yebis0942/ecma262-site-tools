#!/usr/bin/env node
// Resolve the latest release tag for each engine via `git ls-remote --tags`,
// using the per-engine `tagPattern` from config.mjs.
//
// Usage: node scripts/impl-links/resolve-tag.mjs [--json] [engine…]
//   --json    print a single {engine: tag} JSON object instead of lines

import { execFileSync } from 'node:child_process';

import { engines, ENGINE_ORDER } from './config.mjs';

function versionKey(tag) {
  return (tag.match(/\d+/g) ?? []).map(Number);
}

function compareVersionKeys(a, b) {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

export function latestTag(engineKey) {
  const config = engines[engineKey];
  const pattern = new RegExp(config.tagPattern);
  const out = execFileSync('git', ['ls-remote', '--tags', `https://github.com/${config.repo}`], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  const tags = out
    .split('\n')
    .map(line => line.split('\t')[1])
    .filter(ref => ref && !ref.endsWith('^{}'))
    .map(ref => ref.replace('refs/tags/', ''))
    .filter(tag => pattern.test(tag));
  if (tags.length === 0) {
    throw new Error(`no tags matching ${config.tagPattern} in ${config.repo}`);
  }
  tags.sort((a, b) => compareVersionKeys(versionKey(a), versionKey(b)));
  return tags[tags.length - 1];
}

async function main() {
  const args = process.argv.slice(2);
  const json = args.includes('--json');
  const keys = args.filter(a => a !== '--json');
  for (const key of keys) {
    if (!Object.hasOwn(engines, key)) {
      console.error(`error: unknown engine ${key}`);
      process.exit(1);
    }
  }
  const selected = keys.length > 0 ? keys : ENGINE_ORDER;
  const result = {};
  for (const key of selected) {
    result[key] = latestTag(key);
    if (!json) console.log(`${key} ${result[key]}`);
  }
  if (json) console.log(JSON.stringify(result));
}

// Allow importing latestTag() without running main().
if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  main().catch(err => {
    console.error(err);
    process.exit(1);
  });
}
