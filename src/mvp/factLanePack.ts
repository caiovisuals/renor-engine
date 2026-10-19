/**
 * The fact lane's vectors laid out for one pass over them. Every call to `factLane` takes the dot product of the query with the
 * unit vector of each current fact; read from the per-provider store that is one lookup and one separate array per fact, packed
 * the vectors sit in a single row-major matrix in the order the lane compares them. A pack is a copy, so it is only as current as
 * the snapshot and the vectors it was made from: contextRelevance.ts says when it is made again.
 */

/** Current fact renderings in the order the lane compares them, newest id for each rendering. */
export interface FactSnapshot {
  pairs: Array<[string, number]>;
  truncated: boolean;
}

/**
 * Unit vectors copied in `pairs` order, only for renderings that have one. `matrix` is row-major and
 * present only when every copied vector has the same length: the dot then reads contiguous rows.
 */
export interface PackedLane {
  snapshot: FactSnapshot;
  epoch: number;
  dim: number;
  ids: number[];
  missing: string[];
  matrix: Float32Array | null;
}

/** Copy the stored unit vectors in snapshot order. No second normalize: the store already holds unit vectors. */
export function packLane(snapshot: FactSnapshot, vectors: ReadonlyMap<string, Float32Array>, epoch: number): PackedLane {
  const ids: number[] = [];
  const vecs: Float32Array[] = [];
  const missing: string[] = [];
  for (const [rendering, id] of snapshot.pairs) {
    const v = vectors.get(rendering);
    if (!v) missing.push(rendering);
    else { vecs.push(v); ids.push(id); }
  }
  const dim = vecs.length > 0 ? vecs[0].length : 0;
  const uniform = dim > 0 && vecs.every(v => v.length === dim);
  let matrix: Float32Array | null = null;
  if (uniform) {
    matrix = new Float32Array(vecs.length * dim);
    for (let i = 0; i < vecs.length; i++) matrix.set(vecs[i], i * dim);
  }
  return { snapshot, epoch, dim, ids, missing, matrix };
}

/**
 * Best dot of `q` against packed rows. Four rows at a time, but each row is still summed from dimension
 * 0 upward, so its cosine bits match `dot`. The first row wins a tie, including a NaN, as `dot`'s loop did.
 */
export function bestPacked(q: Float32Array, matrix: Float32Array, n: number, dim: number): { index: number; score: number } | null {
  if (n === 0) return null;
  let bestI = -1;
  let best = 0;
  const take = (score: number, index: number) => {
    if (bestI < 0 || score > best) { best = score; bestI = index; }
  };
  let i = 0;
  for (; i + 3 < n; i += 4) {
    let s0 = 0, s1 = 0, s2 = 0, s3 = 0;
    const o0 = i * dim;
    const o1 = o0 + dim;
    const o2 = o1 + dim;
    const o3 = o2 + dim;
    for (let d = 0; d < dim; d++) {
      const qd = q[d];
      s0 += qd * matrix[o0 + d];
      s1 += qd * matrix[o1 + d];
      s2 += qd * matrix[o2 + d];
      s3 += qd * matrix[o3 + d];
    }
    take(s0, i);
    take(s1, i + 1);
    take(s2, i + 2);
    take(s3, i + 3);
  }
  for (; i < n; i++) {
    let s = 0;
    const o = i * dim;
    for (let d = 0; d < dim; d++) s += q[d] * matrix[o + d];
    take(s, i);
  }
  return { index: bestI, score: best };
}
