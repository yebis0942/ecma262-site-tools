// Inject site widgets into ecmarkup-generated HTML.
//
// This operates purely on the OUTPUT of ecmarkup (parse5 AST of the emitted
// HTML), so it depends only on the stable document shape — emu-clause /
// emu-annex elements with ids and their <h1> headers — and never on ecmarkup
// internals.
//
// Injected per page:
//   - <link> to widgets.css
//   - an inline <script> defining versionBarManifest (versions only — the full
//     section list stays on disk) / versionBarSections (this page's per-section
//     diff stats) / versionBarDataDir / implLinksDataUrl (paths computed
//     relative to each page, so multipage subpages resolve correctly)
//   - <script defer> tags for versionCompare.js / versionBarCore.js /
//     versionBar.js / implLinks.js (defer executes in declaration order, so
//     versionBar.js's dependencies are guaranteed to run before it)
//
// The version bar itself is NOT baked into the page: it is collapsed behind a
// per-clause button and built by the client from versionBarSections, which
// costs ~110 bytes per section instead of the ~2.5KB a rendered bar took.
import { parse, parseFragment, serialize } from 'parse5';

const SECTION_TAGS = new Set(['emu-clause', 'emu-annex']);

function walk(node, visit) {
  visit(node);
  for (const child of node.childNodes ?? []) walk(child, visit);
  if (node.content) walk(node.content, visit);
}

function getAttr(node, name) {
  const attr = node.attrs?.find(a => a.name === name);
  return attr != null ? attr.value : null;
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// Neutralize sequences that could break out of an inline <script> (section ids
// come from external HTML) or break the JS parse (U+2028/U+2029).
function escapeForScript(s) {
  return s
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

export function injectIntoHtml(html, { relAssets, relRoot, versionBar, implLinks }) {
  const doc = parse(html);

  let head = null;
  const clauses = [];
  walk(doc, node => {
    if (node.tagName === 'head' && head == null) head = node;
    if (node.tagName && SECTION_TAGS.has(node.tagName) && getAttr(node, 'id')) clauses.push(node);
  });
  if (!head) throw new Error('injectIntoHtml: no <head> found');

  // Per-page version-bar data: for each clause on this page that the manifest
  // knows about, an array aligned to manifest.versions — null where the
  // section is absent from that edition, [added, deleted] block counts where
  // present. Only this page's sections are emitted; the full manifest stays on
  // disk.
  let versionBarSections = null;
  if (versionBar) {
    const { manifest } = versionBar;
    versionBarSections = {};
    for (const clause of clauses) {
      const id = getAttr(clause, 'id');
      const sectionInfo = manifest.sections[id];
      if (!sectionInfo) continue;
      const stats = sectionInfo.stats ?? {};
      versionBarSections[id] = manifest.versions.map(version =>
        sectionInfo.presentIn.includes(version.key) ? (stats[version.key] ?? [0, 0]) : null,
      );
    }
  }

  // Head additions: stylesheet, config globals, widget scripts.
  // Scripts are appended after ecmarkup's own <script defer>, so they execute
  // after menu.js — the same order the fork used when concatenating.
  const config = [];
  if (versionBar) {
    // Only versions (keys + labels) are needed client-side; sections stay out
    // of every page — presence and stats are read from the injected bar DOM.
    const embeddedManifest = { versions: versionBar.manifest.versions };
    config.push(`let versionBarManifest = ${escapeForScript(JSON.stringify(embeddedManifest))};`);
    config.push(
      `let versionBarSections = ${escapeForScript(JSON.stringify(versionBarSections))};`,
    );
    config.push(`let versionBarDataDir = ${escapeForScript(JSON.stringify(relAssets))};`);
  }
  if (implLinks) {
    config.push(`window.implLinksDataUrl = ${escapeForScript(JSON.stringify(relRoot + 'impl-links.json'))};`);
  }
  let headHtml = `<link rel="stylesheet" href="${escapeHtml(relAssets)}/css/widgets.css">`;
  if (config.length > 0) headHtml += `<script>${config.join('\n')}</script>`;
  // Order matters: defer scripts execute in declaration order, and
  // versionBar.js wants versionBarCore.js (diff library, required at startup)
  // and versionCompare.js (release hashes for the compare link) before it.
  headHtml += `<script defer src="${escapeHtml(relAssets)}/js/versionCompare.js"></script>`;
  if (versionBar) {
    headHtml += `<script defer src="${escapeHtml(relAssets)}/js/versionBarCore.js"></script>`;
    headHtml += `<script defer src="${escapeHtml(relAssets)}/js/versionBar.js"></script>`;
  }
  if (implLinks) headHtml += `<script defer src="${escapeHtml(relAssets)}/js/implLinks.js"></script>`;

  const headFragment = parseFragment(headHtml);
  head.childNodes.push(...headFragment.childNodes);

  return serialize(doc);
}
