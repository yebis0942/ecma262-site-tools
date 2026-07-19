// Unit tests for lib/section-blocks.mjs (splitSectionHtml / expandSkeleton).
import assert from 'node:assert';
import { splitSectionHtml, expandSkeleton } from '../lib/section-blocks.mjs';

// --- representative emu-clause body ----------------------------------------
// h1 and p are leaves; emu-alg > ol is a container chain, so each <li> is a
// leaf at top-level-step granularity.
{
  const html =
    '<h1><span class="secnum">1.1</span> Example ( <var>x</var> )</h1>' +
    '<p>The abstract operation takes argument <var>x</var>.</p>' +
    '<emu-alg><ol><li>Let <var>y</var> be <emu-val>1</emu-val>.</li>' +
    '<li>Return <var>y</var>.</li></ol></emu-alg>';
  const { skeleton, blocks, keys } = splitSectionHtml(html);

  assert.deepStrictEqual(blocks, [
    '<h1><span class="secnum">1.1</span> Example ( <var>x</var> )</h1>',
    '<p>The abstract operation takes argument <var>x</var>.</p>',
    '<li>Let <var>y</var> be <emu-val>1</emu-val>.</li>',
    '<li>Return <var>y</var>.</li>',
  ]);
  assert.strictEqual(
    skeleton,
    '<!--vb:0--><!--vb:1--><emu-alg><ol><!--vb:2--><!--vb:3--></ol></emu-alg>',
  );
  assert.deepStrictEqual(keys, [
    '1.1 Example ( x )',
    'The abstract operation takes argument x.',
    'Let y be 1.',
    'Return y.',
  ]);
  // Round-trip: the fixture is already in parse5-normalized form, so
  // expansion reproduces the input exactly.
  assert.strictEqual(expandSkeleton(skeleton, blocks), html);
}

// --- nested <li><ol>: one block at top-level-step granularity ---------------
{
  const html =
    '<emu-alg><ol><li>Outer step. <ol><li>Inner step.</li></ol></li>' +
    '<li>Second step.</li></ol></emu-alg>';
  const { skeleton, blocks, keys } = splitSectionHtml(html);
  // The first <li> has a non-whitespace text child, so the whole subtree
  // (including the nested <ol>) is a single leaf block.
  assert.deepStrictEqual(blocks, [
    '<li>Outer step. <ol><li>Inner step.</li></ol></li>',
    '<li>Second step.</li>',
  ]);
  assert.strictEqual(skeleton, '<emu-alg><ol><!--vb:0--><!--vb:1--></ol></emu-alg>');
  assert.deepStrictEqual(keys, ['Outer step. Inner step.', 'Second step.']);
  assert.strictEqual(expandSkeleton(skeleton, blocks), html);
}

// --- table rows are leaves (td/th are not block tags) -----------------------
{
  const html =
    '<emu-table><table><tbody><tr><th>Name</th><th>Value</th></tr>' +
    '<tr><td>alpha</td><td>1</td></tr></tbody></table></emu-table>';
  const { skeleton, blocks, keys } = splitSectionHtml(html);
  assert.deepStrictEqual(blocks, [
    '<tr><th>Name</th><th>Value</th></tr>',
    '<tr><td>alpha</td><td>1</td></tr>',
  ]);
  assert.strictEqual(
    skeleton,
    '<emu-table><table><tbody><!--vb:0--><!--vb:1--></tbody></table></emu-table>',
  );
  // Keys are the plain concatenation of text nodes (no separator injected
  // between cells), whitespace-collapsed.
  assert.deepStrictEqual(keys, ['NameValue', 'alpha1']);
  assert.strictEqual(expandSkeleton(skeleton, blocks), html);
}

// --- bare text and non-block elements at the fragment root ------------------
{
  const html = 'Loose text <span>inline note</span><p>A paragraph.</p> trailing';
  const { skeleton, blocks, keys } = splitSectionHtml(html);
  // Root text nodes stay in the skeleton; the non-block <span> and the <p>
  // each become leaves.
  assert.deepStrictEqual(blocks, ['<span>inline note</span>', '<p>A paragraph.</p>']);
  assert.strictEqual(skeleton, 'Loose text <!--vb:0--><!--vb:1--> trailing');
  assert.deepStrictEqual(keys, ['inline note', 'A paragraph.']);
  assert.strictEqual(expandSkeleton(skeleton, blocks), html);
}

// --- key fallback: empty text content falls back to collapsed HTML ---------
{
  const { blocks, keys } = splitSectionHtml('<p><br></p><p>real text</p>');
  assert.deepStrictEqual(blocks, ['<p><br></p>', '<p>real text</p>']);
  assert.deepStrictEqual(keys, ['<p><br></p>', 'real text']);
}

// --- keys collapse internal whitespace --------------------------------------
{
  const { keys } = splitSectionHtml('<p>  Multiple\n   spaces\t here  </p>');
  assert.deepStrictEqual(keys, ['Multiple spaces here']);
}

// --- ordinary comments are tolerated and preserved in the skeleton ----------
{
  const html = '<p>a</p><!-- an ordinary comment --><p>b</p>';
  const { skeleton, blocks } = splitSectionHtml(html);
  assert.strictEqual(skeleton, '<!--vb:0--><!-- an ordinary comment --><!--vb:1-->');
  assert.strictEqual(expandSkeleton(skeleton, blocks), html);
}

// --- marker-like comments in the input are detected (fail-loud) -------------
// The sanitizer strips all comments before this module runs; if a marker-like
// comment nevertheless survives into a skeleton position, the invariant check
// must throw rather than emit a corrupt skeleton.
{
  assert.throws(() => splitSectionHtml('<p>a</p><!--vb:0-->'), /marker/);
  assert.throws(() => splitSectionHtml('<!--vb:5--><p>a</p>'), /marker/);
}

// --- expandSkeleton validates the marker/block correspondence ---------------
{
  assert.throws(() => expandSkeleton('<!--vb:0--><!--vb:1-->', ['<p>a</p>']), /no matching block/);
  assert.throws(() => expandSkeleton('<div></div>', ['<p>a</p>']), /expanded 0 markers/);
}

console.log('section-blocks: all assertions passed');
