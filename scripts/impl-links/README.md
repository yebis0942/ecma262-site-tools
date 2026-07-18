# impl-links data build

Generates `impl-links.json` (repo root), mapping spec clause ids
(e.g. `sec-array.prototype.map`) to implementation permalinks in four JS
engines (V8, JavaScriptCore, SpiderMonkey, QuickJS). The `js/implLinks.js`
widget loads this file at runtime. See [DESIGN.md](./DESIGN.md) for the full
design.

## Setup

Clone the engine checkouts and tc39/ecma262 via [ghq](https://github.com/x-motemen/ghq)
and pin each engine to its latest release tag (detached HEAD):

```sh
ghq get --shallow https://github.com/tc39/ecma262   # spec.html (main HEAD)
ghq get --shallow https://github.com/v8/v8
ghq get --shallow https://github.com/WebKit/WebKit
ghq get --shallow https://github.com/mozilla-firefox/firefox
ghq get --shallow https://github.com/quickjs-ng/quickjs
```

Then, per engine, fetch and check out the latest release tag (a shallow clone
has no tags, so fetch the tag explicitly; `resolve-tag.mjs` picks it):

```sh
TAG=$(node scripts/impl-links/resolve-tag.mjs v8 | cut -d' ' -f2)
d="$(ghq root)/github.com/v8/v8"
git -C "$d" fetch --depth 1 origin "+refs/tags/${TAG}:refs/tags/${TAG}"
git -C "$d" checkout "refs/tags/${TAG}"
```

(Quote `${TAG}` with braces — in zsh, unbraced `$TAG:r` inside a string is
parsed as a modifier and mangles the refspec.)

Tag patterns per engine (used to pick the latest release) are in
[`config.mjs`](./config.mjs), along with the default checkout paths and URL
templates.

## Run

```sh
node scripts/impl-links/build.mjs [--root <engine>=<dir>]… [--only v8,qjs] [--verbose]
```

- `--root <engine>=<dir>` — override a checkout directory (engine keys:
  `v8`, `jsc`, `sm`, `qjs`; also `ecma262` for the spec checkout).
- `--only v8,qjs` — restrict to a subset of engines.
- `--verbose` — print all unmatched names/warnings instead of the first 20.
- `IMPL_LINKS_EXTRACT_DIR=<dir>` — use an alternate `extract/` directory
  (testing).

The driver resolves each checkout's `HEAD` rev and exact tag via git, runs
`extract/<engine>.mjs` (engines with no extractor are skipped), matches
extracted names to clause ids via `spec-names.mjs`, and writes
`impl-links.json`. Per-engine stats (records, matched clauses, unmatched
names) go to stdout.

## CI

`.github/workflows/update-impl-links.yml` (weekly cron + manual dispatch)
resolves the latest release tags via `resolve-tag.mjs`; when any tag differs
from the one recorded in `impl-links.json`, it makes blobless (sparse where
configured) clones at the new tags via `ci-checkout.mjs`, reruns
`build.mjs --root …`, and opens a PR with the regenerated JSON
([create-pull-request](https://github.com/peter-evans/create-pull-request)
requires "Allow GitHub Actions to create pull requests" in the repo settings).

## Serving the data

The widget fetches `impl-links.json` relative to the built spec page (override
with `window.implLinksDataUrl` before `DOMContentLoaded`). Copy the file next
to the generated HTML when publishing; when it is absent (or on `file://`),
the widget silently does nothing.
