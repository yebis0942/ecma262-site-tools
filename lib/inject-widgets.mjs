// Inject site widgets into ecmarkup-generated HTML.
//
// This operates purely on the OUTPUT of ecmarkup (parse5 AST of the emitted
// HTML), so it depends only on the stable document shape — emu-clause /
// emu-annex elements with ids and their <h1> headers — and never on ecmarkup
// internals.
//
// Injected per page:
//   - <link> to widgets.css
//   - an inline <script> defining versionBarManifest (versions only — sections
//     stay on disk; presence/stats are baked into the bar DOM) /
//     versionBarDataDir / implLinksDataUrl (paths computed relative to each
//     page, so multipage subpages resolve correctly)
//   - <script defer> tags for versionBarCore.js / versionBar.js /
//     versionCompare.js / implLinks.js (defer executes in declaration order,
//     so versionBarCore.js is guaranteed to run before versionBar.js)
//   - a .version-bar element after each clause <h1> listed in the manifest,
//     with per-version diff stats (data-add/data-del) and bar heights baked in
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

// Maximum bar-graph height in px; heights are baked inline so the static page
// renders correctly without JS.
const BAR_MAX_HEIGHT = 28;

// Build the static version bar for one section from the v2 manifest: one
// <button> segment per version (present or absent), carrying data-version /
// data-index (index into manifest.versions) plus, for present versions,
// data-add / data-del diff-block counts and a mini bar graph whose heights are
// scaled to the section's max add+del total. Newlines between elements are
// fine (parse5 keeps them as whitespace text nodes outside the spans), but the
// insides of .vb-bar stay on one line so no stray text nodes land in the bar.
function versionBarHtml(sectionId, sectionInfo, versions) {
  const stats = sectionInfo.stats ?? {};
  let maxTotal = 0;
  for (const key of sectionInfo.presentIn) {
    const [add, del] = stats[key] ?? [0, 0];
    maxTotal = Math.max(maxTotal, add + del);
  }

  let segments = '';
  for (let index = 0; index < versions.length; index++) {
    const version = versions[index];
    const isPresent = sectionInfo.presentIn.includes(version.key);
    // "es6" -> "6"; fall back to the full key for unexpected key shapes.
    const editionNum = /^es(.+)$/.exec(version.key)?.[1] ?? version.key;
    if (isPresent) {
      const [add, del] = stats[version.key] ?? [0, 0];
      const total = add + del;
      const barH = maxTotal > 0 ? Math.round((total / maxTotal) * BAR_MAX_HEIGHT) : 0;
      let bar;
      if (total === 0) {
        bar = '<span class="vb-bar"><span class="vb-bar-flat"></span></span>';
      } else {
        const addH = Math.round((add / total) * barH);
        const delH = barH - addH;
        bar = `<span class="vb-bar"><span class="vb-bar-add" style="height:${addH}px"></span><span class="vb-bar-del" style="height:${delH}px"></span></span>`;
      }
      const title = `${version.label} — +${add} / −${del}`;
      segments += `
    <button type="button" class="version-segment" data-version="${escapeHtml(version.key)}" data-index="${index}" data-add="${add}" data-del="${del}" title="${escapeHtml(title)}">
      ${bar}
      <span class="vb-num">${escapeHtml(editionNum)}</span>
    </button>`;
    } else {
      const title = `${version.label} — not present in this version`;
      segments += `
    <button type="button" class="version-segment version-segment--absent" data-version="${escapeHtml(version.key)}" data-index="${index}" title="${escapeHtml(title)}">
      <span class="vb-bar"></span>
      <span class="vb-num">${escapeHtml(editionNum)}</span>
    </button>`;
    }
  }

  return `<div class="version-bar" data-section-id="${escapeHtml(sectionId)}">
  <div class="vb-row">${segments}
  </div>
</div>`;
}

// Find the clause's own <h1> (first h1 in document order that is not inside a
// nested section) and return { parent, index } for insertion after it.
function findOwnHeader(clause) {
  const search = node => {
    for (let i = 0; i < (node.childNodes?.length ?? 0); i++) {
      const child = node.childNodes[i];
      if (child.tagName && SECTION_TAGS.has(child.tagName)) continue; // don't descend into nested sections
      if (child.tagName === 'h1') return { parent: node, index: i };
      const found = search(child);
      if (found) return found;
    }
    return null;
  };
  return search(clause);
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

  // Version bars after each listed clause header
  if (versionBar) {
    const { manifest } = versionBar;
    for (const clause of clauses) {
      const id = getAttr(clause, 'id');
      const sectionInfo = manifest.sections[id];
      if (!sectionInfo) continue;
      const spot = findOwnHeader(clause);
      if (!spot) continue;
      const fragment = parseFragment(versionBarHtml(id, sectionInfo, manifest.versions));
      spot.parent.childNodes.splice(spot.index + 1, 0, ...fragment.childNodes);
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
    config.push(`let versionBarDataDir = ${escapeForScript(JSON.stringify(relAssets))};`);
  }
  if (implLinks) {
    config.push(`window.implLinksDataUrl = ${escapeForScript(JSON.stringify(relRoot + 'impl-links.json'))};`);
  }
  let headHtml = `<link rel="stylesheet" href="${escapeHtml(relAssets)}/css/widgets.css">`;
  if (config.length > 0) headHtml += `<script>${config.join('\n')}</script>`;
  if (versionBar) {
    // versionBarCore.js must come first: defer scripts execute in declaration
    // order, and versionBar.js requires the core diff library at startup.
    headHtml += `<script defer src="${escapeHtml(relAssets)}/js/versionBarCore.js"></script>`;
    headHtml += `<script defer src="${escapeHtml(relAssets)}/js/versionBar.js"></script>`;
  }
  headHtml += `<script defer src="${escapeHtml(relAssets)}/js/versionCompare.js"></script>`;
  if (implLinks) headHtml += `<script defer src="${escapeHtml(relAssets)}/js/implLinks.js"></script>`;

  const headFragment = parseFragment(headHtml);
  head.childNodes.push(...headFragment.childNodes);

  return serialize(doc);
}
