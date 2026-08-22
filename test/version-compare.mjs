// Unit tests for assets/versionCompare.js — the release-boundary data behind
// the version bar's "open in ecma262-compare" action. Requiring the file from
// Node performs no fetch (the load is browser-only), so this runs offline.
import assert from 'node:assert';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const releases = createRequire(import.meta.url)(
  path.join(HERE, '..', 'assets', 'versionCompare.js'),
);

// --- label resolution --------------------------------------------------------
assert.strictEqual(
  releases.hashFor('ES2020'),
  '1b7ca8d5c87f2655acf976ae72efcbf75f48ca15',
  'bare year label resolves',
);
assert.strictEqual(
  releases.hashFor('ES2020 (11th)'),
  '1b7ca8d5c87f2655acf976ae72efcbf75f48ca15',
  'version-bar manifest label resolves to the same hash',
);
// ES2015 predates the compare tool's boundaries: no hash, and callers must
// degrade rather than build a broken URL.
assert.strictEqual(releases.hashFor('ES2015 (6th)'), null, 'ES2015 has no boundary');
assert.strictEqual(releases.hashFor('nonsense'), null, 'unparseable label is null');

// --- URL building ------------------------------------------------------------
const url = releases.compareUrl('ES2023 (14th)', 'ES2024 (15th)', 'sec-array.prototype.sort');
assert(url.startsWith('https://arai-a.github.io/ecma262-compare/?from='), 'compare host');
assert(url.includes('&id=sec-array.prototype.sort'), 'section id carried');
assert(url.includes('1c5ca183844ab453f939f1ee6165747c8b1c64ee'), 'from hash');
assert(url.includes('6ec325c22e9b3c47397c95c6b301491e76edb768'), 'to hash');
assert.strictEqual(
  releases.compareUrl('ES2015 (6th)', 'ES2024 (15th)', 'sec-x'),
  null,
  'a range with no boundary yields no URL',
);

// ids are percent-encoded, so a hostile id cannot break out of the query
const hostile = releases.compareUrl('ES2023', 'ES2024', 'sec-x&from=evil#frag');
assert(!hostile.includes('sec-x&from=evil'), 'hostile id encoded');
assert(hostile.includes(encodeURIComponent('sec-x&from=evil#frag')), 'hostile id preserved encoded');

// --- releases.json merge -----------------------------------------------------
let notified = 0;
releases.subscribe(() => notified++);

// A malformed payload must be ignored whole, not applied in part.
releases.applyReleases([{ release: 'es2024', hash: 'deadbeef' }, { release: 'es2026' }]);
assert.strictEqual(
  releases.hashFor('ES2024'),
  '6ec325c22e9b3c47397c95c6b301491e76edb768',
  'partial payload leaves the fallback untouched',
);
assert.strictEqual(notified, 0, 'no notification for a rejected payload');

// A good payload updates known labels and appends unknown ones.
releases.applyReleases([
  { release: 'es2024', hash: 'aaaa000000000000000000000000000000000000', seq: 9 },
  { release: 'es2026', hash: 'bbbb000000000000000000000000000000000000', seq: 11 },
]);
assert.strictEqual(releases.hashFor('ES2024'), 'aaaa000000000000000000000000000000000000', 'known label updated');
assert.strictEqual(releases.hashFor('ES2026'), 'bbbb000000000000000000000000000000000000', 'unknown release appended');
assert.strictEqual(
  releases.hashFor('ES2023'),
  '1c5ca183844ab453f939f1ee6165747c8b1c64ee',
  'labels absent from the payload keep their fallback',
);
assert.strictEqual(notified, 1, 'subscribers notified once');

console.log('version-compare: all assertions passed');
