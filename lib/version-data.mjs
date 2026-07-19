// Pure computation of per-version section data (blame chain + diff stats).
// No IO and no parsing here — inputs are the pre-split { skeleton, blocks,
// keys } structures from lib/section-blocks.mjs, and the diff implementation
// is injected (assets/versionBarCore.js in production) so this module can be
// unit-tested directly under Node.

/**
 * Compute the v2 per-section payloads and the manifest diff stats for one
 * section across the versions it is present in.
 *
 * @param orderedPresentKeys  Version keys this section is present in, in
 *                            config order (oldest -> newest).
 * @param splitByKey          Map<versionKey, { skeleton, blocks, keys }>.
 * @param versionIndexByKey   Map<versionKey, number> — global index into
 *                            manifest.versions.
 * @param firstVersionKey     The first version key of the whole config. A
 *                            section already present there gets stats [0, 0]
 *                            (most sections predate the config's first
 *                            edition, so "everything added" would be noise);
 *                            its blame still points at that version's index,
 *                            meaning "this version or earlier".
 * @param diffSequences       (aKeys, bKeys) -> [{ type, ai, bi }] — see
 *                            assets/versionBarCore.js.
 * @returns {{ perVersion: Object<string, { skeleton, blocks, keys, blame }>,
 *             stats: Object<string, [number, number]> }}
 *
 * stats[v] = [added, deleted] block counts vs the previous *present* version
 * (absence gaps are skipped, so a section that disappears and reappears is
 * compared against its last present content). A section first appearing at a
 * later version than firstVersionKey gets [blocks.length, 0] (all added).
 *
 * blame[i] = global version index that introduced blocks[i]: the diff chain
 * carries blame through 'same' ops and stamps the current version on 'add'.
 */
export function computeVersionData(
  orderedPresentKeys,
  splitByKey,
  versionIndexByKey,
  firstVersionKey,
  diffSequences,
) {
  const perVersion = {};
  const stats = {};
  let prevKey = null;

  for (const versionKey of orderedPresentKeys) {
    const split = splitByKey.get(versionKey);
    if (!split) {
      throw new Error(`computeVersionData: no split content for present version "${versionKey}"`);
    }
    if (split.blocks.length !== split.keys.length) {
      throw new Error(
        `computeVersionData: blocks/keys length mismatch for "${versionKey}" ` +
          `(${split.blocks.length} !== ${split.keys.length})`,
      );
    }
    const versionIndex = versionIndexByKey.get(versionKey);
    if (versionIndex == null) {
      throw new Error(`computeVersionData: unknown version key "${versionKey}"`);
    }

    let blame;
    if (prevKey === null) {
      // First present version: every block blames this version. Stats are
      // [0, 0] when the section already existed in the config's first
      // edition, and all-added when it first appears mid-history.
      blame = split.keys.map(() => versionIndex);
      stats[versionKey] =
        versionKey === firstVersionKey ? [0, 0] : [split.blocks.length, 0];
    } else {
      const prev = perVersion[prevKey];
      const ops = diffSequences(prev.keys, split.keys);
      blame = new Array(split.keys.length);
      let added = 0;
      let deleted = 0;
      for (const op of ops) {
        if (op.type === 'same') {
          blame[op.bi] = prev.blame[op.ai];
        } else if (op.type === 'add') {
          blame[op.bi] = versionIndex;
          added++;
        } else {
          deleted++;
        }
      }
      // Fail-loud: a well-formed diff covers every block of the b side.
      for (let i = 0; i < blame.length; i++) {
        if (blame[i] == null) {
          throw new Error(
            `computeVersionData: diff for "${versionKey}" left block ${i} without blame`,
          );
        }
      }
      stats[versionKey] = [added, deleted];
    }

    perVersion[versionKey] = {
      skeleton: split.skeleton,
      blocks: split.blocks,
      keys: split.keys,
      blame,
    };
    prevKey = versionKey;
  }

  return { perVersion, stats };
}
