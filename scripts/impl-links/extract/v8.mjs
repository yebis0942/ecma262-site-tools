// V8 extractor for impl-links.
//
// Scans src/init/bootstrapper.cc for install calls that pair a JS property
// name with a Builtin::k<Name> enum value (label "entry"), then indexes
// src/builtins/ for the corresponding builtin definitions:
//   - Torque:  `[transitioning] [javascript] builtin <Name>(`  → "impl (Torque)"
//   - C++:     `BUILTIN(<Name>)`                               → "impl (C++)"
//   - CSA:     `TF_BUILTIN(<Name>,`                            → "impl (CSA)"
//
// See scripts/impl-links/DESIGN.md ("Extractor contract", "Per-engine
// extraction strategy").

import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';

const BOOTSTRAPPER = 'src/init/bootstrapper.cc';
const HEAP_SYMBOLS = 'src/init/heap-symbols.h';
const BUILTINS_DIR = 'src/builtins';

// Install helpers in bootstrapper.cc that pair a name with a Builtin.
// Argument layout (0-based, arg 0 is always the isolate, arg 1 the base):
//   SimpleInstallFunction(isolate, base, name, call, len, adapt[, attrs])
//   InstallFunctionWithBuiltinId(isolate, base, name, call, len, adapt)
//   SimpleInstallGetter(isolate, base, name, call, adapt)
//   SimpleInstallGetter(isolate, base, name, property_name, call, adapt)
//   SimpleInstallGetterSetter(isolate, base, name, call_getter, call_setter)
//   InstallFunctionAtSymbol(isolate, base, symbol, symbol_string, call, ...)
const INSTALL_CALLS = [
  'SimpleInstallFunction',
  'InstallFunctionWithBuiltinId',
  'SimpleInstallGetterSetter',
  'SimpleInstallGetter',
  'InstallFunctionAtSymbol',
];

// Known receivers for decoding Builtin enum names, e.g.
// kArrayPrototypeMap → Array.prototype.map. Longest match wins; entries may
// map an enum prefix to a different display receiver ('' = global function).
const RECEIVERS = [
  ['SharedArrayBuffer', 'SharedArrayBuffer'],
  ['ArrayBuffer', 'ArrayBuffer'],
  ['ArrayIterator', 'ArrayIterator'],
  ['Array', 'Array'],
  ['AsyncDisposableStack', 'AsyncDisposableStack'],
  ['DisposableStack', 'DisposableStack'],
  ['AsyncFromSyncIterator', 'AsyncFromSyncIterator'],
  ['AsyncGeneratorFunction', 'AsyncGeneratorFunction'],
  ['AsyncGenerator', 'AsyncGenerator'],
  ['AsyncFunction', 'AsyncFunction'],
  ['AsyncIterator', 'AsyncIterator'],
  ['GeneratorFunction', 'GeneratorFunction'],
  ['Generator', 'Generator'],
  ['DataView', 'DataView'],
  ['TypedArray', 'TypedArray'],
  ['Uint8Array', 'Uint8Array'],
  ['StringIterator', 'StringIterator'],
  ['String', 'String'],
  ['NumberFormat', 'Intl.NumberFormat'],
  ['Number', 'Number'],
  ['Boolean', 'Boolean'],
  ['BigInt', 'BigInt'],
  ['Symbol', 'Symbol'],
  ['Object', 'Object'],
  ['FastFunction', 'Function'],
  ['Function', 'Function'],
  ['Promise', 'Promise'],
  ['RegExpStringIterator', 'RegExpStringIterator'],
  ['RegExp', 'RegExp'],
  ['DateTimeFormat', 'Intl.DateTimeFormat'],
  ['Date', 'Date'],
  ['MapIterator', 'MapIterator'],
  ['Map', 'Map'],
  ['SetIterator', 'SetIterator'],
  ['Set', 'Set'],
  ['WeakMap', 'WeakMap'],
  ['WeakSet', 'WeakSet'],
  ['WeakRef', 'WeakRef'],
  ['FinalizationRegistry', 'FinalizationRegistry'],
  ['Reflect', 'Reflect'],
  ['Math', 'Math'],
  ['Json', 'JSON'],
  ['Atomics', 'Atomics'],
  ['Proxy', 'Proxy'],
  ['IteratorHelper', 'IteratorHelper'],
  ['Iterator', 'Iterator'],
  ['AggregateError', 'AggregateError'],
  ['SuppressedError', 'SuppressedError'],
  ['Error', 'Error'],
  ['ShadowRealm', 'ShadowRealm'],
  ['StructType', 'StructType'],
  // Global functions: strip the receiver, keep the bare name (parseInt, …).
  ['Global', ''],
  // Temporal
  ['TemporalPlainDateTime', 'Temporal.PlainDateTime'],
  ['TemporalPlainDate', 'Temporal.PlainDate'],
  ['TemporalPlainTime', 'Temporal.PlainTime'],
  ['TemporalPlainYearMonth', 'Temporal.PlainYearMonth'],
  ['TemporalPlainMonthDay', 'Temporal.PlainMonthDay'],
  ['TemporalDuration', 'Temporal.Duration'],
  ['TemporalInstant', 'Temporal.Instant'],
  ['TemporalZonedDateTime', 'Temporal.ZonedDateTime'],
  ['TemporalNow', 'Temporal.Now'],
  // Intl
  ['Collator', 'Intl.Collator'],
  ['PluralRules', 'Intl.PluralRules'],
  ['RelativeTimeFormat', 'Intl.RelativeTimeFormat'],
  ['ListFormat', 'Intl.ListFormat'],
  ['Locale', 'Intl.Locale'],
  ['DisplayNames', 'Intl.DisplayNames'],
  ['DurationFormat', 'Intl.DurationFormat'],
  ['SegmentIterator', 'Intl.SegmentIterator'],
  ['Segmenter', 'Intl.Segmenter'],
  ['Segments', 'Intl.Segments'],
  ['V8BreakIterator', 'Intl.v8BreakIterator'],
  ['Intl', 'Intl'],
].sort((a, b) => b[0].length - a[0].length);

export async function extract(root) {
  const warnings = [];
  const factoryNames = await loadFactoryNames(root);
  const implIndex = await buildImplIndex(root);
  const source = await readFile(join(root, BOOTSTRAPPER), 'utf8');
  const lineStarts = computeLineStarts(source);

  // name → Record, merging duplicate installs of the same spec name.
  const byName = new Map();
  const addRecord = (name, links) => {
    let rec = byName.get(name);
    if (rec === undefined) {
      rec = { name, links: [], seen: new Set() };
      byName.set(name, rec);
    }
    for (const link of links) {
      const key = `${link.label}|${link.path}|${link.line}`;
      if (!rec.seen.has(key)) {
        rec.seen.add(key);
        rec.links.push(link);
      }
    }
  };

  const callRe = new RegExp(`\\b(${INSTALL_CALLS.join('|')})\\s*\\(`, 'g');
  let m;
  while ((m = callRe.exec(source)) !== null) {
    const callee = m[1];
    const argsStart = m.index + m[0].length;
    const argsEnd = findMatchingParen(source, argsStart);
    if (argsEnd === -1) continue;
    const argsText = source.slice(argsStart, argsEnd);
    const line = lineOf(lineStarts, m.index);
    const where = `${BOOTSTRAPPER}:${line}`;

    // Skip the helper definitions/declarations themselves.
    if (/\bIsolate\s*\*|\bconst\s+char\s*\*/.test(argsText)) continue;
    // Skip calls inside #define bodies (stringize/paste tokens); these are
    // expanded per-list-entry (Temporal/Intl macros) and can't be resolved
    // statically.
    if (argsText.includes('#')) {
      warnings.push(`${where}: skipped macro-body ${callee}(${collapse(argsText)})`);
      continue;
    }

    const args = splitTopLevelArgs(argsText);
    if (args.length < 4) {
      warnings.push(`${where}: could not parse arguments of ${callee}`);
      continue;
    }

    // Resolve the JS property name.
    const nameArg = callee === 'InstallFunctionAtSymbol' ? args[3] : args[2];
    // Skip the overload-forwarding calls inside the helpers themselves,
    // where the name is the enclosing function's `name` parameter.
    if (/^(?:.*InternalizeUtf8String\()?name\)?$/.test(nameArg)) continue;
    const resolved = resolveName(nameArg, factoryNames);
    if (resolved === null) {
      warnings.push(`${where}: unresolved name argument \`${collapse(nameArg)}\``);
      continue;
    }

    // Resolve the Builtin enum value(s).
    const builtinOf = arg => (arg.match(/\bBuiltin::k([A-Za-z0-9_]+)/) || [])[1];
    let pairs; // [accessorPrefix, enumName][]
    if (callee === 'SimpleInstallGetterSetter') {
      pairs = [
        ['get ', builtinOf(args[3])],
        ['set ', builtinOf(args[4])],
      ];
    } else if (callee === 'SimpleInstallGetter') {
      // Two overloads: name may be followed by a distinct property_name.
      pairs = [['get ', builtinOf(args[3]) ?? builtinOf(args[4] ?? '')]];
    } else if (callee === 'InstallFunctionAtSymbol') {
      pairs = [['', builtinOf(args[4])]];
    } else {
      pairs = [['', builtinOf(args[3])]];
    }

    // Base-argument heuristic: installing onto something whose expression
    // mentions "proto" means a prototype method even when the enum name has
    // no "Prototype" segment (e.g. Builtin::kArrayMap on `proto`).
    const baseLooksLikeProto = /proto/i.test(args[1]);

    for (const [accessor, enumName] of pairs) {
      if (enumName === undefined) {
        warnings.push(`${where}: no Builtin::k value found in ${callee}`);
        continue;
      }
      const decoded = decodeEnumReceiver(enumName);
      if (decoded === null) {
        warnings.push(
          `${where}: cannot decode receiver of Builtin::k${enumName} (name \`${resolved}\`)`,
        );
        continue;
      }
      const { receiver, hasPrototype } = decoded;
      const specName = buildSpecName(
        receiver,
        hasPrototype || (receiver !== '' && baseLooksLikeProto),
        resolved,
        accessor,
      );
      if (specName === null) {
        warnings.push(`${where}: cannot build spec name for Builtin::k${enumName}`);
        continue;
      }
      const links = [{ label: 'entry', path: BOOTSTRAPPER, line }];
      for (const impl of implIndex.get(enumName) ?? []) {
        links.push({ label: impl.label, path: impl.path, line: impl.line });
      }
      addRecord(specName, links);
    }
  }

  const records = [...byName.values()]
    .map(({ name, links }) => ({ name, links }))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return { records, warnings };
}

// ---------------------------------------------------------------------------
// Name resolution

// Resolve the name argument of an install call to a display name: a plain
// string (`map`, `__proto__`) or a bracketed symbol (`[Symbol.iterator]`).
function resolveName(arg, factoryNames) {
  const literal = arg.match(/"((?:[^"\\]|\\.)*)"/);
  if (literal !== null) return literal[1];
  const factory = arg.match(/->\s*([A-Za-z0-9_]+_(?:string|symbol))\s*\(\s*\)/);
  if (factory !== null) {
    const text = factoryNames.get(factory[1]);
    return text ?? null;
  }
  return null;
}

function decodeEnumReceiver(enumName) {
  for (const [prefix, receiver] of RECEIVERS) {
    if (enumName.startsWith(prefix)) {
      const rest = enumName.slice(prefix.length);
      const hasPrototype = rest.startsWith('Prototype');
      return { receiver, hasPrototype };
    }
  }
  return null;
}

function buildSpecName(receiver, prototype, method, accessor) {
  const bracketed = method.startsWith('[');
  if (receiver === '') {
    // Global function: bare name.
    if (bracketed || method === '') return null;
    return accessor + method;
  }
  const base = receiver + (prototype ? '.prototype' : '');
  return accessor + (bracketed ? base + method : `${base}.${method}`);
}

// ---------------------------------------------------------------------------
// factory->xxx_string() / xxx_symbol() → actual JS name, from heap-symbols.h

async function loadFactoryNames(root) {
  const src = await readFile(join(root, HEAP_SYMBOLS), 'utf8');
  const map = new Map();
  for (const m of src.matchAll(/V\(_,\s*([A-Za-z0-9_]+_string),\s*"((?:[^"\\]|\\.)*)"\s*\)/g)) {
    map.set(m[1], m[2]);
  }
  for (const m of src.matchAll(/V\(_,\s*([A-Za-z0-9_]+_symbol),\s*(Symbol\.[A-Za-z0-9_]+)\s*\)/g)) {
    map.set(m[1], `[${m[2]}]`);
  }
  return map;
}

// ---------------------------------------------------------------------------
// Builtin name → implementation locations, from src/builtins/

// Note: leading whitespace must not match newlines, or the reported line
// would be that of a preceding blank line.
const TQ_BUILTIN_RE = /^[ \t]*(?:transitioning\s+)?(?:javascript\s+)?builtin\s+([A-Za-z0-9_]+)/gm;
const CPP_BUILTIN_RE = /^[ \t]*BUILTIN\(([A-Za-z0-9_]+)\)/gm;
const CSA_BUILTIN_RE = /^[ \t]*TF_BUILTIN\(([A-Za-z0-9_]+)\s*,/gm;

async function buildImplIndex(root) {
  const index = new Map();
  const add = (name, label, path, line) => {
    let list = index.get(name);
    if (list === undefined) {
      list = [];
      index.set(name, list);
    }
    list.push({ label, path, line });
  };
  for (const relPath of await walkFiles(root, BUILTINS_DIR)) {
    const isTq = relPath.endsWith('.tq');
    const isCc = relPath.endsWith('.cc');
    if (!isTq && !isCc) continue;
    const src = await readFile(join(root, relPath), 'utf8');
    const lineStarts = computeLineStarts(src);
    if (isTq) {
      for (const m of src.matchAll(TQ_BUILTIN_RE)) {
        // `extern builtin Foo(...)` is a declaration, not a definition.
        if (/\bextern\b/.test(m[0])) continue;
        add(m[1], 'impl (Torque)', relPath, lineOf(lineStarts, m.index));
      }
    } else {
      for (const m of src.matchAll(CPP_BUILTIN_RE)) {
        add(m[1], 'impl (C++)', relPath, lineOf(lineStarts, m.index));
      }
      for (const m of src.matchAll(CSA_BUILTIN_RE)) {
        add(m[1], 'impl (CSA)', relPath, lineOf(lineStarts, m.index));
      }
    }
  }
  return index;
}

async function walkFiles(root, rel) {
  const out = [];
  const entries = await readdir(join(root, rel), { withFileTypes: true });
  for (const entry of entries) {
    const childRel = `${rel}/${entry.name}`;
    if (entry.isDirectory()) {
      out.push(...(await walkFiles(root, childRel)));
    } else if (entry.isFile()) {
      out.push(childRel);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// C++ source scanning helpers

// Given `source` and the offset just past an opening '(', return the offset
// of the matching ')' (or -1). Skips string/char literals and comments.
function findMatchingParen(source, start) {
  let depth = 1;
  for (let i = start; i < source.length; i++) {
    const c = source[i];
    if (c === '"' || c === "'") {
      i = skipLiteral(source, i);
    } else if (c === '/' && source[i + 1] === '/') {
      i = source.indexOf('\n', i);
      if (i === -1) return -1;
    } else if (c === '/' && source[i + 1] === '*') {
      i = source.indexOf('*/', i + 2);
      if (i === -1) return -1;
      i += 1;
    } else if (c === '(') {
      depth++;
    } else if (c === ')') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

// i points at the opening quote; returns the index of the closing quote.
function skipLiteral(source, i) {
  const quote = source[i];
  for (let j = i + 1; j < source.length; j++) {
    if (source[j] === '\\') j++;
    else if (source[j] === quote) return j;
  }
  return source.length;
}

function splitTopLevelArgs(text) {
  const args = [];
  let depth = 0;
  let current = '';
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"' || c === "'") {
      const end = skipLiteral(text, i);
      current += text.slice(i, end + 1);
      i = end;
    } else if (c === '(' || c === '{') {
      // Angle brackets are not tracked: `->` would break the counter, and
      // template argument lists in these calls never contain top-level commas.
      depth++;
      current += c;
    } else if (c === ')' || c === '}') {
      depth--;
      current += c;
    } else if (c === ',' && depth === 0) {
      args.push(current.trim());
      current = '';
    } else {
      current += c;
    }
  }
  if (current.trim() !== '') args.push(current.trim());
  return args;
}

function computeLineStarts(source) {
  const starts = [0];
  for (let i = 0; i < source.length; i++) {
    if (source[i] === '\n') starts.push(i + 1);
  }
  return starts;
}

function lineOf(lineStarts, offset) {
  let lo = 0;
  let hi = lineStarts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (lineStarts[mid] <= offset) lo = mid;
    else hi = mid - 1;
  }
  return lo + 1;
}

function collapse(text) {
  const s = text.replace(/\s+/g, ' ').trim();
  return s.length > 80 ? s.slice(0, 77) + '...' : s;
}
