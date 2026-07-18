// Build-time verified text patches for the menu.js portion of the emitted
// assets/js/ecmarkup.js.
//
// Each patch is a { find, replace } pair stored under patches/menu.js/NN-name/:
//   find.txt    — the exact text as it appears in the pinned ecmarkup version
//   replace.txt — the replacement (our verified fork implementation)
//
// Every find must occur exactly once; otherwise the build fails loudly. This is
// deliberate: when the pinned ecmarkup version is bumped and upstream changed a
// patched region, the build error points at exactly which patch needs to be
// re-ported (see README "Upgrading ecmarkup").
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const PATCH_DIR = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'patches',
  'menu.js',
);

export function applyMenuPatches(source) {
  const names = fs.readdirSync(PATCH_DIR).sort();
  let out = String(source);
  for (const name of names) {
    const find = fs.readFileSync(path.join(PATCH_DIR, name, 'find.txt'), 'utf8');
    const replace = fs.readFileSync(path.join(PATCH_DIR, name, 'replace.txt'), 'utf8');
    const i = out.indexOf(find);
    if (i < 0) {
      throw new Error(
        `menu.js patch "${name}": target text not found. ` +
          'The pinned ecmarkup version probably changed this region — re-port the patch (see README).',
      );
    }
    if (out.indexOf(find, i + 1) >= 0) {
      throw new Error(`menu.js patch "${name}": target text matches more than once; refusing to guess.`);
    }
    out = out.slice(0, i) + replace + out.slice(i + find.length);
  }
  return { patched: out, count: names.length };
}

// ecmarkup 24.x minifies the concatenated js asset, so post-build patching of
// the emitted file cannot match the source text. Instead, hook ecmarkup's own
// utils.readFile (called at build time to read js/menu.js before concatenation
// and minification) and patch the SOURCE as it is read. The call site accesses
// utils.readFile as a property, so overriding it here is effective; the pinned
// ecmarkup version plus the fired() assertion in build.mjs keep this honest.
export function installMenuPatchHook() {
  const requireCjs = createRequire(import.meta.url);
  const emuUtils = requireCjs('ecmarkup/lib/utils');
  const original = emuUtils.readFile;
  let count = 0;
  let fired = false;
  emuUtils.readFile = async file => {
    const contents = await original(file);
    if (file.endsWith(path.join('js', 'menu.js'))) {
      fired = true;
      const result = applyMenuPatches(contents);
      count = result.count;
      return result.patched;
    }
    return contents;
  };
  return {
    fired: () => fired,
    count: () => count,
    restore: () => {
      emuUtils.readFile = original;
    },
  };
}
