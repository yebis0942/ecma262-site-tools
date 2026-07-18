// Core pipeline: run ecmarkup's programmatic build, transform the generated
// files before anything touches disk, then write everything out.
//
//   ecmarkup.build() -> spec.generatedFiles (Map<path, contents>)
//     1. apply verified text patches to the menu.js portion of ecmarkup.js
//     2. inject widgets into every generated HTML page
//     3. add widget assets (css/js/data)
//     4. write
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ecmarkup from 'ecmarkup';
import { installMenuPatchHook } from './patch-menu.mjs';
import { injectIntoHtml } from './inject-widgets.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

const readAsset = name => fs.readFileSync(path.join(ROOT, 'assets', name), 'utf8');

export async function buildSite(options) {
  const {
    infile,
    outDir,
    multipage = false,
    lintSpec = false,
    verbose = false,
    versionBarManifestPath = null,
    implLinksDataPath = path.join(ROOT, 'data', 'impl-links.json'),
    menuPatches = true,
  } = options;

  const resolvedOut = path.resolve(outDir);
  const assetsDir = path.join(resolvedOut, 'assets');
  const outfile = multipage ? resolvedOut : path.join(resolvedOut, 'index.html');

  const emuOpts = {
    assets: 'external',
    assetsDir,
    outfile,
    multipage,
    lintSpec,
    warn: err => {
      const loc = err.line == null ? '' : `${err.line}:${err.column}: `;
      console.warn(`Warning: ${err.file ?? infile}: ${loc}${err.message}`);
    },
  };
  if (verbose) {
    emuOpts.log = msg => console.log(msg);
  }

  // 1. menu.js patches (search worker, ToC scroll optimization) are applied to
  // the SOURCE as ecmarkup reads it, before concatenation and minification.
  const patchHook = menuPatches ? installMenuPatchHook() : null;
  let spec;
  try {
    spec = await ecmarkup.build(
      path.resolve(infile),
      file => fs.promises.readFile(file, 'utf8'),
      emuOpts,
    );
  } finally {
    patchHook?.restore();
  }
  if (patchHook && !patchHook.fired()) {
    throw new Error(
      'menu.js patch hook never fired — ecmarkup stopped reading js/menu.js via utils.readFile; ' +
        'the pinned version changed its asset pipeline and the hook needs re-porting',
    );
  }
  if (patchHook && verbose) console.log(`Applied ${patchHook.count()} menu.js patches`);
  const files = new Map(spec.generatedFiles);

  // 2. version-bar manifest + per-section data
  let versionBar = null;
  if (versionBarManifestPath != null) {
    const manifest = JSON.parse(fs.readFileSync(versionBarManifestPath, 'utf8'));
    versionBar = { manifest };
    const dataSrc = path.join(path.dirname(path.resolve(versionBarManifestPath)), 'version-bar-data');
    if (fs.existsSync(dataSrc)) {
      for (const f of fs.readdirSync(dataSrc)) {
        if (!f.endsWith('.json')) continue;
        files.set(
          path.join(assetsDir, 'version-bar-data', path.basename(f)),
          fs.readFileSync(path.join(dataSrc, f), 'utf8'),
        );
      }
    } else {
      console.warn(
        `Warning: ${dataSrc} not found; version bars will render but per-section content will not load`,
      );
    }
  }

  // 3. widget assets
  files.set(path.join(assetsDir, 'css', 'widgets.css'), readAsset('widgets.css'));
  files.set(path.join(assetsDir, 'js', 'versionCompare.js'), readAsset('versionCompare.js'));
  if (versionBar != null) {
    files.set(path.join(assetsDir, 'js', 'versionBar.js'), readAsset('versionBar.js'));
  }
  let implLinks = false;
  if (implLinksDataPath != null && fs.existsSync(implLinksDataPath)) {
    files.set(path.join(assetsDir, 'js', 'implLinks.js'), readAsset('implLinks.js'));
    files.set(path.join(resolvedOut, 'impl-links.json'), fs.readFileSync(implLinksDataPath, 'utf8'));
    implLinks = true;
  } else if (implLinksDataPath != null) {
    console.warn(`Warning: impl-links data not found at ${implLinksDataPath}; widget disabled`);
  }

  // 4. inject widgets into every generated HTML page, with per-page relative paths
  for (const [key, contents] of files) {
    if (key == null || !key.endsWith('.html')) continue;
    const dir = path.dirname(key);
    const relAssets = path.relative(dir, assetsDir).split(path.sep).join('/') || '.';
    const rel = path.relative(dir, resolvedOut).split(path.sep).join('/');
    const relRoot = rel === '' ? '' : rel + '/';
    files.set(key, injectIntoHtml(String(contents), { relAssets, relRoot, versionBar, implLinks }));
  }

  // 5. write
  let written = 0;
  for (const [key, contents] of files) {
    if (key == null) continue;
    await fs.promises.mkdir(path.dirname(key), { recursive: true });
    await fs.promises.writeFile(key, contents);
    written++;
  }
  return { written, outDir: resolvedOut };
}
