#!/usr/bin/env node
// Build an ecmarkup spec with site widgets injected and menu.js patches applied.
//
// Usage:
//   ecma262-build <infile> <outdir> [options]
//
// Options:
//   --version-bar <manifest.json>  enable the version-bar widget; per-section
//                                  data is read from the sibling version-bar-data/
//   --impl-links <data.json>       impl-links data (default: bundled data/impl-links.json)
//   --no-impl-links                disable the impl-links widget
//   --multipage                    multipage build (outdir/index.html + multipage/*.html)
//   --lint-spec                    enable ecmarkup's spec lints
//   --no-menu-patches              skip the menu.js performance patches
//   --verbose                      log build progress
import { buildSite } from '../lib/build.mjs';

function fail(msg) {
  console.error(msg);
  process.exit(1);
}

const positional = [];
const options = {};
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
  const arg = argv[i];
  switch (arg) {
    case '--version-bar':
      options.versionBarManifestPath = argv[++i] ?? fail('--version-bar requires a path');
      break;
    case '--impl-links':
      options.implLinksDataPath = argv[++i] ?? fail('--impl-links requires a path');
      break;
    case '--no-impl-links':
      options.implLinksDataPath = null;
      break;
    case '--multipage':
      options.multipage = true;
      break;
    case '--lint-spec':
      options.lintSpec = true;
      break;
    case '--no-menu-patches':
      options.menuPatches = false;
      break;
    case '--verbose':
      options.verbose = true;
      break;
    default:
      if (arg.startsWith('--')) fail(`Unknown option: ${arg}`);
      positional.push(arg);
  }
}

if (positional.length !== 2) {
  fail('Usage: ecma262-build <infile> <outdir> [--version-bar <manifest.json>] [--impl-links <data.json>|--no-impl-links] [--multipage] [--lint-spec] [--no-menu-patches] [--verbose]');
}

const [infile, outDir] = positional;
buildSite({ infile, outDir, ...options })
  .then(({ written, outDir: out }) => {
    console.log(`Done: wrote ${written} files to ${out}`);
  })
  .catch(err => {
    console.error(err);
    process.exit(1);
  });
