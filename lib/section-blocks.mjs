// Split sanitized section HTML into a marker skeleton plus leaf blocks.
//
// Input is the sanitized per-section fragment produced by
// scripts/generate-version-bar-data.ts (the innerHTML of its wrapper <div>,
// with all comment nodes removed by the sanitizer). Output is:
//   - skeleton: the fragment with each leaf block replaced by a
//     `<!--vb:N-->` comment marker (N = index into `blocks`),
//   - blocks:   the serialized HTML of each leaf block, in document order,
//   - keys:     a per-block comparison key (collapsed text content) used by
//     the diff, so bar stats and panel diffs agree by construction.
//
// This module is deliberately self-contained (it re-implements the tiny
// body-context parse helper instead of importing from scripts/) so the build
// library has no dependency on the generation script.
import { defaultTreeAdapter, parse, serialize, serializeOuter } from 'parse5';

// Elements that participate in block splitting. An element is a *container*
// (recursed into, kept in the skeleton) when every non-whitespace,
// non-comment child is one of these; otherwise it is a *leaf block*.
// td/th are intentionally absent so a <tr> is always a row-granularity leaf.
const BLOCK_TAGS = new Set([
  'p',
  'div',
  'section',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'ul',
  'ol',
  'li',
  'dl',
  'dt',
  'dd',
  'table',
  'thead',
  'tbody',
  'tfoot',
  'caption',
  'tr',
  'figure',
  'figcaption',
  'blockquote',
  'pre',
  'emu-alg',
  'emu-note',
  'emu-table',
  'emu-figure',
  'emu-example',
  'emu-grammar',
  'emu-eqn',
  'emu-import',
]);

const MARKER_RE = /<!--vb:(\d+)-->/g;

/**
 * Parse a fragment in <body> context and return the wrapper <div> we supply.
 * Mirrors parseInBodyContext in scripts/generate-version-bar-data.ts so the
 * fragment parses exactly as it did during sanitization (and as the client
 * will parse it via innerHTML).
 */
function parseInBodyContext(fragment) {
  const doc = parse(
    `<!DOCTYPE html><html><head></head><body><div>${fragment}</div></body></html>`,
  );
  const htmlEl = doc.childNodes.find(n => n.tagName === 'html');
  const body = htmlEl.childNodes.find(n => n.tagName === 'body');
  return body.childNodes[0];
}

function isWhitespaceText(node) {
  return node.nodeName === '#text' && /^\s*$/.test(node.value);
}

function isComment(node) {
  return node.nodeName === '#comment';
}

/** True when every non-whitespace, non-comment child is a BLOCK_TAGS element. */
function isContainer(el) {
  for (const child of el.childNodes ?? []) {
    if (isWhitespaceText(child) || isComment(child)) continue;
    if (child.tagName != null && BLOCK_TAGS.has(child.tagName)) continue;
    return false;
  }
  return true;
}

/** Concatenated text content of a subtree (including <template> contents). */
function textContent(node) {
  if (node.nodeName === '#text') return node.value;
  let out = '';
  for (const child of node.childNodes ?? []) {
    out += textContent(child);
  }
  if (node.content) out += textContent(node.content);
  return out;
}

function collapseWhitespace(s) {
  return s.replace(/\s+/g, ' ').trim();
}

/**
 * Walk an element's children, replacing each leaf block with a `<!--vb:N-->`
 * comment node and pushing its serialized HTML / comparison key. Container
 * elements are recursed into and stay in the skeleton. Text and comment
 * children stay in the skeleton as-is. The same rule applies at the fragment
 * root (the wrapper div): non-BLOCK elements there become leaves too.
 */
function extractBlocks(el, blocks, keys) {
  const children = el.childNodes ?? [];
  for (let i = 0; i < children.length; i++) {
    const child = children[i];
    if (child.tagName == null) continue; // text / comment: keep in skeleton
    if (BLOCK_TAGS.has(child.tagName) && isContainer(child)) {
      extractBlocks(child, blocks, keys);
      continue;
    }
    // Leaf block: serialize the whole subtree, then swap in the marker.
    const html = serializeOuter(child);
    const key = collapseWhitespace(textContent(child)) || collapseWhitespace(html);
    const marker = defaultTreeAdapter.createCommentNode(`vb:${blocks.length}`);
    marker.parentNode = el;
    blocks.push(html);
    keys.push(key);
    children[i] = marker;
  }
}

/**
 * Split sanitized section HTML into { skeleton, blocks, keys }.
 *
 * Throws (fail-loud) when the resulting skeleton's markers do not line up
 * with the blocks — e.g. when the input already contained a `<!--vb:N-->`
 * comment, which the sanitizer's comment stripping is supposed to prevent.
 */
export function splitSectionHtml(sanitizedHtml) {
  const wrapper = parseInBodyContext(sanitizedHtml);
  const blocks = [];
  const keys = [];
  extractBlocks(wrapper, blocks, keys);

  // serialize() emits the node's children — i.e. the wrapper's innerHTML.
  const skeleton = serialize(wrapper);

  // Fail-loud invariants: markers appear exactly once each, in index order.
  if (keys.length !== blocks.length) {
    throw new Error(
      `splitSectionHtml: keys/blocks length mismatch (${keys.length} !== ${blocks.length})`,
    );
  }
  let expected = 0;
  for (const match of skeleton.matchAll(MARKER_RE)) {
    if (Number(match[1]) !== expected) {
      throw new Error(
        `splitSectionHtml: marker <!--vb:${match[1]}--> out of order (expected vb:${expected}); ` +
          'the input probably contained a marker-like comment that the sanitizer should have removed',
      );
    }
    expected++;
  }
  if (expected !== blocks.length) {
    throw new Error(
      `splitSectionHtml: skeleton has ${expected} markers but ${blocks.length} blocks; ` +
        'the input probably contained a marker-like comment that the sanitizer should have removed',
    );
  }

  return { skeleton, blocks, keys };
}

/**
 * Reassemble the full fragment HTML from a skeleton and its blocks.
 *
 * This is the reference expansion the client mirrors (a single-pass
 * `String.replace`, so markers inside block content are never re-expanded).
 * Throws when the marker set does not match `blocks` exactly.
 */
export function expandSkeleton(skeleton, blocks) {
  let count = 0;
  const out = skeleton.replace(MARKER_RE, (_, idx) => {
    const i = Number(idx);
    if (i >= blocks.length) {
      throw new Error(`expandSkeleton: marker vb:${i} has no matching block (${blocks.length} blocks)`);
    }
    count++;
    return blocks[i];
  });
  if (count !== blocks.length) {
    throw new Error(`expandSkeleton: expanded ${count} markers but have ${blocks.length} blocks`);
  }
  return out;
}
