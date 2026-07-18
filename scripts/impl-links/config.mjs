// Engine registry for the impl-links data build. See DESIGN.md.
//
// `ghqPath` values assume `$(ghq root)` = /home/w/.ghq/src; override with
// `--root <engine>=<dir>` (see build.mjs) in other environments/CI.
//
// `templates` are URL templates with `{rev}`, `{path}` and `{line}`
// placeholders; the driver substitutes `{rev}` when writing impl-links.json.
// Values marked 'TODO' are placeholders pending live verification.

const GHQ_ROOT = '/home/w/.ghq/src';

/** Path to the tc39/ecma262 source spec.html used for name → clause-id matching. */
export const SPEC_HTML_PATH = `${GHQ_ROOT}/github.com/tc39/ecma262/spec.html`;

/** Fixed engine display/processing order. */
export const ENGINE_ORDER = ['v8', 'jsc', 'sm', 'qjs'];

export const engines = {
  v8: {
    label: 'V8',
    repo: 'v8/v8',
    ghqPath: `${GHQ_ROOT}/github.com/v8/v8`,
    tagPattern: '^\\d+\\.\\d+\\.\\d+(\\.\\d+)?$',
    // Directories the extractor needs (used for sparse checkouts in CI).
    sparsePaths: ['src/init', 'src/builtins'],
    templates: {
      // Chromium Code Search (SPA; format follows the platform URL grammar,
      // but it is not machine-verifiable — see DESIGN.md).
      cs: 'https://source.chromium.org/chromium/v8/v8/+/{rev}:{path};l={line}',
      gh: 'https://github.com/v8/v8/blob/{rev}/{path}#L{line}',
    },
  },
  jsc: {
    label: 'JavaScriptCore',
    repo: 'WebKit/WebKit',
    ghqPath: `${GHQ_ROOT}/github.com/WebKit/WebKit`,
    tagPattern: '^webkitgtk-2\\.\\d*[02468]\\.\\d+$', // even minor = stable
    sparsePaths: ['Source/JavaScriptCore'],
    templates: {
      // Searchfox (wubkat) cannot render webkitgtk release-branch revs
      // (HTTP 500), so GitHub permalinks are used.
      gh: 'https://github.com/WebKit/WebKit/blob/{rev}/{path}#L{line}',
    },
  },
  sm: {
    label: 'SpiderMonkey',
    repo: 'mozilla-firefox/firefox',
    ghqPath: `${GHQ_ROOT}/github.com/mozilla-firefox/firefox`,
    tagPattern: '^FIREFOX_[0-9_]+_RELEASE$',
    sparsePaths: ['js/src'],
    templates: {
      // The mozilla-central Searchfox instance is retired, and
      // FIREFOX_*_RELEASE revs live on the release branch: use
      // firefox-release (firefox-main returns 500 for them; verified).
      sf: 'https://searchfox.org/firefox-release/rev/{rev}/{path}#{line}',
    },
  },
  qjs: {
    label: 'QuickJS',
    repo: 'quickjs-ng/quickjs',
    ghqPath: `${GHQ_ROOT}/github.com/quickjs-ng/quickjs`,
    tagPattern: '^v\\d+(\\.\\d+)*$',
    sparsePaths: [], // single-file engine; full checkout is cheap
    templates: {
      gh: 'https://github.com/quickjs-ng/quickjs/blob/{rev}/{path}#L{line}',
    },
  },
};
