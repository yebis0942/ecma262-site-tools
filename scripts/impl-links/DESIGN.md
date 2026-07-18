# Engine implementation links — design

Adds a per-clause widget to built specs that links each built-in method's clause
(e.g. `sec-array.prototype.map`) to its implementation in four JS engines:
V8, JavaScriptCore (JSC), SpiderMonkey, QuickJS (quickjs-ng).

Two parts:

1. **Data generation** (`scripts/impl-links/`): scripts that scan pinned engine
   checkouts and produce `impl-links.json` mapping clause ids to permalinks.
   Re-run whenever an engine publishes a new release tag (CI cron).
2. **Widget** (`js/implLinks.js` + CSS): lazy-loads `impl-links.json` at runtime
   and adds an "impl" button next to each clause heading that has data,
   opening a panel of per-engine links. Modeled on `js/versionCompare.js`.

## Engine checkouts

Cloned via ghq, pinned to the latest release tag (detached HEAD):

| key | label          | repo                      | local path (under `$(ghq root)/github.com/`) | tag pattern                          |
|-----|----------------|---------------------------|-----------------------------------------------|--------------------------------------|
| v8  | V8             | v8/v8                     | v8/v8                                         | `^\d+\.\d+\.\d+(\.\d+)?$` (sort -V)  |
| jsc | JavaScriptCore | WebKit/WebKit             | WebKit/WebKit                                 | `^webkitgtk-2\.\d+\.\d+$`, even minor|
| sm  | SpiderMonkey   | mozilla-firefox/firefox   | mozilla-firefox/firefox                       | `^FIREFOX_[0-9_]+_RELEASE$`          |
| qjs | QuickJS        | quickjs-ng/quickjs        | quickjs-ng/quickjs                            | `^v\d+(\.\d+)*$`                     |

Plus `tc39/ecma262` (main HEAD) for the clause-id name map.

## Extractor contract

Each engine has a module `scripts/impl-links/extract/<engine>.mjs`:

```js
// root: absolute path to the engine checkout (already at the pinned tag)
// returns: Promise<{ records: Record[], warnings: string[] }>
export async function extract(root) { ... }

// Record = {
//   name:  string,   // spec-style name, see "Name rules"
//   links: Link[],   // 1 or more
// }
// Link = {
//   label: string,   // short, e.g. "entry", "impl (Torque)", "impl (self-hosted JS)"
//   path:  string,   // repo-root-relative file path, forward slashes
//   line:  number,   // 1-based
// }
```

Extractors do plain fs reads only — no git invocations, no network. They must
be resilient: unrecognized tables/entries are skipped and reported via the
`warnings` array rather than thrown.

### Name rules

- Prototype methods: `Array.prototype.map`; constructor statics: `Array.of`;
  namespace functions: `Math.abs`, `JSON.parse`, `Reflect.get`;
  global functions: `parseInt`.
- Accessors: `get Map.prototype.size` / `set Object.prototype.__proto__`.
- Well-known-symbol methods: `Array.prototype[Symbol.iterator]` (the matcher
  also accepts `[%Symbol.iterator%]`).
- `%TypedArray%`-style intrinsic receivers may be written without `%`
  (`TypedArray.prototype.map`); the matcher normalizes.
- Case does not need to be exact (matcher lowercases), but prefer canonical.

## Name → clause-id matching (`spec-names.mjs`)

Parses `spec.html` from the tc39/ecma262 checkout (source file; every clause is
`<emu-clause id="...">` with an `<h1>` title like
`Array.prototype.map ( *callbackfn* [ , *thisArg* ] )`).

- Extract (id, title) pairs; keep only titles that look like property paths
  (optionally prefixed `get `/`set `), including bracketed symbol forms
  `Array.prototype [ %Symbol.iterator% ] ( )`.
- Normalize titles and extractor names to a shared key:
  lowercase; strip the parameter list; remove spaces; `%typedarray%` ⇄
  `typedarray`; `[%symbol.x%]`/`[symbol.x]`/`[@@x]` → one canonical form.
- Export `loadSpecNames(specHtmlPath): Map<key, clauseId>` and
  `nameToKey(name): string`.

Unmatched extractor records are dropped by the driver and listed in stats.

## Output: `impl-links.json` (repo root)

```jsonc
{
  "meta": {
    "generated": "2026-07-16T00:00:00Z",
    "engines": {
      "v8": {
        "label": "V8",
        "repo": "v8/v8",
        "tag": "15.2.88",
        "rev": "3b7743895333aa2c43f0a45f1f45bbd52c61b687",
        // URL templates with {rev} already substituted by the driver;
        // only {path} and {line} remain for the widget to fill in.
        "templates": {
          "cs": "https://source.chromium.org/…{path}…;l={line}",
          "gh": "https://github.com/v8/v8/blob/<rev>/{path}#L{line}"
        }
      }
      // jsc, sm, qjs likewise (usually a single template each)
    }
  },
  "clauses": {
    "sec-array.prototype.map": {
      "v8":  [{ "t": "impl (Torque)", "tpl": "cs", "p": "src/builtins/array-map.tq", "l": 12 }],
      "jsc": [ /* … */ ]
      // engines with no data for this clause are simply absent
    }
  }
}
```

Engine display order is fixed: v8, jsc, sm, qjs. Clause keys sorted for stable
diffs. Template indirection keeps the file small (paths+lines, not full URLs).

URL templates per engine (finalized after live verification, 2026-07):

- v8: Chromium Code Search
  `https://source.chromium.org/chromium/v8/v8/+/{rev}:{path};l={line}` as the
  primary template. Code Search is an SPA that returns 200 for any path, so
  this form could not be machine-verified — every v8 link therefore also gets
  a `[gh]` fallback anchor from the second template (GitHub blob permalink,
  verified).
- sm: Searchfox `https://searchfox.org/firefox-release/rev/{rev}/{path}#{line}`.
  The mozilla-central instance is retired, and `FIREFOX_*_RELEASE` tag revs
  live on the release branch, which only the firefox-release instance renders
  (firefox-main returns 500 for them). Verified against real content,
  including the `#{line}` anchor syntax.
- jsc: GitHub `https://github.com/WebKit/WebKit/blob/{rev}/{path}#L{line}`.
  Searchfox's WebKit instance (wubkat) exists but cannot render
  webkitgtk-release-branch revs (500) and its index lags weeks behind.
- qjs: GitHub `https://github.com/quickjs-ng/quickjs/blob/{rev}/{path}#L{line}`.

## Driver (`build.mjs`)

`node scripts/impl-links/build.mjs [--root <engine>=<dir>]…`

1. For each engine in `config.mjs`: resolve checkout dir (default ghq path,
   overridable via `--root` for CI), `git rev-parse HEAD` +
   `git describe --tags --exact-match` for meta.
2. Dynamically import `extract/<engine>.mjs` if present (missing extractors are
   skipped with a notice, so integration is incremental).
3. Map record names through `spec-names.mjs`; join into `clauses`.
4. Write `impl-links.json`; print per-engine stats: records extracted, clauses
   matched, unmatched names (full list with `--verbose`, else first 20).

## Per-engine extraction strategy

- **QuickJS** — single file `quickjs.c`. Parse
  `static const JSCFunctionListEntry <table>[] = { … }` blocks; entries are
  `JS_CFUNC_DEF("map", 1, js_array_map)`, `JS_CFUNC_MAGIC_DEF`,
  `JS_CGETSET_DEF`, `JS_CGETSET_MAGIC_DEF`, `JS_ALIAS_DEF`, etc.
  Table name → receiver via a hardcoded map (`js_array_proto_funcs` →
  `Array.prototype`, …) — warn on unmapped tables. Links: the DEF line
  (label `entry`) + the C function definition line (label `impl (C)`),
  found via `^static JSValue <fn>(` search.
- **V8** — scan `src/init/bootstrapper.cc` for install calls that pair a JS
  name string with `Builtin::k<Name>` (entry link). Decode `k<Name>`
  (`ArrayPrototypeMap` → `Array.prototype.map`) — validation against the spec
  name map catches bad decodes. Impl links: search `src/builtins/**/*.tq` for
  `builtin <Name>(`/`javascript builtin <Name>`, `src/builtins/builtins-*.cc`
  for `BUILTIN(<Name>)`, CSA `TF_BUILTIN(<Name>,`; label by kind
  (`impl (Torque)`, `impl (C++)`, `impl (CSA)`).
- **SpiderMonkey** — scan `js/src/**/*.cpp` for `JSFunctionSpec`/
  `JSPropertySpec` tables: `JS_FN`, `JS_INLINABLE_FN`, `JS_SELF_HOSTED_FN`,
  `JS_SYM_FN`, `JS_SELF_HOSTED_SYM_FN`, `JS_PSG`, `JS_SELF_HOSTED_GET`.
  Table variable → receiver via hardcoded map (warn on unmapped).
  Impl links: C++ function definition in the same file; self-hosted names in
  `js/src/builtin/**/*.js` via `function <SelfHostedName>(`.
- **JSC** — `Source/JavaScriptCore/`. Sources: (a) LUT comment tables
  (`@begin <table> … @end`) in `runtime/*.cpp` mapping property names to host
  functions or `JSBuiltin`; (b) `JSC_DEFINE_HOST_FUNCTION(<prefix><Name>, …)`
  definitions with prefix → receiver map (`arrayProtoFunc` → `Array.prototype`);
  (c) self-hosted builtins `builtins/<Receiver>.js` (file name → receiver,
  top-level `function <name>(`; skip `@`-private names).

Coverage philosophy: convention-driven, validated against the spec name map;
misses are logged, not fatal. v1 targets methods + accessors; bare
constructors, `length`/data properties, and Annex B are out of scope.

## Widget (`js/implLinks.js`)

Same idioms as `versionCompare.js` (plain script, `'use strict'`, wired via
`jsDependencies` in `src/Spec.ts`).

- On DOMContentLoaded: `fetch(window.implLinksDataUrl || 'impl-links.json')`;
  any failure (including `file://`) → silent no-op.
- For each `clauses` key with a matching `emu-clause[id]`/`emu-annex[id]` in
  the document: append an `impl` button to the clause's direct-child `h1`.
- Click toggles a panel (one open at a time; outside click closes): one row
  per engine in fixed order — engine label + `<a target="_blank"
  rel="noopener">` per link, text from `t`, URL from
  `meta.engines[k].templates[tpl].replace('{path}', p).replace('{line}', l)`
  (with URL-encoding of the path).
- CSS appended to `css/elements.css`, mirroring `.version-compare-*` styles.

## CI refresh (`.github/workflows/update-impl-links.yml`)

Weekly cron + manual dispatch: `resolve-tag.mjs` picks the latest release tag
per engine via `git ls-remote --tags` (patterns from `config.mjs`); if any tag
differs from `impl-links.json` meta, `ci-checkout.mjs` makes blobless clones
at those tags (sparse-checkout limited to each engine's `sparsePaths`), the
workflow reruns `build.mjs --root …` and opens a PR with the regenerated JSON.

## Verification

- Driver stats: expect a few hundred matched clauses per engine.
- Sample link check: fetch a handful of generated URLs and confirm the target
  line contains the expected symbol (GitHub raw / Searchfox HTML).
- `npm run build && npm run lint && npm run update-baselines` must pass.
