// End-to-end smoke test: build the fixture spec with all widgets enabled and
// assert that injection and menu.js patching actually happened in the output.
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { buildSite } from '../lib/build.mjs';
import { injectIntoHtml } from '../lib/inject-widgets.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'site-tools-smoke-'));

// exercises the </script> breakout escaping
const HOSTILE_ID = '</script><script>alert(1)</script>';

try {
  // version-bar fixture: v2 manifest + sibling data dir
  const vbDir = path.join(tmp, 'vb');
  fs.mkdirSync(path.join(vbDir, 'version-bar-data'), { recursive: true });
  const versions = [
    { key: 'es6', label: 'ES2015 (6th)' },
    { key: 'es15', label: 'ES2024 (15th)' },
  ];
  const manifest = {
    schemaVersion: 2,
    versions,
    sections: {
      'sec-test': { presentIn: ['es15'], stats: { es15: [2, 1] } },
      [HOSTILE_ID]: { presentIn: ['es6'], stats: { es6: [1, 0] } },
    },
  };
  const manifestPath = path.join(vbDir, 'manifest.json');
  fs.writeFileSync(manifestPath, JSON.stringify(manifest));
  fs.writeFileSync(
    path.join(vbDir, 'version-bar-data', 'sec-test.json'),
    JSON.stringify({
      schemaVersion: 2,
      versions: {
        es15: { skeleton: '<!--vb:0-->', blocks: ['<p>content</p>'], keys: ['content'], blame: [1] },
      },
    }),
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
  assert(html.replace(/\n/g, '').includes('</h1><div class="version-bar"'), 'bar directly after h1');
  assert(html.includes('version-segment--absent'), 'absent segment rendered');
  assert(html.includes('data-add="2" data-del="1"'), 'diff stats baked into segment');
  assert(html.includes('data-index='), 'version index baked into segment');

  // embedded config: versions only — sections stay out of every page
  const inlineStart = html.indexOf('let versionBarManifest = ');
  assert(inlineStart !== -1, 'manifest embedded');
  const inline = html.slice(inlineStart, html.indexOf('</script>', inlineStart));
  assert(inline.startsWith('let versionBarManifest = {"versions":'), 'embedded manifest is versions-only');
  assert(!inline.includes('"sections"'), 'sections not embedded in pages');
  assert(html.includes('let versionBarDataDir = "assets"'), 'data dir points at assets/');
  assert(!html.includes('</script><script>alert'), 'script breakout escaped');

  assert(html.includes('assets/css/widgets.css'), 'widgets.css linked');
  const coreTagIdx = html.indexOf('assets/js/versionBarCore.js');
  const barTagIdx = html.indexOf('assets/js/versionBar.js');
  assert(coreTagIdx !== -1, 'versionBarCore.js script tag');
  assert(barTagIdx !== -1, 'versionBar.js script tag');
  assert(coreTagIdx < barTagIdx, 'versionBarCore.js tag before versionBar.js (defer runs in order)');
  assert(html.includes('assets/js/versionCompare.js'), 'versionCompare.js script tag');
  assert(html.includes('assets/js/implLinks.js'), 'implLinks.js script tag');
  assert(html.includes('window.implLinksDataUrl = "impl-links.json"'), 'implLinks data url');

  for (const f of [
    'assets/css/widgets.css',
    'assets/js/versionBarCore.js',
    'assets/js/versionBar.js',
    'assets/js/versionCompare.js',
    'assets/js/implLinks.js',
    'assets/version-bar-data/sec-test.json',
    'impl-links.json',
  ]) {
    assert(fs.existsSync(path.join(outDir, f)), `asset emitted: ${f}`);
  }

  // --- hostile section id ---------------------------------------------------
  // The fixture spec has no clause with the hostile id, so exercise the bar
  // markup for it via injectIntoHtml directly: the id must land only inside a
  // quoted attribute value (safe — the tokenizer does not recognize </script>
  // there), never inside the inline config script.
  const hostileHtml = injectIntoHtml(
    '<!DOCTYPE html><html><head><title>t</title></head><body>' +
      '<emu-clause id="&lt;/script&gt;&lt;script&gt;alert(1)&lt;/script&gt;">' +
      '<h1>Hostile</h1><p>x</p></emu-clause></body></html>',
    { relAssets: 'assets', relRoot: '', versionBar: { manifest }, implLinks: false },
  );
  assert(
    hostileHtml.includes(`data-section-id="${HOSTILE_ID}"`),
    'hostile id confined to a quoted attribute value',
  );
  const hStart = hostileHtml.indexOf('let versionBarManifest');
  assert(hStart !== -1, 'hostile page still gets embedded manifest');
  const hInline = hostileHtml.slice(hStart, hostileHtml.indexOf('</script>', hStart));
  assert(!hInline.includes('alert(1)'), 'hostile id never reaches the inline script');

  // --- v1 manifest rejected fail-loud ---------------------------------------
  const v1Dir = path.join(tmp, 'vb-v1');
  fs.mkdirSync(v1Dir, { recursive: true });
  const v1ManifestPath = path.join(v1Dir, 'manifest.json');
  fs.writeFileSync(
    v1ManifestPath,
    JSON.stringify({ versions, sections: { 'sec-test': { presentIn: ['es15'] } } }),
  );
  let v1Error = null;
  try {
    await buildSite({
      infile: path.join(HERE, 'fixtures', 'spec.html'),
      outDir: path.join(tmp, 'out-v1'),
      versionBarManifestPath: v1ManifestPath,
    });
  } catch (err) {
    v1Error = err;
  }
  assert(v1Error != null, 'v1 manifest must be rejected');
  assert(v1Error.message.includes('schemaVersion'), 'v1 rejection names schemaVersion');
  assert(v1Error.message.includes('generate-version-bar-data'), 'v1 rejection tells how to regenerate');

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
