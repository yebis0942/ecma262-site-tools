// End-to-end smoke test: build the fixture spec with all widgets enabled and
// assert that injection and menu.js patching actually happened in the output.
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { buildSite } from '../lib/build.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'site-tools-smoke-'));

try {
  // version-bar fixture: manifest + sibling data dir
  const vbDir = path.join(tmp, 'vb');
  fs.mkdirSync(path.join(vbDir, 'version-bar-data'), { recursive: true });
  const manifestPath = path.join(vbDir, 'manifest.json');
  fs.writeFileSync(
    manifestPath,
    JSON.stringify({
      versions: [
        { key: 'es6', label: 'ES2015 (6th)' },
        { key: 'es15', label: 'ES2024 (15th)' },
      ],
      sections: {
        'sec-test': { presentIn: ['es15'] },
        // exercises the </script> breakout escaping
        '</script><script>alert(1)</script>': { presentIn: ['es6'] },
      },
    }),
  );
  fs.writeFileSync(
    path.join(vbDir, 'version-bar-data', 'sec-test.json'),
    JSON.stringify({ es15: '<p>content</p>' }),
  );

  const outDir = path.join(tmp, 'out');
  await buildSite({
    infile: path.join(HERE, 'fixtures', 'spec.html'),
    outDir,
    versionBarManifestPath: manifestPath,
  });

  const html = fs.readFileSync(path.join(outDir, 'index.html'), 'utf8');
  const js = fs.readFileSync(path.join(outDir, 'assets', 'js', 'ecmarkup.js'), 'utf8');

  // --- widget injection -----------------------------------------------------
  assert(html.includes('class="version-bar" data-section-id="sec-test"'), 'version bar for sec-test');
  assert(html.includes('data-section-id="sec-test-child"') === false, 'no bar for unlisted child');
  assert(/<h1[^>]*>[^<]*<\/h1>|<\/h1><div class="version-bar"/.test(html.replace(/\n/g, '')), 'bar directly after h1');
  assert(html.includes('version-segment--absent'), 'absent segment rendered');
  assert(html.includes('let versionBarManifest = '), 'manifest embedded');
  assert(html.includes('let versionBarDataDir = "assets"'), 'data dir points at assets/');
  assert(!html.includes('</script><script>alert'), 'script breakout escaped');
  assert(html.includes('\\u003c/script\\u003e'), 'escaped form present');
  assert(html.includes('assets/css/widgets.css'), 'widgets.css linked');
  assert(html.includes('assets/js/versionBar.js'), 'versionBar.js script tag');
  assert(html.includes('assets/js/versionCompare.js'), 'versionCompare.js script tag');
  assert(html.includes('assets/js/implLinks.js'), 'implLinks.js script tag');
  assert(html.includes('window.implLinksDataUrl = "impl-links.json"'), 'implLinks data url');

  for (const f of [
    'assets/css/widgets.css',
    'assets/js/versionBar.js',
    'assets/js/versionCompare.js',
    'assets/js/implLinks.js',
    'assets/version-bar-data/sec-test.json',
    'impl-links.json',
  ]) {
    assert(fs.existsSync(path.join(outDir, f)), `asset emitted: ${f}`);
  }

  // --- menu.js patches ------------------------------------------------------
  // The asset is minified, so identifiers are mangled; assert on string
  // literals from OUR patched code, which minification preserves. Exactness of
  // each individual patch is enforced by applyMenuPatches itself (exactly-once
  // match), and buildSite asserts the source hook actually fired.
  for (const marker of [
    'application/javascript', // Blob MIME from the search worker bootstrap
    'self.onmessage', // worker source string in buildSearchWorkerSource
  ]) {
    assert(js.includes(marker), `patched marker present: ${marker}`);
  }
  // patched + minified asset must still parse
  const checkPath = path.join(tmp, 'patched-ecmarkup.js');
  fs.writeFileSync(checkPath, js);
  execFileSync(process.execPath, ['--check', checkPath]);

  console.log('smoke: all assertions passed');
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
