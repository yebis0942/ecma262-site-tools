// Unit tests for assets/versionBarCore.js (diffSequences): loaded via CJS
// require, exactly as the generation script consumes it.
import assert from 'node:assert';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { diffSequences } = require('../assets/versionBarCore.js');

// Reference implementation copied from the claudedemo.html prototype
// (computeDiff), extended to track indices instead of texts. diffSequences
// must produce the same op order for these fixtures — in particular the
// backtracking tie-break: prefer 'add' when dp[i][j-1] >= dp[i-1][j], which
// (ops being built back-to-front) puts dels before adds in a replaced run.
function demoComputeDiff(a, b) {
  const m = a.length,
    n = b.length;
  const dp = Array.from({ length: m + 1 }, () => Array(n + 1).fill(0));
  for (let i = 1; i <= m; i++)
    for (let j = 1; j <= n; j++)
      dp[i][j] = a[i - 1] === b[j - 1] ? dp[i - 1][j - 1] + 1 : Math.max(dp[i - 1][j], dp[i][j - 1]);
  const r = [];
  let i = m,
    j = n;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && a[i - 1] === b[j - 1]) {
      r.unshift({ type: 'same', ai: i - 1, bi: j - 1 });
      i--;
      j--;
    } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
      r.unshift({ type: 'add', ai: -1, bi: j - 1 });
      j--;
    } else {
      r.unshift({ type: 'del', ai: i - 1, bi: -1 });
      i--;
    }
  }
  return r;
}

// Structural sanity of any ops list against its inputs: covers both sides
// completely and in order, with correct -1 sides.
function checkOps(ops, a, b) {
  let ai = 0,
    bi = 0;
  for (const op of ops) {
    if (op.type === 'same') {
      assert.strictEqual(op.ai, ai, 'same consumes a in order');
      assert.strictEqual(op.bi, bi, 'same consumes b in order');
      assert.strictEqual(a[op.ai], b[op.bi], 'same keys are equal');
      ai++;
      bi++;
    } else if (op.type === 'del') {
      assert.strictEqual(op.ai, ai, 'del consumes a in order');
      assert.strictEqual(op.bi, -1, 'del has bi === -1');
      ai++;
    } else if (op.type === 'add') {
      assert.strictEqual(op.ai, -1, 'add has ai === -1');
      assert.strictEqual(op.bi, bi, 'add consumes b in order');
      bi++;
    } else {
      assert.fail(`unknown op type ${op.type}`);
    }
  }
  assert.strictEqual(ai, a.length, 'ops cover all of a');
  assert.strictEqual(bi, b.length, 'ops cover all of b');
}

// --- identical sequences: all same -----------------------------------------
{
  const a = ['x', 'y', 'z'];
  const ops = diffSequences(a, ['x', 'y', 'z']);
  assert.deepStrictEqual(ops, [
    { type: 'same', ai: 0, bi: 0 },
    { type: 'same', ai: 1, bi: 1 },
    { type: 'same', ai: 2, bi: 2 },
  ]);
}

// --- full replacement: all dels, then all adds -----------------------------
{
  const a = ['x', 'y'];
  const b = ['p', 'q'];
  const ops = diffSequences(a, b);
  checkOps(ops, a, b);
  assert.deepStrictEqual(
    ops.map(o => o.type),
    ['del', 'del', 'add', 'add'],
  );
  assert.deepStrictEqual(ops, demoComputeDiff(a, b));
}

// --- common prefix/suffix with a change in the middle ----------------------
{
  const a = ['head', 'x', 'tail'];
  const b = ['head', 'y', 'tail'];
  const ops = diffSequences(a, b);
  checkOps(ops, a, b);
  // del before add in the replaced run (tie-break), same/suffix preserved.
  assert.deepStrictEqual(ops, [
    { type: 'same', ai: 0, bi: 0 },
    { type: 'del', ai: 1, bi: -1 },
    { type: 'add', ai: -1, bi: 1 },
    { type: 'same', ai: 2, bi: 2 },
  ]);
  assert.deepStrictEqual(ops, demoComputeDiff(a, b));
}

// --- empty vs non-empty ----------------------------------------------------
{
  assert.deepStrictEqual(diffSequences([], ['a', 'b']), [
    { type: 'add', ai: -1, bi: 0 },
    { type: 'add', ai: -1, bi: 1 },
  ]);
  assert.deepStrictEqual(diffSequences(['a', 'b'], []), [
    { type: 'del', ai: 0, bi: -1 },
    { type: 'del', ai: 1, bi: -1 },
  ]);
  assert.deepStrictEqual(diffSequences([], []), []);
}

// --- maxCells: forced deterministic full-replace fallback ------------------
{
  const a = ['x', 'k', 'z'];
  const b = ['q', 'k', 'w'];
  // A real LCS diff keeps 'k' as same; the fallback must not.
  const real = diffSequences(a, b);
  assert.deepStrictEqual(
    real.map(o => o.type),
    ['del', 'add', 'same', 'del', 'add'],
  );
  assert.deepStrictEqual(real, demoComputeDiff(a, b));

  // Force the fallback and assert it warns exactly once.
  const originalWarn = console.warn;
  const warnings = [];
  console.warn = (...args) => warnings.push(args.join(' '));
  let ops;
  try {
    ops = diffSequences(a, b, { maxCells: 1 });
  } finally {
    console.warn = originalWarn;
  }
  assert.strictEqual(warnings.length, 1, 'fallback warns exactly once');
  assert.ok(warnings[0].includes('maxCells'), 'warning mentions maxCells');
  checkOps(ops, a, b);
  assert.deepStrictEqual(
    ops.map(o => o.type),
    ['del', 'del', 'del', 'add', 'add', 'add'],
  );
}

// --- fallback still trims the common prefix/suffix -------------------------
{
  const a = ['head', 'x', 'k', 'z', 'tail'];
  const b = ['head', 'q', 'k', 'w', 'tail'];
  const originalWarn = console.warn;
  console.warn = () => {};
  let ops;
  try {
    ops = diffSequences(a, b, { maxCells: 1 });
  } finally {
    console.warn = originalWarn;
  }
  checkOps(ops, a, b);
  assert.deepStrictEqual(
    ops.map(o => o.type),
    ['same', 'del', 'del', 'del', 'add', 'add', 'add', 'same'],
  );
}

// --- tie-break parity with the demo computeDiff ----------------------------
// Fixed sequences where the dp[i][j-1] >= dp[i-1][j] "prefer add" rule
// determines the order (dels emitted before adds in ambiguous runs).
{
  const cases = [
    [['x'], ['y']],
    [['a', 'b'], ['c']],
    [['s', 'a', 'b', 't'], ['s', 'c', 't']],
    [
      ['a', 'b', 'c'],
      ['b', 'c', 'd'],
    ],
    [
      ['one', 'two', 'three', 'four'],
      ['zero', 'two', 'x', 'y', 'four'],
    ],
  ];
  for (const [a, b] of cases) {
    const ops = diffSequences(a, b);
    checkOps(ops, a, b);
    assert.deepStrictEqual(
      ops,
      demoComputeDiff(a, b),
      `tie-break parity for ${JSON.stringify(a)} vs ${JSON.stringify(b)}`,
    );
  }
}

console.log('diff-core: all assertions passed');
