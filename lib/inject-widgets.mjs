// Inject site widgets into ecmarkup-generated HTML.
//
// This operates purely on the OUTPUT of ecmarkup (parse5 AST of the emitted
// HTML), so it depends only on the stable document shape — emu-clause /
// emu-annex elements with ids and their <h1> headers — and never on ecmarkup
// internals.
//
// Injected per page:
//   - <link> to widgets.css
//   - an inline <script> defining versionBarManifest / versionBarDataDir /
//     implLinksDataUrl (paths computed relative to each page, so multipage
//     subpages resolve correctly)
//   - <script defer> tags for versionBar.js / versionCompare.js / implLinks.js
//   - a .version-bar element after each clause <h1> listed in the manifest
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

// Port of the fork's Spec.ts buildVersionBars segment construction.
function versionBarHtml(sectionId, sectionInfo, versions) {
  let html = `<div class="version-bar" data-section-id="${escapeHtml(sectionId)}">`;
  for (const version of versions) {
    const isPresent = sectionInfo.presentIn.includes(version.key);
    const cls = isPresent ? 'version-segment' : 'version-segment version-segment--absent';
    // "es6" -> "6"; fall back to the full key for unexpected key shapes.
    const editionNum = /^es(.+)$/.exec(version.key)?.[1] ?? version.key;
    const title = isPresent ? version.label : `${version.label} — not present in this version`;
    html += `<span class="${cls}" data-version="${escapeHtml(version.key)}" title="${escapeHtml(title)}">${escapeHtml(editionNum)}</span>`;
  }
  return html + '</div>';
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
    config.push(`let versionBarManifest = ${escapeForScript(JSON.stringify(versionBar.manifest))};`);
    config.push(`let versionBarDataDir = ${escapeForScript(JSON.stringify(relAssets))};`);
  }
  if (implLinks) {
    config.push(`window.implLinksDataUrl = ${escapeForScript(JSON.stringify(relRoot + 'impl-links.json'))};`);
  }
  let headHtml = `<link rel="stylesheet" href="${escapeHtml(relAssets)}/css/widgets.css">`;
  if (config.length > 0) headHtml += `<script>${config.join('\n')}</script>`;
  if (versionBar) headHtml += `<script defer src="${escapeHtml(relAssets)}/js/versionBar.js"></script>`;
  headHtml += `<script defer src="${escapeHtml(relAssets)}/js/versionCompare.js"></script>`;
  if (implLinks) headHtml += `<script defer src="${escapeHtml(relAssets)}/js/implLinks.js"></script>`;

  const headFragment = parseFragment(headHtml);
  head.childNodes.push(...headFragment.childNodes);

  return serialize(doc);
}
