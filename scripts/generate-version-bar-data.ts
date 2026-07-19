/**
 * Generate version bar data from published ECMAScript specification HTML files.
 *
 * Usage:
 *   npx tsx scripts/generate-version-bar-data.ts [--config scripts/version-bar-config.json] [--spec-html path/to/current-spec.html] --out-dir out/version-bar-data
 *
 * Memory: parsing uses parse5 directly (plain-object ASTs, several times
 * smaller than jsdom documents and reliably GC'd), so a full multi-edition run
 * fits comfortably in the default Node heap.
 *
 * This script:
 * 1. Reads version config (version keys, labels, URLs)
 * 2. Fetches each version's HTML (with disk cache in .version-cache/)
 * 3. Parses sections from each version using parse5
 * 4. Optionally reads oldids from the current spec to map renamed section IDs
 * 5. Splits each section's sanitized HTML into leaf blocks (lib/section-blocks.mjs)
 *    and chains diffs across editions (lib/version-data.mjs + assets/versionBarCore.js)
 *    to compute per-version diff stats and per-block blame
 * 6. Outputs (schema v2):
 *    - version-bar-manifest.json:
 *      { schemaVersion: 2, versions, sections: { [id]: { presentIn, stats } } }
 *      where stats[versionKey] = [addedBlocks, deletedBlocks] vs the previous
 *      present version ([0,0] for sections already present in the first edition,
 *      [blocks.length, 0] for sections first appearing mid-history)
 *    - version-bar-data/<section-id>.json:
 *      { schemaVersion: 2, versions: { [key]: { skeleton, blocks, keys, blame } } }
 *      (present versions only; skeleton uses <!--vb:N--> markers, blame[i] is the
 *      global index into manifest.versions of the edition that introduced blocks[i])
 */

import * as fs from 'fs';
import * as path from 'path';
// parse5 (already a direct dependency of ecmarkup) builds plain-object ASTs
// that are an order of magnitude smaller than jsdom documents and are reliably
// garbage-collected. jsdom itself parses and serializes through parse5, so the
// serialized output is identical to the previous jsdom-based implementation.
import { parse, serialize } from 'parse5';
import { pathToFileURL } from 'url';

// A single diff operation from versionBarCore's diffSequences.
interface DiffOp {
  type: 'same' | 'add' | 'del';
  ai: number;
  bi: number;
}

// Shared diff core (UMD-lite). This script runs under tsx's CJS mode
// (__dirname is used throughout), so a plain require works.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { diffSequences } = require('../assets/versionBarCore.js') as {
  diffSequences: (aKeys: string[], bKeys: string[], opts?: { maxCells?: number }) => DiffOp[];
};

// Output of lib/section-blocks.mjs' splitSectionHtml.
interface SectionSplit {
  skeleton: string;
  blocks: string[];
  keys: string[];
}

// Per-version payload of the v2 per-section JSON files.
interface SectionVersionData extends SectionSplit {
  blame: number[];
}

// Manifest shape (schema v2) consumed by lib/inject-widgets.mjs and the
// versionBar.js client. stats[versionKey] = [added, deleted] block counts vs
// the previous present version (present versions only).
interface VersionBarManifest {
  schemaVersion: 2;
  versions: { key: string; label: string }[];
  sections: Record<string, { presentIn: string[]; stats: Record<string, [number, number]> }>;
}

interface VersionConfig {
  key: string;
  label: string;
  url: string;
}

interface Config {
  versions: VersionConfig[];
}

interface Args {
  configPath: string;
  outDir: string;
  specHtml: string;
}

function parseArgs(argv: string[]): Args {
  let configPath = path.join(__dirname, 'version-bar-config.json');
  let outDir = '';
  let specHtml = '';

  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === '--config' && argv[i + 1]) {
      configPath = argv[++i];
    } else if (argv[i] === '--out-dir' && argv[i + 1]) {
      outDir = argv[++i];
    } else if (argv[i] === '--spec-html' && argv[i + 1]) {
      specHtml = argv[++i];
    }
  }

  if (!outDir) {
    console.error('Usage: npx tsx scripts/generate-version-bar-data.ts --out-dir <dir> [--config <config.json>] [--spec-html <spec.html>]');
    process.exit(1);
  }

  return { configPath, outDir, specHtml };
}

const CACHE_DIR = path.join(__dirname, '..', '.version-cache');

async function fetchWithCache(url: string): Promise<string> {
  fs.mkdirSync(CACHE_DIR, { recursive: true });

  // Use URL as cache key (sanitized)
  const cacheKey = url.replace(/[^a-zA-Z0-9]/g, '_');
  const cachePath = path.join(CACHE_DIR, cacheKey + '.html');

  if (fs.existsSync(cachePath)) {
    console.log(`  [cache hit] ${url}`);
    return fs.readFileSync(cachePath, 'utf-8');
  }

  console.log(`  [fetching] ${url}`);
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to fetch ${url}: ${response.status} ${response.statusText}`);
  }
  const html = await response.text();
  fs.writeFileSync(cachePath, html, 'utf-8');
  return html;
}

/**
 * Shared helper for the per-section data file name.
 *
 * The client (js/versionBar.js) fetches these files as
 * `encodeURIComponent(sectionId) + '.json'`, so the writer must produce exactly
 * the same name to avoid 404s. Percent-encoding also neutralizes path traversal:
 * any '/', '\\', '.' sequences in an id become percent escapes, so the result is
 * always a single, flat file name with no directory separators.
 */
export function sectionFileName(sectionId: string): string {
  return encodeURIComponent(sectionId) + '.json';
}

/**
 * Return true when an attribute value resolves to a `javascript:` URL.
 * Control characters and surrounding whitespace are stripped first, mirroring how
 * browsers normalize URLs before dispatching them.
 */
function isJavascriptUrl(value: string): boolean {
  const normalized = value.replace(/[\x00-\x20]+/g, '').toLowerCase();
  return normalized.startsWith('javascript:');
}

/**
 * Conservatively sanitize a section HTML fragment before it is persisted.
 *
 * Trust boundary: the output of this function is written into the per-section JSON
 * files and later inserted by the client via `innerHTML` (see js/versionBar.js).
 * Because the client performs no sanitization of its own, the fragment MUST be
 * sanitized here, at write time, so that only already-safe HTML crosses the
 * boundary. This removes active-content elements, event-handler attributes, and
 * `javascript:` URLs.
 *
 * It also removes ALL comment nodes: the block-splitting step
 * (lib/section-blocks.mjs) marks leaf blocks with `<!--vb:N-->` comment markers
 * in its skeletons, so no comment from the input may survive to collide with —
 * or spoof — those markers. splitSectionHtml fails loudly if one ever does.
 */
// Elements that can execute code or load external resources.
const DANGEROUS_ELEMENTS = [
  'script',
  'style',
  'iframe',
  'object',
  'embed',
  'link',
  'meta',
  'base',
  'form',
];

// Minimal structural view of a parse5 AST node — just what our traversals need.
interface P5Node {
  nodeName: string;
  tagName?: string;
  attrs?: { name: string; value: string }[];
  childNodes?: P5Node[];
  // <template> children live under `content`, not `childNodes`.
  content?: P5Node;
}

/** Preorder walk over a parse5 AST (including <template> contents). */
function walkAst(node: P5Node, visit: (node: P5Node) => void) {
  visit(node);
  for (const child of node.childNodes ?? []) {
    walkAst(child, visit);
  }
  if (node.content) {
    walkAst(node.content, visit);
  }
}

function getAttr(node: P5Node, name: string): string | null {
  const attr = node.attrs?.find(a => a.name === name);
  return attr != null ? attr.value : null;
}

function isSectionNode(node: P5Node): boolean {
  return node.tagName === 'emu-clause' || node.tagName === 'emu-annex';
}

/** Parse a full document and return its <body> wrapper's first child (a <div> we supply). */
function parseInBodyContext(fragment: string): P5Node {
  const doc = parse(
    `<!DOCTYPE html><html><head></head><body><div>${fragment}</div></body></html>`,
  ) as unknown as P5Node;
  const htmlEl = doc.childNodes!.find(n => n.tagName === 'html')!;
  const body = htmlEl.childNodes!.find(n => n.tagName === 'body')!;
  return body.childNodes![0];
}

export function sanitizeSectionHtml(html: string): string {
  // Wrap in a <div> inside a full document so the fragment parses in body
  // context, matching how the client will later parse it via innerHTML.
  const wrapper = parseInBodyContext(html);

  const sanitizeNode = (node: P5Node) => {
    if (node.childNodes) {
      // Remove elements that can execute code or load external resources, and
      // every comment node (see the trust-boundary note above: the skeleton
      // format reserves <!--vb:N--> comment markers).
      node.childNodes = node.childNodes.filter(
        child =>
          child.nodeName !== '#comment' &&
          !(child.tagName != null && DANGEROUS_ELEMENTS.includes(child.tagName)),
      );
      for (const child of node.childNodes) {
        sanitizeNode(child);
      }
    }
    if (node.content) {
      sanitizeNode(node.content);
    }
    // Strip event-handler attributes and javascript: URLs from every element.
    if (node.attrs) {
      node.attrs = node.attrs.filter(attr => {
        const name = attr.name.toLowerCase();
        if (name.startsWith('on')) {
          // on* event handler (onclick, onerror, onload, ...)
          return false;
        }
        // URL-bearing attributes: href, src, xlink:href, and similar `*:href` / `*:src`.
        if (
          (name === 'href' ||
            name === 'src' ||
            name === 'xlink:href' ||
            name.endsWith(':href') ||
            name.endsWith(':src')) &&
          isJavascriptUrl(attr.value)
        ) {
          return false;
        }
        return true;
      });
    }
  };
  sanitizeNode(wrapper);

  // serialize() emits the node's children — i.e. the wrapper's innerHTML.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return serialize(wrapper as any);
}

/**
 * Extract all sections from the HTML (emu-clause / emu-annex, with a
 * plain-<section> fallback for old-format editions — see below).
 * Returns a map of section ID -> the section's own body HTML.
 */
export function extractSections(html: string): Map<string, string> {
  const doc = parse(html) as unknown as P5Node;
  const sections = new Map<string, string>();

  // Collect every section element in document order.
  //
  // Modern editions (ES2016 / 7.0 and later) mark sections with emu-clause /
  // emu-annex elements. Old-format editions (ES2015 / 6.0) predate ecmarkup's
  // output format and use plain <section id="sec-..."> elements instead; their
  // ids follow the same sec-* convention as later editions, so oldids
  // resolution works unchanged. When no emu-clause/emu-annex is found we fall
  // back to that format, restricting to id^="sec-" to skip the ToC
  // (<section id="contents">) and the anonymous wrappers (Introduction,
  // Bibliography).
  let isNestedSection = isSectionNode;
  const clauses: P5Node[] = [];
  walkAst(doc, node => {
    if (isSectionNode(node) && getAttr(node, 'id')) {
      clauses.push(node);
    }
  });
  if (clauses.length === 0) {
    isNestedSection = node => node.tagName === 'section';
    walkAst(doc, node => {
      if (node.tagName === 'section' && (getAttr(node, 'id') ?? '').startsWith('sec-')) {
        clauses.push(node);
      }
    });
  }

  for (const clause of clauses) {
    const id = getAttr(clause, 'id')!;
    // Store only this section's OWN body, excluding nested emu-clause / emu-annex
    // descendants. Serializing the whole subtree would make a parent clause embed
    // all of its child clauses verbatim, so every child's content would be
    // duplicated across its ancestors, bloating the per-section data.
    //
    // Copying the subtree just to prune it would spike memory (top-level clauses
    // hold thousands of nodes), so instead temporarily detach each topmost nested
    // section from its parent's childNodes, serialize, then restore in reverse
    // order to rebuild the original tree exactly.
    const detached: { parent: P5Node; index: number; node: P5Node }[] = [];
    const detachTopmostNested = (node: P5Node) => {
      if (node.content) {
        detachTopmostNested(node.content);
      }
      const children = node.childNodes;
      if (!children) return;
      for (let i = 0; i < children.length; i++) {
        const child = children[i];
        if (isNestedSection(child)) {
          detached.push({ parent: node, index: i, node: child });
          children.splice(i, 1);
          i--;
        } else {
          detachTopmostNested(child);
        }
      }
    };
    detachTopmostNested(clause);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    sections.set(id, serialize(clause as any));
    for (let i = detached.length - 1; i >= 0; i--) {
      const { parent, index, node } = detached[i];
      parent.childNodes!.splice(index, 0, node);
    }
  }

  return sections;
}

/**
 * Build oldid -> current-id mapping from the current spec HTML.
 * The current spec uses oldids="old1,old2" attributes on emu-clause/emu-annex elements.
 */
function buildOldIdMap(specHtml: string): Map<string, string> {
  const doc = parse(specHtml) as unknown as P5Node;
  const oldIdMap = new Map<string, string>();

  walkAst(doc, node => {
    if (!isSectionNode(node)) return;
    const currentId = getAttr(node, 'id');
    const oldids = getAttr(node, 'oldids');
    if (currentId && oldids) {
      for (const oldid of oldids.split(',')) {
        const trimmed = oldid.trim();
        if (trimmed) {
          oldIdMap.set(trimmed, currentId);
        }
      }
    }
  });

  return oldIdMap;
}

/**
 * Resolve a section ID to its canonical (current) ID using the oldid map.
 */
function resolveId(id: string, oldIdMap: Map<string, string>): string {
  return oldIdMap.get(id) ?? id;
}

/**
 * Build an O(1)-lookup reverse index for a single version: resolved (current) section ID
 * -> the section body to serve for it.
 *
 * This replaces the previous per-lookup `[...sections.keys()].some(...)` / full-key scans
 * (which made both manifest construction and the per-section loop O(n²)) with a single O(n)
 * pass per version. Precedence is preserved to match the original behavior exactly:
 *   1. A section whose raw id equals the queried id wins (the old `sections.get(id)` branch).
 *   2. Otherwise the first section (in document order) whose id resolves to the queried id
 *      wins (the old fallback loop that `break`s on the first match).
 * `resolved.has(id)` is therefore equivalent to the old `found` test, and `resolved.get(id)`
 * to the old content selection.
 */
function buildResolvedIndex(sections: Map<string, string>, oldIdMap: Map<string, string>): Map<string, string> {
  const resolved = new Map<string, string>();
  // Pass 1: first (document-order) section per resolved id — the fallback branch.
  for (const [id, content] of sections) {
    const rid = resolveId(id, oldIdMap);
    if (!resolved.has(rid)) {
      resolved.set(rid, content);
    }
  }
  // Pass 2: a direct raw-id match takes priority — the `sections.get(id)` branch.
  for (const [id, content] of sections) {
    resolved.set(id, content);
  }
  return resolved;
}

/**
 * Fetch one edition and return its sections, sanitized and ready to persist.
 */
async function extractAndSanitizeVersion(version: VersionConfig): Promise<Map<string, string>> {
  const html = await fetchWithCache(version.url);
  const sections = extractSections(html);
  // Trust boundary: sanitize at extraction time, so everything downstream (the
  // parent process, the output files, the client's innerHTML) only ever sees
  // safe HTML.
  const sanitized = new Map<string, string>();
  for (const [id, content] of sections) {
    sanitized.set(id, sanitizeSectionHtml(content));
  }
  return sanitized;
}

async function main(args: Args) {
  const { configPath, outDir, specHtml } = args;

  const config: Config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));

  // Build oldid map if spec HTML is provided
  let oldIdMap = new Map<string, string>();
  if (specHtml) {
    console.log('Building oldid map from current spec...');
    oldIdMap = buildOldIdMap(fs.readFileSync(specHtml, 'utf-8'));
    console.log(`  Found ${oldIdMap.size} oldid mappings`);
  }

  // Fetch and parse each version
  const versionSections = new Map<string, Map<string, string>>();
  for (const version of config.versions) {
    console.log(`Processing ${version.label}...`);
    const sections = await extractAndSanitizeVersion(version);
    console.log(`  Extracted ${sections.size} sections`);
    versionSections.set(version.key, sections);
  }

  // Build a per-version O(1) reverse index (resolved id -> content) once, so the manifest
  // and per-section loops below are O(n) overall instead of O(n²).
  const versionResolved = new Map<string, Map<string, string>>();
  for (const version of config.versions) {
    versionResolved.set(version.key, buildResolvedIndex(versionSections.get(version.key)!, oldIdMap));
  }

  // Collect all section IDs (resolved to current IDs)
  const allSectionIds = new Set<string>();
  for (const [, sections] of versionSections) {
    for (const id of sections.keys()) {
      allSectionIds.add(resolveId(id, oldIdMap));
    }
  }

  // Shared block-splitting / diff-chaining modules. These are ESM (.mjs) while
  // this script runs under tsx's CJS mode, so load them via dynamic import with
  // explicit file: URLs (tsx resolves the CJS -> ESM boundary).
  const { splitSectionHtml } = (await import(
    pathToFileURL(path.join(__dirname, '..', 'lib', 'section-blocks.mjs')).href
  )) as { splitSectionHtml: (sanitizedHtml: string) => SectionSplit };
  const { computeVersionData } = (await import(
    pathToFileURL(path.join(__dirname, '..', 'lib', 'version-data.mjs')).href
  )) as {
    computeVersionData: (
      orderedPresentKeys: string[],
      splitByKey: Map<string, SectionSplit>,
      versionIndexByKey: Map<string, number>,
      firstVersionKey: string,
      diff: typeof diffSequences,
    ) => { perVersion: Record<string, SectionVersionData>; stats: Record<string, [number, number]> };
  };

  // Memoize splitting on the content string itself: oldid resolution can make
  // several section ids point at the same content of the same edition, and
  // content that does not change between editions is byte-identical, so a
  // content-keyed cache avoids re-parsing both cases.
  const splitCache = new Map<string, SectionSplit>();
  const splitMemoized = (content: string): SectionSplit => {
    let split = splitCache.get(content);
    if (split === undefined) {
      split = splitSectionHtml(content);
      splitCache.set(content, split);
    }
    return split;
  };

  const versionIndexByKey = new Map<string, number>(config.versions.map((v, i) => [v.key, i]));
  const firstVersionKey = config.versions[0].key;

  // Build manifest skeleton; per-section stats are filled in by the loop below.
  const manifest: VersionBarManifest = {
    schemaVersion: 2,
    versions: config.versions.map(v => ({ key: v.key, label: v.label })),
    sections: {},
  };

  // Prepare output directories
  fs.mkdirSync(outDir, { recursive: true });
  const dataDir = path.join(outDir, 'version-bar-data');
  fs.mkdirSync(dataDir, { recursive: true });
  const resolvedDataDir = path.resolve(dataDir);

  // Per section: collect present versions (config order, oldest -> newest),
  // split each present version's sanitized content into blocks, chain diffs
  // for stats + blame, and write the v2 per-section detail file.
  console.log('Splitting sections into blocks and computing diff stats...');
  let sectionFileCount = 0;
  for (const sectionId of [...allSectionIds].sort()) {
    const presentIn: string[] = [];
    const splitByKey = new Map<string, SectionSplit>();
    for (const version of config.versions) {
      // O(1) lookup: presence in the reverse index == the old
      // `sections.has(sectionId) || keys.some(id => resolveId(id) === sectionId)` test.
      const content = versionResolved.get(version.key)!.get(sectionId);
      if (content != null) {
        presentIn.push(version.key);
        splitByKey.set(version.key, splitMemoized(content));
      }
    }
    if (presentIn.length === 0) continue;

    const { perVersion, stats } = computeVersionData(
      presentIn,
      splitByKey,
      versionIndexByKey,
      firstVersionKey,
      diffSequences,
    );

    manifest.sections[sectionId] = { presentIn, stats };

    // Trust boundary: the fragments inside perVersion were sanitized at
    // extraction time (extractAndSanitizeVersion); the client reassembles
    // skeleton + blocks via innerHTML without further sanitization.
    //
    // Use the shared, percent-encoded file name so it matches the client's fetch URL
    // and cannot contain path separators.
    const sectionPath = path.join(dataDir, sectionFileName(sectionId));
    // Belt-and-suspenders: ensure the resolved path stays directly inside dataDir.
    const resolved = path.resolve(sectionPath);
    if (path.dirname(resolved) !== resolvedDataDir) {
      console.warn(`  [skip] Refusing to write section outside data dir: ${sectionId}`);
      continue;
    }
    fs.writeFileSync(
      sectionPath,
      JSON.stringify({ schemaVersion: 2, versions: perVersion }),
      'utf-8',
    );
    sectionFileCount++;
  }

  // Write manifest (after the loop, which fills in per-section stats)
  const manifestPath = path.join(outDir, 'version-bar-manifest.json');
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf-8');
  console.log(`Wrote manifest: ${manifestPath} (${Object.keys(manifest.sections).length} sections)`);

  console.log(`Wrote ${sectionFileCount} section detail files to ${dataDir}`);
  // Report the peak rss so memory regressions are visible in the build log
  // (Linux-only; /proc is absent elsewhere).
  let peak = '';
  try {
    const match = /VmHWM:\s*(\d+) kB/.exec(fs.readFileSync('/proc/self/status', 'utf-8'));
    if (match) {
      peak = ` (peak rss ${Math.round(Number(match[1]) / 1024)} MB)`;
    }
  } catch {
    // ignore
  }
  console.log(`Done.${peak}`);
}

// Guard execution so the module can be imported (e.g. by tests) without running main().
if (require.main === module) {
  main(parseArgs(process.argv)).catch(err => {
    console.error(err);
    process.exit(1);
  });
}
