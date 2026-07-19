'use strict';

// Shared diff core for the version bar, used from two very different hosts:
//   - the browser, as a classic `<script defer>` loaded just before
//     assets/versionBar.js (no module system available), and
//   - Node, via `require('../assets/versionBarCore.js')` from the generation
//     script and the unit tests.
// Hence the UMD-lite wrapper below: attach the API to the global for the
// browser and to module.exports when a CJS loader is present. Keep the syntax
// conservative (no modules, no class fields) — this file ships to browsers
// untranspiled.
(function (root) {
  /**
   * Diff two key sequences into an ordered list of block operations.
   *
   * diffSequences(aKeys, bKeys, { maxCells }) ->
   *   [{ type: 'same' | 'add' | 'del', ai, bi }]
   *
   * `ai` / `bi` are indices into aKeys / bKeys; the side an op does not touch
   * is -1 ('add' has ai === -1, 'del' has bi === -1). Ops are emitted in
   * output order (aKeys order for same/del, interleaved with bKeys adds), and
   * always cover both inputs completely.
   *
   * Algorithm: trim the common prefix and suffix (making the typical
   * "one step changed" case near O(n)), then run a classic LCS DP over the
   * remaining middle. The DP table is a flat Uint32Array of
   * (m + 1) * (n + 1) cells; if that would exceed `maxCells` (default
   * 4,000,000), fall back to a deterministic full replace of the middle
   * (all dels, then all adds) with a single console.warn.
   *
   * Backtracking tie-break: prefer 'add' when dp[i][j-1] >= dp[i-1][j].
   * Because ops are built back-to-front, this yields dels before adds in a
   * replaced run — the same output order as the reference computeDiff in the
   * tc39/ecmarkup claudedemo.html prototype.
   */
  function diffSequences(aKeys, bKeys, opts) {
    opts = opts || {};
    const maxCells = opts.maxCells == null ? 4000000 : opts.maxCells;
    const aLen = aKeys.length;
    const bLen = bKeys.length;

    // Trim the common prefix and suffix; only the middle needs the DP.
    let pre = 0;
    while (pre < aLen && pre < bLen && aKeys[pre] === bKeys[pre]) pre++;
    let suf = 0;
    while (
      suf < aLen - pre &&
      suf < bLen - pre &&
      aKeys[aLen - 1 - suf] === bKeys[bLen - 1 - suf]
    ) {
      suf++;
    }
    const m = aLen - pre - suf;
    const n = bLen - pre - suf;

    const ops = [];
    for (let k = 0; k < pre; k++) {
      ops.push({ type: 'same', ai: k, bi: k });
    }

    if ((m + 1) * (n + 1) > maxCells) {
      // Deterministic fallback: replace the whole middle (all dels, then all
      // adds). Correct, just not minimal — acceptable for pathological
      // sections, and cheap to reason about on the client.
      console.warn(
        'versionBarCore: diff of ' + m + 'x' + n + ' blocks exceeds maxCells=' +
          maxCells + '; falling back to full replace',
      );
      for (let i = 0; i < m; i++) {
        ops.push({ type: 'del', ai: pre + i, bi: -1 });
      }
      for (let j = 0; j < n; j++) {
        ops.push({ type: 'add', ai: -1, bi: pre + j });
      }
    } else if (m > 0 || n > 0) {
      // LCS DP over the middle, flat row-major table: dp[i * (n+1) + j].
      const width = n + 1;
      const dp = new Uint32Array((m + 1) * width);
      for (let i = 1; i <= m; i++) {
        for (let j = 1; j <= n; j++) {
          dp[i * width + j] =
            aKeys[pre + i - 1] === bKeys[pre + j - 1]
              ? dp[(i - 1) * width + (j - 1)] + 1
              : Math.max(dp[(i - 1) * width + j], dp[i * width + (j - 1)]);
        }
      }
      // Backtrack, collecting middle ops back-to-front.
      const middle = [];
      let i = m;
      let j = n;
      while (i > 0 || j > 0) {
        if (i > 0 && j > 0 && aKeys[pre + i - 1] === bKeys[pre + j - 1]) {
          middle.push({ type: 'same', ai: pre + i - 1, bi: pre + j - 1 });
          i--;
          j--;
        } else if (
          j > 0 &&
          (i === 0 || dp[i * width + (j - 1)] >= dp[(i - 1) * width + j])
        ) {
          middle.push({ type: 'add', ai: -1, bi: pre + j - 1 });
          j--;
        } else {
          middle.push({ type: 'del', ai: pre + i - 1, bi: -1 });
          i--;
        }
      }
      for (let k = middle.length - 1; k >= 0; k--) {
        ops.push(middle[k]);
      }
    }

    for (let k = 0; k < suf; k++) {
      ops.push({ type: 'same', ai: aLen - suf + k, bi: bLen - suf + k });
    }
    return ops;
  }

  const api = { diffSequences: diffSequences };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.versionBarCore = api;
})(typeof self !== 'undefined' ? self : globalThis);
