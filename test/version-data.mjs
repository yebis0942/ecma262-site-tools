// Unit tests for lib/version-data.mjs (computeVersionData). The diff
// implementation is the real assets/versionBarCore.js loaded via CJS require,
// so this doubles as an integration test of the two modules together.
import assert from 'node:assert';
import { createRequire } from 'node:module';
import { computeVersionData } from '../lib/version-data.mjs';

const require = createRequire(import.meta.url);
const { diffSequences } = require('../assets/versionBarCore.js');

// Global version order (manifest.versions): es6=0, es11=1, es13=2, es15=3.
const versionIndexByKey = new Map([
  ['es6', 0],
  ['es11', 1],
  ['es13', 2],
  ['es15', 3],
]);
const FIRST = 'es6';

function split(keys) {
  // skeleton/blocks content is passed through untouched by computeVersionData;
  // derive trivial stand-ins from the keys.
  return {
    skeleton: keys.map((_, i) => `<!--vb:${i}-->`).join(''),
    blocks: keys.map(k => `<p>${k}</p>`),
    keys,
  };
}

// --- section present since the first config version, with a gap -------------
// Present in es6, es13, es15 (absent in es11): stats for es13 must be
// computed against es6 (the previous *present* version), and blame must
// chain across the gap.
{
  const splitByKey = new Map([
    ['es6', split(['title', 'step a', 'step b'])],
    // es13: 'step a' replaced by 'step a2'
    ['es13', split(['title', 'step a2', 'step b'])],
    // es15: 'step c' appended
    ['es15', split(['title', 'step a2', 'step b', 'step c'])],
  ]);
  const { perVersion, stats } = computeVersionData(
    ['es6', 'es13', 'es15'],
    splitByKey,
    versionIndexByKey,
    FIRST,
    diffSequences,
  );

  // First config version: [0, 0] even though everything is "new" there.
  assert.deepStrictEqual(stats.es6, [0, 0]);
  // Replacement counts one add and one del, diffed across the es11 gap.
  assert.deepStrictEqual(stats.es13, [1, 1]);
  assert.deepStrictEqual(stats.es15, [1, 0]);
  assert.strictEqual(stats.es11, undefined, 'absent versions get no stats');

  // Blame: es6 blocks all blame es6 (index 0, displayed as "es6 or earlier").
  assert.deepStrictEqual(perVersion.es6.blame, [0, 0, 0]);
  // es13: 'title'/'step b' carried over from es6, 'step a2' introduced here.
  assert.deepStrictEqual(perVersion.es13.blame, [0, 2, 0]);
  // es15: carried blame survives a second hop; 'step c' is new here.
  assert.deepStrictEqual(perVersion.es15.blame, [0, 2, 0, 3]);

  // Pass-through of the split data.
  assert.strictEqual(perVersion.es13.skeleton, splitByKey.get('es13').skeleton);
  assert.deepStrictEqual(perVersion.es13.blocks, splitByKey.get('es13').blocks);
  assert.deepStrictEqual(perVersion.es13.keys, splitByKey.get('es13').keys);
  assert.deepStrictEqual(Object.keys(perVersion), ['es6', 'es13', 'es15']);
}

// --- section first appearing mid-history: all-added stats -------------------
{
  const splitByKey = new Map([
    ['es13', split(['title', 'step a'])],
    ['es15', split(['title', 'step a', 'step b'])],
  ]);
  const { perVersion, stats } = computeVersionData(
    ['es13', 'es15'],
    splitByKey,
    versionIndexByKey,
    FIRST,
    diffSequences,
  );
  // Mid-history first appearance: everything counts as added.
  assert.deepStrictEqual(stats.es13, [2, 0]);
  assert.deepStrictEqual(stats.es15, [1, 0]);
  // All first-appearance blocks blame the introducing version itself.
  assert.deepStrictEqual(perVersion.es13.blame, [2, 2]);
  assert.deepStrictEqual(perVersion.es15.blame, [2, 2, 3]);
}

// --- deletions only ---------------------------------------------------------
{
  const splitByKey = new Map([
    ['es6', split(['title', 'step a', 'step b'])],
    ['es15', split(['title', 'step b'])],
  ]);
  const { perVersion, stats } = computeVersionData(
    ['es6', 'es15'],
    splitByKey,
    versionIndexByKey,
    FIRST,
    diffSequences,
  );
  assert.deepStrictEqual(stats.es15, [0, 1]);
  assert.deepStrictEqual(perVersion.es15.blame, [0, 0]);
}

// --- fail-loud on inconsistent inputs ---------------------------------------
{
  assert.throws(
    () =>
      computeVersionData(['es13'], new Map(), versionIndexByKey, FIRST, diffSequences),
    /no split content/,
  );
  assert.throws(
    () =>
      computeVersionData(
        ['esXX'],
        new Map([['esXX', split(['a'])]]),
        versionIndexByKey,
        FIRST,
        diffSequences,
      ),
    /unknown version key/,
  );
  assert.throws(
    () =>
      computeVersionData(
        ['es6'],
        new Map([['es6', { skeleton: '', blocks: ['<p>a</p>'], keys: [] }]]),
        versionIndexByKey,
        FIRST,
        diffSequences,
      ),
    /length mismatch/,
  );
}

// --- empty present list is a no-op ------------------------------------------
{
  const { perVersion, stats } = computeVersionData(
    [],
    new Map(),
    versionIndexByKey,
    FIRST,
    diffSequences,
  );
  assert.deepStrictEqual(perVersion, {});
  assert.deepStrictEqual(stats, {});
}

console.log('version-data: all assertions passed');
