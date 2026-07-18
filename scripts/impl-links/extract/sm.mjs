// SpiderMonkey extractor for impl-links.
//
// Scans `js/src/{builtin,vm,proxy}/**/*.cpp` for
// `JSFunctionSpec`/`JSPropertySpec` tables and turns their entries into
// records. Table variable names are mapped to spec receivers via a
// hardcoded table below (unmapped tables produce warnings). Each record
// links the table entry line, plus (when found) the C++ function
// definition or the self-hosted JS function definition in
// `js/src/builtin/**/*.js`.
//
// See scripts/impl-links/DESIGN.md ("Extractor contract").

import { promises as fs } from 'node:fs';
import path from 'node:path';

const CPP_DIRS = ['js/src/builtin', 'js/src/vm', 'js/src/proxy'];
const SELF_HOSTED_DIRS = ['js/src/builtin'];

// Table variable name (without a leading `js::`) -> receiver.
// '' means the global object (bare function names like `escape`).
const TABLE_RECEIVERS = {
  // js/src/builtin/Array.cpp
  array_methods: 'Array.prototype',
  array_static_methods: 'Array',
  array_static_props: 'Array',
  // js/src/builtin/AsyncDisposableStackObject.cpp
  'AsyncDisposableStackObject::methods': 'AsyncDisposableStack.prototype',
  'AsyncDisposableStackObject::properties': 'AsyncDisposableStack.prototype',
  // js/src/builtin/AtomicsObject.cpp
  AtomicsMethods: 'Atomics',
  AtomicsProperties: 'Atomics',
  // js/src/builtin/BigInt.cpp
  'BigIntObject::methods': 'BigInt.prototype',
  'BigIntObject::properties': 'BigInt.prototype',
  'BigIntObject::staticMethods': 'BigInt',
  // js/src/builtin/Boolean.cpp
  boolean_methods: 'Boolean.prototype',
  // js/src/builtin/DataViewObject.cpp
  'DataViewObject::methods': 'DataView.prototype',
  'DataViewObject::properties': 'DataView.prototype',
  // js/src/builtin/Date.cpp
  date_methods: 'Date.prototype',
  date_static_methods: 'Date',
  // js/src/builtin/DisposableStackObject.cpp
  'DisposableStackObject::methods': 'DisposableStack.prototype',
  'DisposableStackObject::properties': 'DisposableStack.prototype',
  // js/src/builtin/FinalizationRegistryObject.cpp
  'FinalizationRegistryObject::methods_': 'FinalizationRegistry.prototype',
  'FinalizationRegistryObject::properties_': 'FinalizationRegistry.prototype',
  // js/src/builtin/JSON.cpp
  json_static_methods: 'JSON',
  json_static_properties: 'JSON',
  // js/src/builtin/MapObject.cpp
  'MapIteratorObject::methods': '%MapIteratorPrototype%',
  'MapObject::methods': 'Map.prototype',
  'MapObject::properties': 'Map.prototype',
  'MapObject::staticMethods': 'Map',
  'MapObject::staticProperties': 'Map',
  'SetIteratorObject::methods': '%SetIteratorPrototype%',
  'SetObject::methods': 'Set.prototype',
  'SetObject::properties': 'Set.prototype',
  'SetObject::staticProperties': 'Set',
  // js/src/builtin/Math.cpp
  math_static_methods: 'Math',
  math_static_properties: 'Math',
  // js/src/builtin/ModuleObject.cpp
  abstract_module_source_proto_accessors: '%AbstractModuleSource%.prototype',
  // js/src/builtin/Number.cpp
  number_functions: '',
  number_methods: 'Number.prototype',
  number_static_methods: 'Number',
  number_static_properties: 'Number',
  // js/src/builtin/Object.cpp
  object_methods: 'Object.prototype',
  object_properties: 'Object.prototype',
  object_static_methods: 'Object',
  // js/src/builtin/Promise.cpp
  promise_methods: 'Promise.prototype',
  promise_properties: 'Promise.prototype',
  promise_static_methods: 'Promise',
  promise_static_properties: 'Promise',
  // js/src/builtin/Reflect.cpp
  reflect_methods: 'Reflect',
  reflect_properties: 'Reflect',
  // js/src/builtin/RegExp.cpp
  regexp_methods: 'RegExp.prototype',
  regexp_properties: 'RegExp.prototype',
  regexp_static_methods: 'RegExp',
  regexp_static_props: 'RegExp',
  // js/src/builtin/String.cpp
  string_functions: '',
  string_methods: 'String.prototype',
  string_static_methods: 'String',
  // js/src/builtin/Symbol.cpp
  'SymbolObject::methods': 'Symbol.prototype',
  'SymbolObject::properties': 'Symbol.prototype',
  'SymbolObject::staticMethods': 'Symbol',
  // js/src/builtin/WeakMapObject.cpp
  'WeakMapObject::methods': 'WeakMap.prototype',
  'WeakMapObject::properties': 'WeakMap.prototype',
  // js/src/builtin/WeakRefObject.cpp
  'WeakRefObject::methods': 'WeakRef.prototype',
  'WeakRefObject::properties': 'WeakRef.prototype',
  // js/src/builtin/WeakSetObject.cpp
  'WeakSetObject::methods': 'WeakSet.prototype',
  'WeakSetObject::properties': 'WeakSet.prototype',
  // js/src/builtin/intl/*.cpp
  collator_methods: 'Intl.Collator.prototype',
  collator_properties: 'Intl.Collator.prototype',
  collator_static_methods: 'Intl.Collator',
  dateTimeFormat_methods: 'Intl.DateTimeFormat.prototype',
  dateTimeFormat_properties: 'Intl.DateTimeFormat.prototype',
  dateTimeFormat_static_methods: 'Intl.DateTimeFormat',
  displayNames_methods: 'Intl.DisplayNames.prototype',
  displayNames_properties: 'Intl.DisplayNames.prototype',
  displayNames_static_methods: 'Intl.DisplayNames',
  durationFormat_methods: 'Intl.DurationFormat.prototype',
  durationFormat_properties: 'Intl.DurationFormat.prototype',
  durationFormat_static_methods: 'Intl.DurationFormat',
  intl_static_methods: 'Intl',
  intl_static_properties: 'Intl',
  listFormat_methods: 'Intl.ListFormat.prototype',
  listFormat_properties: 'Intl.ListFormat.prototype',
  listFormat_static_methods: 'Intl.ListFormat',
  locale_methods: 'Intl.Locale.prototype',
  locale_properties: 'Intl.Locale.prototype',
  numberFormat_methods: 'Intl.NumberFormat.prototype',
  numberFormat_properties: 'Intl.NumberFormat.prototype',
  numberFormat_static_methods: 'Intl.NumberFormat',
  pluralRules_methods: 'Intl.PluralRules.prototype',
  pluralRules_properties: 'Intl.PluralRules.prototype',
  pluralRules_static_methods: 'Intl.PluralRules',
  relativeTimeFormat_methods: 'Intl.RelativeTimeFormat.prototype',
  relativeTimeFormat_properties: 'Intl.RelativeTimeFormat.prototype',
  relativeTimeFormat_static_methods: 'Intl.RelativeTimeFormat',
  segmenter_methods: 'Intl.Segmenter.prototype',
  segmenter_properties: 'Intl.Segmenter.prototype',
  segmenter_static_methods: 'Intl.Segmenter',
  segments_methods: '%SegmentsPrototype%',
  segment_iterator_methods: '%SegmentIteratorPrototype%',
  segment_iterator_properties: '%SegmentIteratorPrototype%',
  // js/src/builtin/temporal/*.cpp
  Duration_methods: 'Temporal.Duration',
  Duration_prototype_methods: 'Temporal.Duration.prototype',
  Duration_prototype_properties: 'Temporal.Duration.prototype',
  Instant_methods: 'Temporal.Instant',
  Instant_prototype_methods: 'Temporal.Instant.prototype',
  Instant_prototype_properties: 'Temporal.Instant.prototype',
  PlainDate_methods: 'Temporal.PlainDate',
  PlainDate_prototype_methods: 'Temporal.PlainDate.prototype',
  PlainDate_prototype_properties: 'Temporal.PlainDate.prototype',
  PlainDateTime_methods: 'Temporal.PlainDateTime',
  PlainDateTime_prototype_methods: 'Temporal.PlainDateTime.prototype',
  PlainDateTime_prototype_properties: 'Temporal.PlainDateTime.prototype',
  PlainMonthDay_methods: 'Temporal.PlainMonthDay',
  PlainMonthDay_prototype_methods: 'Temporal.PlainMonthDay.prototype',
  PlainMonthDay_prototype_properties: 'Temporal.PlainMonthDay.prototype',
  PlainTime_methods: 'Temporal.PlainTime',
  PlainTime_prototype_methods: 'Temporal.PlainTime.prototype',
  PlainTime_prototype_properties: 'Temporal.PlainTime.prototype',
  PlainYearMonth_methods: 'Temporal.PlainYearMonth',
  PlainYearMonth_prototype_methods: 'Temporal.PlainYearMonth.prototype',
  PlainYearMonth_prototype_properties: 'Temporal.PlainYearMonth.prototype',
  TemporalNow_methods: 'Temporal.Now',
  TemporalNow_properties: 'Temporal.Now',
  Temporal_properties: 'Temporal',
  ZonedDateTime_methods: 'Temporal.ZonedDateTime',
  ZonedDateTime_prototype_methods: 'Temporal.ZonedDateTime.prototype',
  ZonedDateTime_prototype_properties: 'Temporal.ZonedDateTime.prototype',
  // js/src/proxy/Proxy.cpp
  proxy_static_methods: 'Proxy',
  // js/src/vm/ArrayBufferObject.cpp
  arraybuffer_functions: 'ArrayBuffer',
  arraybuffer_properties: 'ArrayBuffer',
  arraybuffer_proto_functions: 'ArrayBuffer.prototype',
  arraybuffer_proto_properties: 'ArrayBuffer.prototype',
  // js/src/vm/AsyncIteration.cpp
  async_from_sync_iter_methods: '%AsyncFromSyncIteratorPrototype%',
  async_generator_methods: 'AsyncGenerator.prototype',
  async_iterator_helper_methods: '%AsyncIteratorHelperPrototype%',
  async_iterator_proto_methods: '%AsyncIteratorPrototype%',
  async_iterator_proto_methods_with_helpers: '%AsyncIteratorPrototype%',
  // js/src/vm/ErrorObject.cpp
  error_methods: 'Error.prototype',
  error_properties: 'Error.prototype',
  error_static_methods: 'Error',
  error_static_properties: 'Error',
  // js/src/vm/GeneratorObject.cpp
  generator_methods: 'Generator.prototype',
  // js/src/vm/Iteration.cpp
  array_iterator_methods: '%ArrayIteratorPrototype%',
  iterator_helper_methods: '%IteratorHelperPrototype%',
  iterator_methods: 'Iterator.prototype',
  iterator_properties: 'Iterator.prototype',
  iterator_range_methods: '%IteratorRangePrototype%',
  iterator_static_methods: 'Iterator',
  regexp_string_iterator_methods: '%RegExpStringIteratorPrototype%',
  string_iterator_methods: '%StringIteratorPrototype%',
  wrap_for_valid_iterator_methods: '%WrapForValidIteratorPrototype%',
  // js/src/vm/JSFunction.cpp
  function_methods: 'Function.prototype',
  function_properties: 'Function.prototype',
  // js/src/vm/SharedArrayObject.cpp
  sharedarray_functions: 'SharedArrayBuffer',
  sharedarray_properties: 'SharedArrayBuffer',
  sharedarray_proto_functions: 'SharedArrayBuffer.prototype',
  sharedarray_proto_properties: 'SharedArrayBuffer.prototype',
  // js/src/vm/TypedArrayObject.cpp
  'TypedArrayObject::protoAccessors': 'TypedArray.prototype',
  'TypedArrayObject::protoFunctions': 'TypedArray.prototype',
  'TypedArrayObject::staticFunctions': 'TypedArray',
  'TypedArrayObject::staticProperties': 'TypedArray',
  uint8array_methods: 'Uint8Array.prototype',
  uint8array_static_methods: 'Uint8Array',
};

// Known tables that intentionally have no spec receiver (SpiderMonkey
// internals, testing/profiling helpers). Skipped without a warning.
const IGNORED_TABLES = new Set([
  'CloneBufferObject::props_', // builtin/TestingFunctions.cpp
  'intl_extensions', // builtin/intl/IntlObject.cpp (addIntlExtras)
  'intrinsic_functions', // vm/SelfHosting.cpp
  'profiling_functions', // builtin/Profilers.cpp
  'SavedFrame::protoAccessors', // vm/SavedStacks.cpp
  'SavedFrame::protoFunctions',
  'SavedFrame::staticFunctions',
]);

// Entry macros that define methods/accessors we want.
// kind: how to interpret the macro arguments.
const ENTRY_MACROS = {
  JS_FN: { kind: 'fn' },
  JS_INLINABLE_FN: { kind: 'fn' },
  JS_TRAMPOLINE_FN: { kind: 'fn' },
  JS_FNINFO: { kind: 'fn' },
  JS_SELF_HOSTED_FN: { kind: 'selfHostedFn' },
  JS_SYM_FN: { kind: 'symFn' },
  JS_SELF_HOSTED_SYM_FN: { kind: 'selfHostedSymFn' },
  JS_PSG: { kind: 'getter' },
  JS_INLINABLE_PSG: { kind: 'getter' },
  JS_PSGS: { kind: 'getterSetter' },
  JS_SYM_GET: { kind: 'symGetter' },
  JS_SYM_GETSET: { kind: 'symGetterSetter' },
  JS_SELF_HOSTED_GET: { kind: 'selfHostedGetter' },
  JS_SELF_HOSTED_GETSET: { kind: 'selfHostedGetterSetter' },
  JS_SELF_HOSTED_SYM_GET: { kind: 'selfHostedSymGetter' },
};

// Data properties, terminators, and other macros that are expected inside
// tables but never produce a record. Skipped without a warning.
const SILENT_MACROS = new Set([
  'JS_FS_END',
  'JS_PS_END',
  'JS_STRING_PS',
  'JS_STRING_SYM_PS',
  'JS_DOUBLE_PS',
  'JS_INT32_PS',
]);

const TABLE_START_RE =
  /(?:^|\n)[^\S\n]*(?:static[^\S\n]+)?(?:const|constexpr)[^\S\n]+(JSFunctionSpec|JSPropertySpec)[^\S\n]+(?:js::)?([A-Za-z_]\w*(?:::\w+)*)\s*\[\]\s*=\s*\{/g;

const CPP_DEF_RE =
  /(?:^|\n)[^\S\n]*(?:(?:static|inline|constexpr|MOZ_ALWAYS_INLINE|MOZ_NEVER_INLINE)[^\S\n]+)*bool[^\S\n]+((?:\w+::)*\w+)\s*\(\s*JSContext\s*\*/g;

const SELF_HOSTED_DEF_RE = /(?:^|\n)[^\S\n]*function[^\S\n]+(\$?[A-Za-z0-9_]+)\s*\(/g;

async function walk(dir, ext, out = []) {
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      await walk(full, ext, out);
    } else if (entry.isFile() && entry.name.endsWith(ext)) {
      out.push(full);
    }
  }
  return out;
}

// Replace comments with spaces (newlines preserved) so line numbers and
// offsets are unchanged. String- and char-literal aware.
function stripComments(src) {
  const out = src.split('');
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i];
    if (c === '"' || c === "'") {
      const quote = c;
      i++;
      while (i < n && src[i] !== quote) {
        if (src[i] === '\\') i++;
        i++;
      }
      i++;
    } else if (c === '/' && src[i + 1] === '/') {
      while (i < n && src[i] !== '\n') {
        out[i] = ' ';
        i++;
      }
    } else if (c === '/' && src[i + 1] === '*') {
      out[i] = ' ';
      out[i + 1] = ' ';
      i += 2;
      while (i < n && !(src[i] === '*' && src[i + 1] === '/')) {
        if (src[i] !== '\n') out[i] = ' ';
        i++;
      }
      if (i < n) {
        out[i] = ' ';
        out[i + 1] = ' ';
        i += 2;
      }
    } else {
      i++;
    }
  }
  return out.join('');
}

function makeLineFinder(src) {
  const starts = [0];
  for (let i = 0; i < src.length; i++) {
    if (src[i] === '\n') starts.push(i + 1);
  }
  return offset => {
    let lo = 0;
    let hi = starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (starts[mid] <= offset) lo = mid;
      else hi = mid - 1;
    }
    return lo + 1;
  };
}

// From an opening '(' at src[open], return the offset just past the
// matching ')' (or -1). Comments must already be stripped.
function matchParen(src, open) {
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    const c = src[i];
    if (c === '"' || c === "'") {
      const quote = c;
      i++;
      while (i < src.length && src[i] !== quote) {
        if (src[i] === '\\') i++;
        i++;
      }
    } else if (c === '(') {
      depth++;
    } else if (c === ')') {
      depth--;
      if (depth === 0) return i + 1;
    }
  }
  return -1;
}

function splitArgs(argText) {
  const args = [];
  let depth = 0;
  let current = '';
  for (let i = 0; i < argText.length; i++) {
    const c = argText[i];
    if (c === '"' || c === "'") {
      const quote = c;
      current += c;
      i++;
      while (i < argText.length && argText[i] !== quote) {
        if (argText[i] === '\\') {
          current += argText[i];
          i++;
        }
        current += argText[i];
        i++;
      }
      current += quote;
    } else if (c === '(' || c === '[' || c === '{') {
      depth++;
      current += c;
    } else if (c === ')' || c === ']' || c === '}') {
      depth--;
      current += c;
    } else if (c === ',' && depth === 0) {
      args.push(current.trim());
      current = '';
    } else {
      current += c;
    }
  }
  if (current.trim()) args.push(current.trim());
  return args;
}

// "foo" or adjacent-literal concatenation ("foo" "bar") -> foobar.
// Returns null if the argument is not a string literal.
function stringArg(arg) {
  if (!arg || !arg.startsWith('"')) return null;
  let result = '';
  const re = /"((?:[^"\\]|\\.)*)"/g;
  let m;
  while ((m = re.exec(arg)) !== null) {
    result += m[1];
  }
  return result;
}

class DefinitionIndex {
  constructor() {
    // name -> Map<path, line of first definition in that file>
    this.byName = new Map();
  }

  add(name, filePath, line) {
    let files = this.byName.get(name);
    if (!files) {
      files = new Map();
      this.byName.set(name, files);
    }
    if (!files.has(filePath)) {
      files.set(filePath, line);
    }
  }

  // Prefer a definition in `preferredPath`; otherwise accept only an
  // unambiguous (single-file) definition.
  find(name, preferredPath) {
    const files = this.byName.get(name);
    if (!files) return null;
    if (preferredPath !== undefined && files.has(preferredPath)) {
      return { path: preferredPath, line: files.get(preferredPath) };
    }
    if (files.size === 1) {
      const [[p, line]] = files.entries();
      return { path: p, line };
    }
    return null;
  }
}

function indexCppDefinitions(index, relPath, stripped, lineOf) {
  CPP_DEF_RE.lastIndex = 0;
  let m;
  while ((m = CPP_DEF_RE.exec(stripped)) !== null) {
    // The match ends inside "(\s*JSContext\s*\*"; find the '(' that started
    // the parameter list and balance from there.
    const parenStart = stripped.lastIndexOf('(', CPP_DEF_RE.lastIndex - 1);
    const close = matchParen(stripped, parenStart);
    if (close === -1) continue;
    let j = close;
    while (j < stripped.length && /\s/.test(stripped[j])) j++;
    if (stripped[j] !== '{') continue; // declaration, not a definition
    const name = m[1];
    const nameOffset = m.index + m[0].indexOf(name);
    const line = lineOf(nameOffset);
    index.add(name, relPath, line);
    if (name.startsWith('js::')) {
      index.add(name.slice(4), relPath, line);
    }
  }
}

function symbolProp(symName) {
  return `[Symbol.${symName}]`;
}

function joinName(receiver, prop) {
  if (!receiver) return prop;
  if (prop.startsWith('[')) return `${receiver}${prop}`;
  return `${receiver}.${prop}`;
}

export async function extract(root) {
  const warnings = [];
  const cppFiles = [];
  for (const dir of CPP_DIRS) {
    await walk(path.join(root, dir), '.cpp', cppFiles);
  }
  cppFiles.sort();

  const cppSources = new Map(); // relPath -> { stripped, lineOf }
  const cppIndex = new DefinitionIndex();
  for (const file of cppFiles) {
    const relPath = path.relative(root, file).split(path.sep).join('/');
    const raw = await fs.readFile(file, 'utf8');
    const stripped = stripComments(raw);
    const lineOf = makeLineFinder(stripped);
    cppSources.set(relPath, { stripped, lineOf });
    indexCppDefinitions(cppIndex, relPath, stripped, lineOf);
  }

  // Self-hosted JS function definitions.
  const selfHostedIndex = new DefinitionIndex();
  const jsFiles = [];
  for (const dir of SELF_HOSTED_DIRS) {
    await walk(path.join(root, dir), '.js', jsFiles);
  }
  jsFiles.sort();
  for (const file of jsFiles) {
    const relPath = path.relative(root, file).split(path.sep).join('/');
    const raw = await fs.readFile(file, 'utf8');
    const stripped = stripComments(raw);
    const lineOf = makeLineFinder(stripped);
    SELF_HOSTED_DEF_RE.lastIndex = 0;
    let m;
    while ((m = SELF_HOSTED_DEF_RE.exec(stripped)) !== null) {
      selfHostedIndex.add(m[1], relPath, lineOf(m.index + m[0].indexOf('function')));
    }
  }

  const records = [];
  const seenNames = new Set();
  const warnedMacros = new Set();

  const findCppImpl = (fnRef, tableName, relPath) => {
    let ref = fnRef.replace(/^&/, '').trim();
    if (ref.startsWith('js::')) ref = ref.slice(4);
    if (!/^[A-Za-z_]\w*(?:::\w+)*$/.test(ref)) return null;
    const candidates = [];
    if (!ref.includes('::') && tableName.includes('::')) {
      const cls = tableName.slice(0, tableName.lastIndexOf('::'));
      candidates.push(`${cls}::${ref}`);
    }
    candidates.push(ref);
    for (const candidate of candidates) {
      const found = cppIndex.find(candidate, relPath);
      if (found) return found;
    }
    return null;
  };

  const addRecord = (name, links) => {
    if (seenNames.has(name)) return; // e.g. #if/#else duplicate tables
    seenNames.add(name);
    records.push({ name, links });
  };

  const emit = ({ receiver, prop, prefix, entry, cppFn, selfHosted, tableName, relPath }) => {
    const name = `${prefix ?? ''}${joinName(receiver, prop)}`;
    const links = [{ label: 'entry', path: relPath, line: entry }];
    if (cppFn) {
      const impl = findCppImpl(cppFn, tableName, relPath);
      if (impl) {
        links.push({ label: 'impl (C++)', path: impl.path, line: impl.line });
      }
    }
    if (selfHosted) {
      const impl = selfHostedIndex.find(selfHosted);
      if (impl) {
        links.push({ label: 'impl (self-hosted JS)', path: impl.path, line: impl.line });
      }
    }
    addRecord(name, links);
  };

  for (const [relPath, { stripped, lineOf }] of cppSources) {
    TABLE_START_RE.lastIndex = 0;
    let tableMatch;
    while ((tableMatch = TABLE_START_RE.exec(stripped)) !== null) {
      const tableName = tableMatch[2];
      const tableLine = lineOf(tableMatch.index + 1);
      if (IGNORED_TABLES.has(tableName)) continue;
      const receiver = TABLE_RECEIVERS[tableName];
      if (receiver === undefined) {
        warnings.push(`unmapped table '${tableName}' at ${relPath}:${tableLine}; skipped`);
        continue;
      }

      // Slice out the initializer block `{ ... };`.
      const braceOpen = stripped.indexOf('{', tableMatch.index);
      let depth = 0;
      let braceClose = -1;
      for (let i = braceOpen; i < stripped.length; i++) {
        if (stripped[i] === '{') depth++;
        else if (stripped[i] === '}') {
          depth--;
          if (depth === 0) {
            braceClose = i;
            break;
          }
        }
      }
      if (braceClose === -1) {
        warnings.push(`unterminated table '${tableName}' at ${relPath}:${tableLine}; skipped`);
        continue;
      }
      const block = stripped.slice(braceOpen, braceClose);

      const macroRe = /\b(JS_[A-Z0-9_]+)\s*\(/g;
      let entryMatch;
      while ((entryMatch = macroRe.exec(block)) !== null) {
        const macro = entryMatch[1];
        const absOffset = braceOpen + entryMatch.index;
        const entryLine = lineOf(absOffset);
        const parenStart = braceOpen + entryMatch.index + entryMatch[0].length - 1;
        const close = matchParen(stripped, parenStart);
        if (close !== -1) macroRe.lastIndex = close - braceOpen;

        if (SILENT_MACROS.has(macro)) continue;
        const spec = ENTRY_MACROS[macro];
        if (!spec) {
          const key = `${macro}@${tableName}`;
          if (!warnedMacros.has(key)) {
            warnedMacros.add(key);
            warnings.push(
              `unrecognized entry macro ${macro} in table '${tableName}' at ${relPath}:${entryLine}; skipped`,
            );
          }
          continue;
        }
        if (close === -1) {
          warnings.push(`unbalanced ${macro} entry at ${relPath}:${entryLine}; skipped`);
          continue;
        }
        const args = splitArgs(stripped.slice(parenStart + 1, close - 1));
        const common = { receiver, entry: entryLine, tableName, relPath };

        switch (spec.kind) {
          case 'fn':
            emit({ ...common, prop: stringArg(args[0]) ?? '', cppFn: args[1] });
            break;
          case 'selfHostedFn':
            emit({ ...common, prop: stringArg(args[0]) ?? '', selfHosted: stringArg(args[1]) });
            break;
          case 'symFn':
            emit({ ...common, prop: symbolProp(args[0]), cppFn: args[1] });
            break;
          case 'selfHostedSymFn':
            emit({ ...common, prop: symbolProp(args[0]), selfHosted: stringArg(args[1]) });
            break;
          case 'getter':
            emit({ ...common, prop: stringArg(args[0]) ?? '', prefix: 'get ', cppFn: args[1] });
            break;
          case 'getterSetter':
            emit({ ...common, prop: stringArg(args[0]) ?? '', prefix: 'get ', cppFn: args[1] });
            emit({ ...common, prop: stringArg(args[0]) ?? '', prefix: 'set ', cppFn: args[2] });
            break;
          case 'symGetter':
            emit({ ...common, prop: symbolProp(args[0]), prefix: 'get ', cppFn: args[1] });
            break;
          case 'symGetterSetter':
            emit({ ...common, prop: symbolProp(args[0]), prefix: 'get ', cppFn: args[1] });
            emit({ ...common, prop: symbolProp(args[0]), prefix: 'set ', cppFn: args[2] });
            break;
          case 'selfHostedGetter':
            emit({
              ...common,
              prop: stringArg(args[0]) ?? '',
              prefix: 'get ',
              selfHosted: stringArg(args[1]),
            });
            break;
          case 'selfHostedGetterSetter':
            emit({
              ...common,
              prop: stringArg(args[0]) ?? '',
              prefix: 'get ',
              selfHosted: stringArg(args[1]),
            });
            emit({
              ...common,
              prop: stringArg(args[0]) ?? '',
              prefix: 'set ',
              selfHosted: stringArg(args[2]),
            });
            break;
          case 'selfHostedSymGetter':
            emit({
              ...common,
              prop: symbolProp(args[0]),
              prefix: 'get ',
              selfHosted: stringArg(args[1]),
            });
            break;
          default:
            break;
        }
      }
    }
  }

  return { records, warnings };
}
