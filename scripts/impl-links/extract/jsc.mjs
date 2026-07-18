// JavaScriptCore extractor.
//
// Scans Source/JavaScriptCore/ of a WebKit checkout and produces records
// mapping spec-style built-in names to source locations. Three sources are
// combined:
//
//  (1) LUT comment tables in runtime/*.cpp:
//        /* Source for XxxYyy.lut.h
//        @begin <tableName>
//          <propName>  <cppFunc|JSBuiltin>  <flags> [<len>] [<intrinsic>]
//        @end
//        */
//      The table's file name determines the receiver (ArrayConstructor.cpp
//      -> `Array`, StringPrototype.cpp -> `String.prototype`, ...). Each
//      entry line is an "entry" link; the referenced C++ function (found via
//      JSC_DEFINE_HOST_FUNCTION / JSC_DEFINE_CUSTOM_GETTER) is an
//      "impl (C++)" link; `JSBuiltin` entries link to the self-hosted
//      function in builtins/<SameBase>.js as "impl (self-hosted JS)".
//
//  (2) finishCreation-style registrations in runtime/*.cpp:
//        JSC_NATIVE_FUNCTION[_WITHOUT_TRANSITION](name, cppFunc, ...)
//        JSC_NATIVE_INTRINSIC_FUNCTION[_WITHOUT_TRANSITION](...)
//        JSC_NATIVE_[INTRINSIC_]GETTER[_WITHOUT_TRANSITION](...)
//        JSC_BUILTIN_FUNCTION[_WITHOUT_TRANSITION](name, xxxCodeGenerator, ...)
//        putDirectNativeFunction[WithoutTransition](vm, globalObject, name, len, cppFunc, ...)
//      The registration line is the "entry" link; the C++ definition or the
//      self-hosted function resolved from the code-generator name supplies
//      the impl link.
//
//  (3) Self-hosted builtins in builtins/*.js: top-level `function <name>(`
//      declarations (with `@overriddenName=`/`@getter` annotations honored;
//      `@linkTimeConstant`/`@visibility=Private*` helpers skipped) become
//      "impl (self-hosted JS)" links, merged by name with (1)/(2).
//
// Accessors are reported as `get <receiver>.<name>`.

import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';

const RUNTIME_DIR = 'Source/JavaScriptCore/runtime';
const BUILTINS_DIR = 'Source/JavaScriptCore/builtins';

// File basenames whose contents are internal helpers / out of scope.
const SKIP_BASES = new Set([
  'ConsoleObject',
  'GlobalOperations',
  'IteratorHelpers',
  'JSInternalPromiseConstructor',
  'JSInternalPromisePrototype',
  'JSModuleLoader',
  'ModuleLoader',
  'PromiseOperations',
  'ProxyHelpers',
  'WebAssembly',
]);

// Explicit receiver overrides (checked before the generic suffix rules,
// both for the raw basename and for the basename with a leading `JS`
// stripped).
const SPECIAL_RECEIVERS = new Map(
  Object.entries({
    AtomicsObject: 'Atomics',
    IntlObject: 'Intl',
    JSGlobalObject: '', // global functions: bare names like `isNaN`
    JSONObject: 'JSON',
    JSTypedArrayViewConstructor: '%TypedArray%',
    JSTypedArrayViewPrototype: '%TypedArray%.prototype',
    MathObject: 'Math',
    ReflectObject: 'Reflect',
    TemporalNow: 'Temporal.Now',
    TemporalObject: 'Temporal',
    TypedArrayConstructor: '%TypedArray%',
    TypedArrayPrototype: '%TypedArray%.prototype',
    WeakObjectRefPrototype: 'WeakRef.prototype',
  }),
);

// Prototypes that are spec intrinsics without a public path; spec clause
// titles use the %...% form (e.g. `%GeneratorPrototype%.next ( value )`).
const INTRINSIC_PROTOTYPES = new Set([
  'ArrayIteratorPrototype',
  'AsyncFromSyncIteratorPrototype',
  'AsyncGeneratorPrototype',
  'AsyncIteratorPrototype',
  'GeneratorPrototype',
  'IteratorHelperPrototype',
  'MapIteratorPrototype',
  'RegExpStringIteratorPrototype',
  'SetIteratorPrototype',
  'StringIteratorPrototype',
  'WrapForValidIteratorPrototype',
]);

function qualifyCore(core) {
  const m = /^(Intl|Temporal)([A-Z].*)$/.exec(core);
  if (m) return `${m[1]}.${m[2]}`;
  return core;
}

// basename (no extension) -> receiver string, or null (skip), or undefined
// (unknown; caller warns).
function receiverForBase(base) {
  for (const b of [base, /^JS[A-Z]/.test(base) && base !== 'JSONObject' ? base.slice(2) : base]) {
    if (SKIP_BASES.has(b)) return null;
    if (SPECIAL_RECEIVERS.has(b)) return SPECIAL_RECEIVERS.get(b);
    if (INTRINSIC_PROTOTYPES.has(b)) return `%${b}%`;
  }
  let b = /^JS[A-Z]/.test(base) && base !== 'JSONObject' ? base.slice(2) : base;
  if (b.endsWith('Prototype')) return `${qualifyCore(b.slice(0, -'Prototype'.length))}.prototype`;
  if (b.endsWith('Constructor')) return qualifyCore(b.slice(0, -'Constructor'.length));
  if (b.endsWith('Object')) return qualifyCore(b.slice(0, -'Object'.length));
  return undefined;
}

// `[Symbol.x]` props attach without a dot: `Array.prototype[Symbol.iterator]`.
function buildName(receiver, prop, kind) {
  let name;
  if (prop.startsWith('[')) name = receiver ? `${receiver}${prop}` : prop;
  else name = receiver ? `${receiver}.${prop}` : prop;
  if (kind === 'get') return `get ${name}`;
  if (kind === 'set') return `set ${name}`;
  return name;
}

// Parse the first (property-name) argument of a registration macro.
// Returns a string, null (private name: skip silently), or undefined
// (unrecognized: caller warns).
function parseNameExpr(expr) {
  expr = expr.trim();
  let m;
  if ((m = /^"(.+)"_s$/.exec(expr))) return m[1];
  if ((m = /Identifier::fromString\(\s*vm,\s*"(.+?)"_s\s*\)/.exec(expr))) return m[1];
  if (/PrivateName\(\)\s*$/.test(expr)) return null;
  if ((m = /builtinNames\(\)\.(\w+?)PublicName\(\)\s*$/.exec(expr))) return m[1];
  if ((m = /propertyNames->(\w+?)Symbol$/.exec(expr))) return `[Symbol.${m[1]}]`;
  // Reserved-word property names carry a `Keyword` suffix in
  // CommonIdentifiers: `deleteKeyword` → `delete`, `catchKeyword` → `catch`.
  if ((m = /propertyNames->([a-z]+)Keyword$/.exec(expr))) return m[1];
  if ((m = /propertyNames->(\w+)$/.exec(expr))) return m[1];
  return undefined;
}

// Split a macro argument list on top-level commas.
function splitArgs(s) {
  const args = [];
  let depth = 0;
  let cur = '';
  for (const ch of s) {
    if (ch === '(' || ch === '[' || ch === '{') depth++;
    else if (ch === ')' || ch === ']' || ch === '}') depth--;
    if (ch === ',' && depth === 0) {
      args.push(cur);
      cur = '';
    } else {
      cur += ch;
    }
  }
  args.push(cur);
  return args.map(a => a.trim());
}

// Given file lines and a position just after a macro's `(`, collect the
// balanced argument list (macros occasionally wrap onto following lines).
function collectArgs(lines, lineIdx, colIdx) {
  let depth = 1;
  let out = '';
  let i = lineIdx;
  let j = colIdx;
  while (i < lines.length) {
    const line = lines[i];
    for (; j < line.length; j++) {
      const ch = line[j];
      if (ch === '(') depth++;
      else if (ch === ')') {
        depth--;
        if (depth === 0) return out;
      }
      out += ch;
    }
    out += ' ';
    i++;
    j = 0;
  }
  return null;
}

// WebKit's builtins code generator lower-camels the file basename:
// `ArrayPrototype` -> `arrayPrototype`, `JSIteratorPrototype` ->
// `jsIteratorPrototype` (leading acronym lowered except the last capital
// starting the next word).
function lowerCamel(s) {
  const run = /^[A-Z]+/.exec(s)?.[0] ?? '';
  if (run.length <= 1) return s.charAt(0).toLowerCase() + s.slice(1);
  if (run.length === s.length) return s.toLowerCase();
  return s.slice(0, run.length - 1).toLowerCase() + s.slice(run.length - 1);
}

const capitalize = s => s.charAt(0).toUpperCase() + s.slice(1);

export async function extract(root) {
  const warnings = new Set();
  const warn = msg => warnings.add(msg);
  const records = new Map(); // name -> { name, links: [] }

  const addLink = (name, link) => {
    let rec = records.get(name);
    if (!rec) {
      rec = { name, links: [] };
      records.set(name, rec);
    }
    if (
      !rec.links.some(l => l.path === link.path && l.line === link.line && l.label === link.label)
    ) {
      rec.links.push(link);
    }
  };

  const listFiles = async (dir, ext) =>
    (await readdir(join(root, dir))).filter(f => f.endsWith(ext)).sort();

  // ---- Pass 1: read runtime/*.cpp and builtins/*.js ----

  const runtimeFiles = [];
  for (const f of await listFiles(RUNTIME_DIR, '.cpp')) {
    const relPath = `${RUNTIME_DIR}/${f}`;
    const text = await readFile(join(root, relPath), 'utf8');
    runtimeFiles.push({ base: f.slice(0, -'.cpp'.length), relPath, lines: text.split('\n') });
  }

  // Host function / custom accessor definition index: C++ name -> location.
  const hostFnIndex = new Map();
  const DEFINE_RE =
    /^\s*(?:static\s+)?JSC_DEFINE_(?:HOST_FUNCTION|HOST_FUNCTION_WITH_ATTRIBUTES|CUSTOM_GETTER|CUSTOM_SETTER)\(\s*([A-Za-z0-9_]+)/;
  for (const { relPath, lines } of runtimeFiles) {
    for (let i = 0; i < lines.length; i++) {
      const m = DEFINE_RE.exec(lines[i]);
      if (m && !hostFnIndex.has(m[1])) hostFnIndex.set(m[1], { path: relPath, line: i + 1 });
    }
  }

  // Self-hosted builtins: per-file property map and code-generator index.
  // builtinsByBase: base -> Map(propName -> fn info)
  // generatorIndex: lowercased `<lowerCamel(base)><CapitalizedFn>` -> fn info
  const builtinsByBase = new Map();
  const generatorIndex = new Map();
  const ANNOTATION_RE = /^@(\w+)(?:=(.*))?\s*$/;
  const FUNCTION_RE = /^(?:async\s+)?function\s+([A-Za-z0-9_]+)\s*\(/;
  for (const f of await listFiles(BUILTINS_DIR, '.js')) {
    const base = f.slice(0, -'.js'.length);
    const relPath = `${BUILTINS_DIR}/${f}`;
    const lines = (await readFile(join(root, relPath), 'utf8')).split('\n');
    const fns = new Map();
    let ann = {};
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      let m;
      if ((m = ANNOTATION_RE.exec(line))) {
        ann[m[1]] = m[2] ?? true;
        continue;
      }
      if ((m = FUNCTION_RE.exec(line))) {
        const fnName = m[1];
        const isPrivate =
          ann.linkTimeConstant === true ||
          (typeof ann.visibility === 'string' && /Private/i.test(ann.visibility));
        let prop = fnName;
        if (typeof ann.overriddenName === 'string') {
          prop = ann.overriddenName.replace(/^"|"$/g, '');
        }
        const info = {
          path: relPath,
          line: i + 1,
          prop,
          kind: ann.getter === true ? 'get' : 'normal',
          isPrivate,
        };
        if (!fns.has(prop)) fns.set(prop, info);
        generatorIndex.set(`${lowerCamel(base)}${capitalize(fnName)}`.toLowerCase(), info);
      }
      if (line.trim() !== '') ann = {};
    }
    builtinsByBase.set(base, fns);
  }

  // ---- Pass 2: LUT comment tables ----

  const stats = { lut: 0, hostFn: 0, selfHosted: 0, macro: 0 };
  const SKIP_LUT_FLAGS = new Set(['CellProperty', 'ClassStructure', 'PropertyCallback']);

  for (const { base, relPath, lines } of runtimeFiles) {
    if (!lines.some(l => l.includes('@begin'))) continue;
    const receiver = receiverForBase(base);
    if (receiver === null) continue;
    if (receiver === undefined) {
      warn(`LUT: no receiver mapping for ${relPath}`);
      continue;
    }
    let inTable = false;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (/@begin\s+\w+/.test(line)) {
        inTable = true;
        continue;
      }
      if (/@end/.test(line)) {
        inTable = false;
        continue;
      }
      if (!inTable) continue;
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('//')) continue;
      const tokens = trimmed.split(/\s+/);
      if (tokens.length < 3) {
        warn(`LUT: unparsed entry at ${relPath}:${i + 1}: ${trimmed}`);
        continue;
      }
      const [prop, value, flagsToken] = tokens;
      const flags = new Set(flagsToken.split('|'));
      if (value.includes('::') || [...SKIP_LUT_FLAGS].some(fl => flags.has(fl))) continue;

      if (flags.has('Function')) {
        if (value === 'JSBuiltin') {
          const name = buildName(receiver, prop, 'normal');
          addLink(name, { label: 'entry', path: relPath, line: i + 1 });
          const fn = builtinsByBase.get(base)?.get(prop);
          if (fn) {
            addLink(name, { label: 'impl (self-hosted JS)', path: fn.path, line: fn.line });
            stats.selfHosted++;
          } else {
            warn(`LUT: JSBuiltin ${name} has no builtins/${base}.js function "${prop}"`);
          }
        } else {
          const name = buildName(receiver, prop, 'normal');
          addLink(name, { label: 'entry', path: relPath, line: i + 1 });
          const def = hostFnIndex.get(value);
          if (def) {
            addLink(name, { label: 'impl (C++)', path: def.path, line: def.line });
            stats.hostFn++;
          } else {
            warn(`LUT: host function ${value} (for ${name}) not found`);
          }
        }
        stats.lut++;
      } else if (flags.has('CustomAccessor') || flags.has('Accessor')) {
        const name = buildName(receiver, prop, 'get');
        addLink(name, { label: 'entry', path: relPath, line: i + 1 });
        const def = hostFnIndex.get(value);
        if (def) {
          addLink(name, { label: 'impl (C++)', path: def.path, line: def.line });
          stats.hostFn++;
        } else {
          warn(`LUT: accessor ${value} (for ${name}) not found`);
        }
        stats.lut++;
      }
      // Other kinds (data properties, structures, callbacks) are out of scope.
    }
  }

  // ---- Pass 3: finishCreation-style registration macros ----

  const MACRO_RE =
    /\b(JSC_NATIVE_INTRINSIC_FUNCTION_WITHOUT_TRANSITION|JSC_NATIVE_FUNCTION_WITHOUT_TRANSITION|JSC_NATIVE_INTRINSIC_FUNCTION|JSC_NATIVE_FUNCTION|JSC_NATIVE_INTRINSIC_GETTER_WITHOUT_TRANSITION|JSC_NATIVE_GETTER_WITHOUT_TRANSITION|JSC_NATIVE_GETTER|JSC_BUILTIN_FUNCTION_WITHOUT_TRANSITION|JSC_BUILTIN_FUNCTION|putDirectNativeFunctionWithoutTransition|putDirectNativeFunction)\(/g;

  for (const { base, relPath, lines } of runtimeFiles) {
    let receiver; // resolved lazily so unrelated files never warn
    let receiverResolved = false;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (/^\s*#\s*define\b/.test(line)) continue;
      MACRO_RE.lastIndex = 0;
      let m;
      while ((m = MACRO_RE.exec(line))) {
        const macro = m[1];
        const argsText = collectArgs(lines, i, m.index + m[0].length);
        if (argsText === null) {
          warn(`macro: unbalanced ${macro} at ${relPath}:${i + 1}`);
          continue;
        }
        const args = splitArgs(argsText);

        let nameExpr;
        let funcName;
        let isBuiltin = false;
        let kind = 'normal';
        if (macro.startsWith('putDirectNativeFunction')) {
          // (vm, globalObject, name, length, function, ...)
          if (args.length < 5 || args[0] !== 'vm') continue; // e.g. the JSObject.cpp definitions
          nameExpr = args[2];
          funcName = args[4];
        } else {
          nameExpr = args[0];
          funcName = args[1];
          if (macro.includes('GETTER')) kind = 'get';
          if (macro.startsWith('JSC_BUILTIN')) isBuiltin = true;
        }
        if (!/^[A-Za-z0-9_]+$/.test(funcName)) {
          warn(`macro: unparsed function argument "${funcName}" at ${relPath}:${i + 1}`);
          continue;
        }

        const prop = parseNameExpr(nameExpr);
        if (prop === null) continue; // private name
        if (prop === undefined) {
          warn(`macro: unparsed name expression "${nameExpr}" at ${relPath}:${i + 1}`);
          continue;
        }

        if (!receiverResolved) {
          receiver = receiverForBase(base);
          receiverResolved = true;
          if (receiver === undefined) warn(`macro: no receiver mapping for ${relPath}`);
        }
        if (receiver === null || receiver === undefined) continue;

        // JSArrayBufferPrototype.cpp registers on both ArrayBuffer.prototype
        // and SharedArrayBuffer.prototype; the function name disambiguates.
        let effectiveReceiver = receiver;
        if (/^sharedArrayBuffer/.test(funcName) && receiver.startsWith('ArrayBuffer')) {
          effectiveReceiver = `Shared${receiver}`;
        }

        stats.macro++;
        if (isBuiltin) {
          const genKey = funcName.replace(/CodeGenerator$/, '').toLowerCase();
          const fn = generatorIndex.get(genKey);
          const name = buildName(effectiveReceiver, prop, fn?.kind === 'get' ? 'get' : kind);
          addLink(name, { label: 'entry', path: relPath, line: i + 1 });
          if (fn) {
            addLink(name, { label: 'impl (self-hosted JS)', path: fn.path, line: fn.line });
            stats.selfHosted++;
          } else {
            warn(`macro: code generator ${funcName} (for ${name}) not resolved`);
          }
        } else {
          const name = buildName(effectiveReceiver, prop, kind);
          addLink(name, { label: 'entry', path: relPath, line: i + 1 });
          const def = hostFnIndex.get(funcName);
          if (def) {
            addLink(name, { label: 'impl (C++)', path: def.path, line: def.line });
            stats.hostFn++;
          } else {
            warn(`macro: host function ${funcName} (for ${name}) not found`);
          }
        }
      }
    }
  }

  // ---- Pass 4: standalone self-hosted builtins ----

  for (const [base, fns] of builtinsByBase) {
    const receiver = receiverForBase(base);
    if (receiver === null) continue;
    if (receiver === undefined) {
      warn(`builtins: no receiver mapping for ${BUILTINS_DIR}/${base}.js`);
      continue;
    }
    for (const fn of fns.values()) {
      if (fn.isPrivate) continue;
      const name = buildName(receiver, fn.prop, fn.kind);
      const before = records.get(name)?.links.length ?? 0;
      addLink(name, { label: 'impl (self-hosted JS)', path: fn.path, line: fn.line });
      if ((records.get(name)?.links.length ?? 0) > before) stats.selfHosted++;
    }
  }

  // Order links: entry first, then impls; sort records by name.
  const weight = label => (label === 'entry' ? 0 : 1);
  const result = [...records.values()].sort((a, b) =>
    a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
  );
  for (const rec of result) rec.links.sort((a, b) => weight(a.label) - weight(b.label));

  extract.stats = stats;
  return { records: result, warnings: [...warnings] };
}
