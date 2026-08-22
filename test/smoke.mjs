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
  // The bar is built by the client now; the page carries only the stats.
  assert(!html.includes('class="version-bar"'), 'no bar baked into the page');
  assert(!html.includes('version-segment'), 'no segments baked into the page');

  // embedded config: manifest versions + this page's per-section stats
  const inlineStart = html.indexOf('let versionBarManifest = ');
  assert(inlineStart !== -1, 'manifest embedded');
  const inline = html.slice(inlineStart, html.indexOf('</script>', inlineStart));
  assert(inline.startsWith('let versionBarManifest = {"versions":'), 'embedded manifest is versions-only');
  assert(!inline.includes('"sections"'), 'full section list stays out of pages');
  assert(
    inline.includes('let versionBarSections = {"sec-test":[null,[2,1]]}'),
    'per-section stats embedded, aligned to versions, null where absent',
  );
  assert(!inline.includes('sec-test-child'), 'no stats for a clause the manifest omits');
  assert(html.includes('let versionBarDataDir = "assets"'), 'data dir points at assets/');
  assert(!html.includes('</script><script>alert'), 'script breakout escaped');

  assert(html.includes('assets/css/widgets.css'), 'widgets.css linked');
  const coreTagIdx = html.indexOf('assets/js/versionBarCore.js');
  const barTagIdx = html.indexOf('assets/js/versionBar.js');
  const compareTagIdx = html.indexOf('assets/js/versionCompare.js');
  assert(coreTagIdx !== -1, 'versionBarCore.js script tag');
  assert(barTagIdx !== -1, 'versionBar.js script tag');
  assert(compareTagIdx !== -1, 'versionCompare.js script tag');
  // defer runs in declaration order, and versionBar.js needs both of them
  assert(coreTagIdx < barTagIdx, 'versionBarCore.js tag before versionBar.js');
  assert(compareTagIdx < barTagIdx, 'versionCompare.js tag before versionBar.js');
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
  // Section ids now reach the inline config script as object keys, so the
  // </script> breakout escaping in escapeForScript is what keeps them inside
  // the string literal. Exercise it via injectIntoHtml directly (the fixture
  // spec has no clause with the hostile id).
  const hostileHtml = injectIntoHtml(
    '<!DOCTYPE html><html><head><title>t</title></head><body>' +
      '<emu-clause id="&lt;/script&gt;&lt;script&gt;alert(1)&lt;/script&gt;">' +
      '<h1>Hostile</h1><p>x</p></emu-clause></body></html>',
    { relAssets: 'assets', relRoot: '', versionBar: { manifest }, implLinks: false },
  );
  const hStart = hostileHtml.indexOf('let versionBarManifest');
  assert(hStart !== -1, 'hostile page still gets embedded manifest');
  const hInline = hostileHtml.slice(hStart, hostileHtml.indexOf('</script>', hStart));
  assert(hInline.includes('versionBarSections'), 'hostile page carries its stats');
  assert(!/[<>]/.test(hInline), 'no raw angle bracket survives in the inline script');
  assert(
    hInline.includes('\\u003c/script\\u003e\\u003cscript\\u003ealert(1)'),
    'hostile id escaped into the string literal rather than dropped',
  );
  // The escaped source must still parse as JS, with the id preserved verbatim.
  const hostileCheck = path.join(tmp, 'hostile-config.js');
  fs.writeFileSync(hostileCheck, hInline);
  execFileSync(process.execPath, ['--check', hostileCheck]);
  const hostileKeys = Object.keys(
    new Function(hInline + '; return versionBarSections;')(),
  );
  assert(hostileKeys.includes(HOSTILE_ID), 'hostile id round-trips through the inline script');

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
