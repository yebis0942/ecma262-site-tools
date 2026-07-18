// QuickJS (quickjs-ng) extractor for impl-links.
//
// Parses `static const JSCFunctionListEntry <table>[] = { ... }` blocks in
// quickjs.c and turns JS_CFUNC_DEF / JS_CFUNC_MAGIC_DEF / JS_CFUNC_SPECIAL_DEF /
// JS_ITERATOR_NEXT_DEF / JS_CGETSET_DEF / JS_CGETSET_MAGIC_DEF / JS_ALIAS_DEF /
// JS_ALIAS_BASE_DEF entries into records. See scripts/impl-links/DESIGN.md.

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

const SOURCE = 'quickjs.c';

// Table variable name -> spec receiver.
// '' means the global object (bare names like `parseInt`).
// null means "known table, intentionally skipped" (data-only tables,
// container objects, or non-ECMA-262 APIs) — no warning is emitted.
const RECEIVERS = new Map(
  Object.entries({
    js_object_funcs: 'Object',
    js_object_proto_funcs: 'Object.prototype',
    js_function_proto_funcs: 'Function.prototype',
    js_error_funcs: 'Error',
    js_error_proto_funcs: 'Error.prototype',
    js_array_funcs: 'Array',
    js_array_proto_funcs: 'Array.prototype',
    js_array_unscopables_funcs: null, // data properties of Array.prototype[Symbol.unscopables]
    js_array_iterator_proto_funcs: '%ArrayIteratorPrototype%',
    js_iterator_funcs: 'Iterator',
    js_iterator_proto_funcs: 'Iterator.prototype',
    js_iterator_helper_proto_funcs: '%IteratorHelperPrototype%',
    js_iterator_wrap_proto_funcs: '%WrapForValidIteratorPrototype%',
    js_iterator_concat_proto_funcs: null, // iterator-sequencing proposal, not in the spec
    js_number_funcs: 'Number',
    js_number_proto_funcs: 'Number.prototype',
    js_boolean_proto_funcs: 'Boolean.prototype',
    js_string_funcs: 'String',
    js_string_proto_funcs: 'String.prototype',
    js_string_iterator_proto_funcs: '%StringIteratorPrototype%',
    js_math_funcs: 'Math',
    js_math_obj: null, // container: defines the `Math` property on the global
    js_regexp_funcs: 'RegExp',
    js_regexp_proto_funcs: 'RegExp.prototype',
    js_regexp_string_iterator_proto_funcs: '%RegExpStringIteratorPrototype%',
    js_json_funcs: 'JSON',
    js_json_obj: null, // container
    js_reflect_funcs: 'Reflect',
    js_reflect_obj: null, // container
    js_proxy_funcs: 'Proxy',
    js_symbol_funcs: 'Symbol',
    js_symbol_proto_funcs: 'Symbol.prototype',
    js_map_funcs: 'Map',
    js_map_proto_funcs: 'Map.prototype',
    js_map_iterator_proto_funcs: '%MapIteratorPrototype%',
    js_set_funcs: 'Set',
    js_set_proto_funcs: 'Set.prototype',
    js_set_iterator_proto_funcs: '%SetIteratorPrototype%',
    js_weak_map_proto_funcs: 'WeakMap.prototype',
    js_weak_set_proto_funcs: 'WeakSet.prototype',
    js_generator_function_proto_funcs: 'GeneratorFunction.prototype',
    js_generator_proto_funcs: 'Generator.prototype',
    js_disposable_stack_proto_funcs: 'DisposableStack.prototype',
    js_async_disposable_stack_proto_funcs: 'AsyncDisposableStack.prototype',
    js_promise_funcs: 'Promise',
    js_promise_proto_funcs: 'Promise.prototype',
    js_async_function_proto_funcs: 'AsyncFunction.prototype',
    js_async_iterator_proto_funcs: '%AsyncIteratorPrototype%',
    js_async_from_sync_iterator_proto_funcs: '%AsyncFromSyncIteratorPrototype%',
    js_async_generator_function_proto_funcs: 'AsyncGeneratorFunction.prototype',
    js_async_generator_proto_funcs: 'AsyncGenerator.prototype',
    js_global_funcs: '',
    js_date_funcs: 'Date',
    js_date_proto_funcs: 'Date.prototype',
    js_bigint_funcs: 'BigInt',
    js_bigint_proto_funcs: 'BigInt.prototype',
    js_array_buffer_funcs: 'ArrayBuffer',
    js_array_buffer_proto_funcs: 'ArrayBuffer.prototype',
    js_shared_array_buffer_funcs: 'SharedArrayBuffer',
    js_shared_array_buffer_proto_funcs: 'SharedArrayBuffer.prototype',
    js_typed_array_base_funcs: 'TypedArray',
    js_typed_array_base_proto_funcs: 'TypedArray.prototype',
    js_typed_array_funcs: null, // BYTES_PER_ELEMENT data properties only
    js_dataview_proto_funcs: 'DataView.prototype',
    js_atomics_funcs: 'Atomics',
    js_atomics_obj: null, // container
    js_perf_proto_funcs: null, // non-spec (performance API)
    js_weakref_proto_funcs: 'WeakRef.prototype',
    js_finrec_proto_funcs: 'FinalizationRegistry.prototype',
    js_callsite_proto_funcs: null, // non-spec (error call sites)
    js_domexception_proto_funcs: null, // WHATWG DOMException
    js_base64_funcs: null, // btoa/atob (HTML spec)
    js_uint8array_funcs: 'Uint8Array',
    js_uint8array_proto_funcs: 'Uint8Array.prototype',
  }),
);

// Entry macros we understand. Value: how to find the implementing C function
// among the macro arguments (0-based argument indices).
const MACROS = new Map(
  Object.entries({
    JS_CFUNC_DEF: { kind: 'func', fnArg: 2 },
    JS_CFUNC_DEF2: { kind: 'func', fnArg: 2 },
    JS_CFUNC_MAGIC_DEF: { kind: 'func', fnArg: 2 },
    JS_CFUNC_SPECIAL_DEF: { kind: 'func', fnArg: 3 },
    JS_ITERATOR_NEXT_DEF: { kind: 'func', fnArg: 2 },
    JS_CGETSET_DEF: { kind: 'getset', getArg: 1, setArg: 2 },
    JS_CGETSET_DEF2: { kind: 'getset', getArg: 1, setArg: 2 },
    JS_CGETSET_MAGIC_DEF: { kind: 'getset', getArg: 1, setArg: 2 },
    JS_ALIAS_DEF: { kind: 'alias', fromArg: 1 },
    JS_ALIAS_BASE_DEF: { kind: 'alias', fromArg: 1, baseArg: 2 },
  }),
);

// Blank out comments (and, in the second copy, string/char literal contents)
// with spaces, preserving offsets and newlines. `code` keeps strings intact
// for value extraction; `masked` is safe for structural scanning (parens,
// braces, commas).
function maskSource(src) {
  const code = src.split('');
  const masked = src.split('');
  let state = 'normal'; // normal | line | block | string | char
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    const next = src[i + 1];
    switch (state) {
      case 'normal':
        if (c === '/' && next === '/') {
          state = 'line';
          code[i] = masked[i] = ' ';
        } else if (c === '/' && next === '*') {
          state = 'block';
          code[i] = masked[i] = ' ';
        } else if (c === '"') {
          state = 'string';
        } else if (c === "'") {
          state = 'char';
        }
        break;
      case 'line':
        if (c === '\n') state = 'normal';
        else code[i] = masked[i] = ' ';
        break;
      case 'block':
        if (c === '*' && next === '/') {
          code[i] = masked[i] = ' ';
          code[i + 1] = masked[i + 1] = ' ';
          i++;
          state = 'normal';
        } else if (c !== '\n') {
          code[i] = masked[i] = ' ';
        }
        break;
      case 'string':
      case 'char': {
        const quote = state === 'string' ? '"' : "'";
        if (c === '\\') {
          masked[i] = ' ';
          if (next !== undefined && next !== '\n') {
            masked[i + 1] = ' ';
            i++;
          }
        } else if (c === quote) {
          state = 'normal';
        } else if (c !== '\n') {
          masked[i] = ' ';
        }
        break;
      }
    }
  }
  return { code: code.join(''), masked: masked.join('') };
}

function makeLineIndex(src) {
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
    return lo + 1; // 1-based
  };
}

// Given `masked` and the offset of an opening paren, return the offset of the
// matching close paren, or -1.
function matchParen(masked, open) {
  let depth = 0;
  for (let i = open; i < masked.length; i++) {
    const c = masked[i];
    if (c === '(') depth++;
    else if (c === ')') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

// Split the argument list between (open, close) at top-level commas.
// Returns trimmed argument strings taken from `code` (strings intact).
function splitArgs(code, masked, open, close) {
  const args = [];
  let depth = 0;
  let start = open + 1;
  for (let i = open + 1; i < close; i++) {
    const c = masked[i];
    if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') depth--;
    else if (c === ',' && depth === 0) {
      args.push(code.slice(start, i).trim());
      start = i + 1;
    }
  }
  args.push(code.slice(start, close).trim());
  return args;
}

// Index of C function definitions: name -> 1-based line of the definition.
// A definition is a top-level `static <type> <name>(<params>)` followed by
// `{` (prototypes end with `;` and are excluded).
function indexFunctionDefinitions(code, masked, lineOf) {
  const defs = new Map();
  const re = /^static[ \t]+[^=;{}()]*?\b([A-Za-z_][A-Za-z0-9_]*)[ \t]*\(/dgm;
  let m;
  while ((m = re.exec(masked)) !== null) {
    const name = m[1];
    const open = m.index + m[0].length - 1;
    const close = matchParen(masked, open);
    if (close === -1) continue;
    let j = close + 1;
    while (j < masked.length && /\s/.test(masked[j])) j++;
    if (masked[j] !== '{') continue; // prototype or something else
    if (!defs.has(name)) defs.set(name, lineOf(m.indices[1][0]));
    re.lastIndex = close + 1;
  }
  return defs;
}

function stringValue(arg) {
  const m = /^"((?:[^"\\]|\\.)*)"$/.exec(arg);
  return m ? m[1] : null;
}

function buildName(receiver, prop, accessor) {
  let base;
  if (prop.startsWith('[')) {
    // e.g. "[Symbol.iterator]" -> Array.prototype[Symbol.iterator]
    base = receiver === '' ? prop : `${receiver}${prop}`;
  } else {
    base = receiver === '' ? prop : `${receiver}.${prop}`;
  }
  return accessor ? `${accessor} ${base}` : base;
}

export async function extract(root) {
  const src = await readFile(join(root, SOURCE), 'utf8');
  const { code, masked } = maskSource(src);
  const lineOf = makeLineIndex(src);
  const fnDefs = indexFunctionDefinitions(code, masked, lineOf);

  const warnings = [];
  // table name -> Map<prop, fn> (for alias resolution)
  const tableProps = new Map();
  // Parsed entries: { table, receiver, kind, prop, line, ... }
  const entries = [];

  const tableRe =
    /\bstatic\s+const\s+JSCFunctionListEntry\s+([A-Za-z_][A-Za-z0-9_]*)\s*\[\]\s*=\s*\{/g;
  let t;
  while ((t = tableRe.exec(masked)) !== null) {
    const table = t[1];
    const bodyStart = t.index + t[0].length;
    let bodyEnd = bodyStart;
    let depth = 1;
    while (bodyEnd < masked.length && depth > 0) {
      const c = masked[bodyEnd];
      if (c === '{') depth++;
      else if (c === '}') depth--;
      bodyEnd++;
    }
    bodyEnd--; // offset of the closing '}'
    tableRe.lastIndex = bodyEnd + 1;

    if (!RECEIVERS.has(table)) {
      warnings.push(`unmapped table ${table} (${SOURCE}:${lineOf(t.index)}), skipped`);
      continue;
    }
    const receiver = RECEIVERS.get(table);
    if (receiver === null) continue; // intentionally skipped

    const props = new Map();
    tableProps.set(table, props);

    const macroRe = /\b(JS_[A-Z0-9_]+_DEF2?)\s*\(/g;
    macroRe.lastIndex = bodyStart;
    let e;
    while ((e = macroRe.exec(masked)) !== null && e.index < bodyEnd) {
      const macro = e[1];
      const open = e.index + e[0].length - 1;
      const close = matchParen(masked, open);
      if (close === -1 || close > bodyEnd) {
        warnings.push(`unbalanced macro ${macro} in ${table} (${SOURCE}:${lineOf(e.index)})`);
        break;
      }
      macroRe.lastIndex = close + 1;

      const spec = MACROS.get(macro);
      if (spec === undefined) continue; // JS_PROP_*_DEF, JS_OBJECT_DEF, ... : not a function entry

      const args = splitArgs(code, masked, open, close);
      const prop = stringValue(args[0]);
      if (prop === null) {
        warnings.push(
          `non-literal property name in ${table}: ${macro}(${args[0]}, ...) (${SOURCE}:${lineOf(e.index)})`,
        );
        continue;
      }
      const line = lineOf(e.index);

      if (spec.kind === 'func') {
        const fn = args[spec.fnArg];
        entries.push({ table, receiver, kind: 'func', prop, fn, line });
        if (!props.has(prop)) props.set(prop, fn);
      } else if (spec.kind === 'getset') {
        const getter = args[spec.getArg];
        const setter = args[spec.setArg];
        if (getter && getter !== 'NULL') {
          entries.push({ table, receiver, kind: 'get', prop, fn: getter, line });
        }
        if (setter && setter !== 'NULL') {
          entries.push({ table, receiver, kind: 'set', prop, fn: setter, line });
        }
      } else if (spec.kind === 'alias') {
        const from = stringValue(args[spec.fromArg]);
        const base = spec.baseArg === undefined ? null : args[spec.baseArg];
        entries.push({ table, receiver, kind: 'alias', prop, from, base, line });
      }
    }
  }

  // Resolve aliases to the C function of the aliased entry.
  for (const entry of entries) {
    if (entry.kind !== 'alias') continue;
    let fn = null;
    if (entry.from !== null) {
      if (entry.base === null) {
        fn = tableProps.get(entry.table)?.get(entry.from) ?? null;
      } else if (entry.base === '0') {
        // base 0 aliases a property of the global object
        fn = tableProps.get('js_global_funcs')?.get(entry.from) ?? null;
      }
    }
    if (fn === null) {
      warnings.push(
        `unresolved alias "${entry.prop}" -> "${entry.from}" in ${entry.table} (${SOURCE}:${entry.line}), entry link only`,
      );
    }
    entry.fn = fn;
  }

  // Assemble records, merging duplicates by name.
  const byName = new Map();
  for (const entry of entries) {
    const accessor = entry.kind === 'get' || entry.kind === 'set' ? entry.kind : null;
    const name = buildName(entry.receiver, entry.prop, accessor);
    const links = [{ label: 'entry', path: SOURCE, line: entry.line }];
    if (entry.fn != null && fnDefs.has(entry.fn)) {
      links.push({ label: 'impl (C)', path: SOURCE, line: fnDefs.get(entry.fn) });
    }
    const existing = byName.get(name);
    if (existing === undefined) {
      byName.set(name, { name, links });
    } else {
      for (const link of links) {
        if (
          !existing.links.some(
            l => l.label === link.label && l.path === link.path && l.line === link.line,
          )
        ) {
          existing.links.push(link);
        }
      }
    }
  }

  return { records: [...byName.values()], warnings };
}
