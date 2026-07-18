// Builds a map from built-in property names (e.g. `Array.prototype.map`,
// `get Map.prototype.size`, `Array.prototype [ %Symbol.iterator% ]`) to
// clause ids by parsing the tc39/ecma262 source `spec.html`.
//
// See DESIGN.md, section "Name → clause-id matching".

import { readFileSync } from 'node:fs';

// A title "looks like" a method/accessor when it is a dotted property path
// (segments may be %-wrapped intrinsics), optionally `get `/`set `-prefixed,
// optionally ending in a bracketed well-known-symbol key, optionally followed
// by a parameter list. Examples:
//   Array.prototype.map ( _callback_ [ , _thisArg_ ] )
//   get Map.prototype.size
//   Array.prototype [ %Symbol.iterator% ] ( )
//   %TypedArray%.prototype.set ( _source_ [ , _offset_ ] )
//   parseInt ( _string_, _radix_ )
const TITLE_RE =
  /^(?:get |set )?%?[A-Za-z_$][\w$]*%?(?:\s*\.\s*%?[A-Za-z_$][\w$]*%?)*(?:\s*\[\s*(?:%Symbol\.[A-Za-z]+%|Symbol\.[A-Za-z]+|@@[A-Za-z]+)\s*\])?(?:\s*\([\s\S]*\))?$/;

/**
 * Normalize a spec title or an extractor-provided name to a shared lookup key.
 *
 * - strips a trailing parameter list
 * - lowercases and removes all whitespace
 * - `@@x` → `symbol.x`
 * - `%x%` → `x` (so `%TypedArray%` ⇄ `TypedArray`, `[%Symbol.x%]` ⇄ `[Symbol.x]`)
 */
export function nameToKey(name) {
  let key = String(name);
  // Strip a trailing parameter list (may contain one level of nested parens).
  key = key.replace(/\s*\((?:[^()]|\([^()]*\))*\)\s*$/, '');
  // Strip ecmarkup value markup, e.g. `*undefined*`. (Variable markup
  // `_hint_` only occurs inside parameter lists, which are already gone;
  // underscores must survive for names like `__proto__`.)
  key = key.replace(/\*([\w$]+)\*/g, '$1');
  key = key.toLowerCase();
  key = key.replace(/\s+/g, '');
  // Legacy well-known-symbol notation: `[@@iterator]` → `[symbol.iterator]`.
  key = key.replace(/@@([a-z]+)/g, 'symbol.$1');
  // Intrinsic notation: `%typedarray%` → `typedarray`,
  // `[%symbol.iterator%]` → `[symbol.iterator]`.
  key = key.replace(/%([^%]+)%/g, '$1');
  // The spec names some prototypes as one intrinsic token where engines use
  // a property path (`%GeneratorPrototype%.next` vs `Generator.prototype.next`);
  // collapse the `.prototype` separator so both spellings share a key.
  key = key.replace(/\.prototype(?=[.[])/g, 'prototype');
  return key;
}

/**
 * Parse spec.html and return Map<key, clauseId> for every clause whose title
 * looks like a built-in method or accessor.
 *
 * `<emu-clause>` elements marked `type="built-in function"` are authoritative;
 * that excludes abstract operations (`CreateArrayIterator ( … )`) and prose
 * headings (`The Array Constructor`), and skipping `<emu-annex>` keeps Annex B
 * out of scope. The title-shape check is kept as a second filter so non-path
 * titles never produce keys.
 *
 * Alias clauses (e.g. `AsyncDisposableStack.prototype [ %Symbol.asyncDispose% ]`,
 * whose value is defined to be another function) carry no `type` attribute, so
 * untyped clauses are added in a second pass — but only when the title
 * contains a receiver (a `.` or `[`), which keeps single-segment abstract
 * operation names (`ToString ( argument )`) from colliding with globals.
 */
export function loadSpecNames(specHtmlPath) {
  const html = readFileSync(specHtmlPath, 'utf8');
  const map = new Map();
  const untyped = [];

  // The open tag may span multiple lines, and the <h1> may sit a few lines
  // below the id, so scan for the open tag and then find the clause's own
  // <h1> (the nearest one, provided no nested <emu-clause> comes first).
  const openTagRe = /<emu-clause\b[^>]*\bid="([^"]+)"[^>]*>/g;
  let m;
  while ((m = openTagRe.exec(html)) !== null) {
    const isBuiltinFunction = /\btype="built-in function"/.test(m[0]);
    if (!isBuiltinFunction && /\btype="/.test(m[0])) continue;
    const id = m[1];

    const h1Start = html.indexOf('<h1', m.index + m[0].length);
    if (h1Start === -1) continue;
    const nextClause = html.indexOf('<emu-clause', m.index + m[0].length);
    if (nextClause !== -1 && nextClause < h1Start) continue; // no own <h1>
    const h1Open = html.indexOf('>', h1Start);
    const h1End = html.indexOf('</h1>', h1Open);
    if (h1Open === -1 || h1End === -1) continue;

    let title = html
      .slice(h1Open + 1, h1End)
      .replace(/<[^>]*>/g, '') // drop inline tags (<ins>, <del>, …)
      .replace(/\s+/g, ' ')
      .trim();

    if (!TITLE_RE.test(title)) continue;
    // Methods have a parameter list; accessors have a get/set prefix.
    // Anything else (data properties, bare names) is out of scope.
    if (!/\)\s*$/.test(title) && !/^(?:get|set)\s/.test(title)) continue;

    if (isBuiltinFunction) {
      const key = nameToKey(title);
      if (!map.has(key)) map.set(key, id);
    } else if (/[.[]/.test(title.replace(/\s*\([\s\S]*\)\s*$/, ''))) {
      untyped.push([nameToKey(title), id]);
    }
  }

  // Second pass: untyped alias clauses never override typed ones.
  for (const [key, id] of untyped) {
    if (!map.has(key)) map.set(key, id);
  }

  return map;
}
