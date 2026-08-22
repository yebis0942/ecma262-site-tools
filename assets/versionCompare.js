'use strict';

// Version compare — release-boundary data for the "open in ecma262-compare"
// action in the version bar.
//
// This used to be a widget of its own: a per-clause `compare` button opening a
// panel with a strip of edition cells and From/To endpoints. That panel was a
// second, less capable copy of the version bar's own range selection, so the
// UI moved into assets/versionBar.js and only the data lives here.
//
// Consequence: a build without --version-bar has no compare affordance at all.
// That is deliberate — the two features are one feature now.
//
// Release boundaries come from ecma262-section-history's releases.json, which
// derives them from `git merge-base <tag> main` — the point on main where each
// release branch forked. The list below is a baked-in fallback for when that
// fetch fails, using the same merge-base hashes. ES2016 is the exception: its
// release predates snapshot coverage, so it uses the actual release commit (on
// a side branch) and is never overridden.
//
// Exposes `self.versionCompareReleases`:
//   hashFor(label) -> commit hash | null   ('ES2020', or 'ES2020 (11th)')
//   compareUrl(fromLabel, toLabel, sectionId) -> url | null
//   subscribe(fn)                          // fn() after releases.json lands
//   applyReleases(releases)                // exposed for tests
//
// Loading releases.json is a browser-only side effect, so requiring this file
// from Node (tests) touches the network not at all.

(function () {
  const versionCompareReleasesUrl =
    'https://yebis0942.github.io/ecma262-section-history/releases.json';

  let definedVersions = [
    { label: 'ES2016', hash: 'b154ce84698377ab53fe88c889633263607f4423' },
    { label: 'ES2017', hash: 'c8a6acfb99a364a114ac0152e3a071539dc1ca1a' },
    { label: 'ES2018', hash: '59d73dc08ea371866c1d9d45843e6752f26a48e4' },
    { label: 'ES2019', hash: '362cb1074cb5cc51867d98b4c3304e75117724d3' },
    { label: 'ES2020', hash: '1b7ca8d5c87f2655acf976ae72efcbf75f48ca15' },
    { label: 'ES2021', hash: 'a53b61fbe9c42f2f0bda2267fb3f51d6ecd904d9' },
    { label: 'ES2022', hash: '9d440aefa584bcc0d76dd4de611eabcc4f687043' },
    { label: 'ES2023', hash: '1c5ca183844ab453f939f1ee6165747c8b1c64ee' },
    { label: 'ES2024', hash: '6ec325c22e9b3c47397c95c6b301491e76edb768' },
    { label: 'ES2025', hash: 'ab261035815e2dff8705a0fe9a5eb7660ecea78c' },
  ];

  const subscribers = [];

  // Accept both a bare year label ('ES2020') and a version-bar manifest label
  // ('ES2020 (11th)'), so callers can pass either through unchanged.
  function yearLabel(label) {
    const match = /ES\d{4}/.exec(String(label));
    return match ? match[0] : null;
  }

  function hashFor(label) {
    const year = yearLabel(label);
    if (!year) return null;
    const entry = definedVersions.find(v => v.label === year);
    return entry ? entry.hash : null;
  }

  function compareUrl(fromLabel, toLabel, sectionId) {
    const from = hashFor(fromLabel);
    const to = hashFor(toLabel);
    if (!from || !to) return null;
    return (
      'https://arai-a.github.io/ecma262-compare/?from=' +
      encodeURIComponent(from) +
      '&to=' +
      encodeURIComponent(to) +
      '&id=' +
      encodeURIComponent(sectionId)
    );
  }

  // Merge releases.json entries ([{ release: 'es2025', hash, seq }, ...],
  // oldest first): known labels get their hash updated, unknown releases
  // (e.g. a future ES2026) are appended. A malformed payload is ignored whole
  // rather than applied in part.
  function applyReleases(releases) {
    if (!Array.isArray(releases) || releases.length === 0) return;
    for (let i = 0; i < releases.length; i++) {
      const entry = releases[i];
      if (typeof entry.release !== 'string' || typeof entry.hash !== 'string') return;
    }
    const updated = definedVersions.map(v => {
      const match = releases.find(r => r.release === v.label.toLowerCase());
      return match ? { label: v.label, hash: match.hash } : v;
    });
    for (let i = 0; i < releases.length; i++) {
      const r = releases[i];
      if (!updated.some(v => v.label.toLowerCase() === r.release)) {
        updated.push({ label: r.release.toUpperCase(), hash: r.hash });
      }
    }
    definedVersions = updated;
    for (let i = 0; i < subscribers.length; i++) {
      try {
        subscribers[i]();
      } catch (e) {
        // A broken subscriber must not stop the others.
      }
    }
  }

  function load() {
    if (typeof fetch !== 'function') return;
    fetch(versionCompareReleasesUrl)
      .then(res => (res.ok ? res.json() : null))
      .then(releases => {
        if (releases) applyReleases(releases);
      })
      .catch(() => {
        // Network/CORS failures are fine; the baked-in list is used as-is.
      });
  }

  const api = {
    hashFor: hashFor,
    compareUrl: compareUrl,
    applyReleases: applyReleases,
    subscribe: fn => {
      if (typeof fn === 'function') subscribers.push(fn);
    },
  };

  if (typeof self !== 'undefined') self.versionCompareReleases = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;

  if (typeof document !== 'undefined') load();
})();
