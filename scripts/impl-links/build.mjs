#!/usr/bin/env node
// Driver for the impl-links data build. See DESIGN.md, section "Driver".
//
// Usage:
//   node scripts/impl-links/build.mjs [--root <engine>=<dir>]… [--only v8,qjs] [--verbose]
//
// - `--root <engine>=<dir>` overrides the checkout directory from config.mjs
//   (also accepts `--root ecma262=<dir>` to point at an ecma262 checkout
//   containing spec.html).
// - `--only v8,qjs` restricts the run to a subset of engines.
// - `--verbose` prints all unmatched names and warnings (default: first 20).
// - `IMPL_LINKS_EXTRACT_DIR=<dir>` overrides the extract/ directory (tests).

import { execFileSync } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

import { engines, ENGINE_ORDER, SPEC_HTML_PATH } from './config.mjs';
import { loadSpecNames, nameToKey } from './spec-names.mjs';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(SCRIPT_DIR, '..', '..');
const OUTPUT_PATH = join(REPO_ROOT, 'impl-links.json');
const EXTRACT_DIR = process.env.IMPL_LINKS_EXTRACT_DIR || join(SCRIPT_DIR, 'extract');
const LIST_LIMIT = 20;

function parseArgs(argv) {
  const opts = { roots: {}, only: null, verbose: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--verbose') {
      opts.verbose = true;
    } else if (arg === '--root') {
      const value = argv[++i];
      const eq = value == null ? -1 : value.indexOf('=');
      if (eq === -1) {
        console.error(`error: --root expects <engine>=<dir>, got ${value}`);
        process.exit(1);
      }
      opts.roots[value.slice(0, eq)] = resolve(value.slice(eq + 1));
    } else if (arg === '--only') {
      const value = argv[++i];
      if (value == null) {
        console.error('error: --only expects a comma-separated engine list');
        process.exit(1);
      }
      opts.only = value.split(',').map(s => s.trim());
    } else {
      console.error(`error: unknown argument ${arg}`);
      process.exit(1);
    }
  }
  return opts;
}

function git(dir, ...args) {
  return execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' }).trim();
}

function printList(header, items, verbose) {
  if (items.length === 0) return;
  const shown = verbose ? items : items.slice(0, LIST_LIMIT);
  console.log(`  ${header} (${items.length}):`);
  for (const item of shown) console.log(`    ${item}`);
  if (!verbose && items.length > shown.length) {
    console.log(`    … and ${items.length - shown.length} more (use --verbose)`);
  }
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));

  for (const name of opts.only ?? []) {
    if (!Object.hasOwn(engines, name)) {
      console.error(`error: unknown engine in --only: ${name}`);
      process.exit(1);
    }
  }

  const specHtmlPath = opts.roots.ecma262 ? join(opts.roots.ecma262, 'spec.html') : SPEC_HTML_PATH;
  const specNames = loadSpecNames(specHtmlPath);
  console.log(`spec names: ${specNames.size} (from ${specHtmlPath})`);

  const meta = { generated: new Date().toISOString(), engines: {} };
  // clauseId -> engineKey -> link entries
  const clauseData = new Map();

  for (const engineKey of ENGINE_ORDER) {
    if (opts.only && !opts.only.includes(engineKey)) continue;
    const config = engines[engineKey];

    const extractorPath = join(EXTRACT_DIR, `${engineKey}.mjs`);
    if (!existsSync(extractorPath)) {
      console.log(`[${engineKey}] skipped (no extractor at ${extractorPath})`);
      continue;
    }

    const root = opts.roots[engineKey] ?? config.ghqPath;
    if (!existsSync(root)) {
      console.log(`[${engineKey}] skipped (checkout not found at ${root})`);
      continue;
    }

    const rev = git(root, 'rev-parse', 'HEAD');
    let tag = null;
    try {
      tag = git(root, 'describe', '--tags', '--exact-match');
    } catch {
      console.log(`[${engineKey}] warning: HEAD is not at an exact tag`);
    }

    const mod = await import(pathToFileURL(extractorPath).href);
    let records, warnings;
    try {
      ({ records, warnings = [] } = await mod.extract(root));
    } catch (err) {
      console.log(`[${engineKey}] extractor failed: ${err.message}`);
      continue;
    }

    // Default template: the first one that is not a placeholder.
    const templateKeys = Object.keys(config.templates);
    const defaultTpl = templateKeys.find(k => config.templates[k] !== 'TODO') ?? templateKeys[0];

    const unmatched = [];
    let matchedClauses = 0;
    for (const record of records) {
      const clauseId = specNames.get(nameToKey(record.name));
      if (clauseId === undefined) {
        unmatched.push(record.name);
        continue;
      }
      if (!clauseData.has(clauseId)) clauseData.set(clauseId, {});
      const byEngine = clauseData.get(clauseId);
      if (!byEngine[engineKey]) {
        byEngine[engineKey] = [];
        matchedClauses++;
      }
      for (const link of record.links) {
        byEngine[engineKey].push({
          t: link.label,
          tpl: link.tpl ?? defaultTpl,
          p: link.path,
          l: link.line,
        });
      }
    }

    meta.engines[engineKey] = {
      label: config.label,
      repo: config.repo,
      tag,
      rev,
      templates: Object.fromEntries(
        Object.entries(config.templates).map(([k, tpl]) => [k, tpl.replaceAll('{rev}', rev)]),
      ),
    };

    console.log(
      `[${engineKey}] records: ${records.length}, matched clauses: ${matchedClauses}, ` +
        `unmatched names: ${unmatched.length}, warnings: ${warnings.length}`,
    );
    printList('unmatched', unmatched, opts.verbose);
    printList('warnings', warnings, opts.verbose);
  }

  // Sort clause keys for stable diffs; engine order within a clause is fixed
  // by insertion order (ENGINE_ORDER iteration above).
  const clauses = {};
  for (const clauseId of [...clauseData.keys()].sort()) {
    clauses[clauseId] = clauseData.get(clauseId);
  }

  writeFileSync(OUTPUT_PATH, JSON.stringify({ meta, clauses }, null, 2) + '\n');
  console.log(`wrote ${OUTPUT_PATH} (${Object.keys(clauses).length} clauses)`);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
