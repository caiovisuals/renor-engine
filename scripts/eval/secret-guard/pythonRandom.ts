/**
 * CPython's `random.Random`, exactly: the Mersenne Twister (MT19937), its seeding from an integer
 * (`init_by_array`), and the methods the decision-layer investigation's generators used (`random`,
 * `getrandbits`, `randint`, `choice`, `shuffle`). Given the same integer seed it returns the same stream
 * as Python 3 does, bit for bit, so a generator written for Python's `random` can be rerun here and
 * produce the same sets (tests/eval/secret-guard-pythonrandom.test.ts pins it against vectors taken from
 * Python 3.14).
 *
 * Only what the generators need: non-negative integer seeds, `randbelow` by `getrandbits` rejection (what
 * CPython uses since 3.2), and `shuffle` as Fisher-Yates from the end.
 */

const N = 624;
const M = 397;

export class PyRandom {
  private readonly mt = new Uint32Array(N);
  private index = N;

  constructor(seed: number) {
    if (!Number.isSafeInteger(seed) || seed < 0) throw new Error('PyRandom takes a non-negative integer seed');
    // CPython hands the absolute value to init_by_array as little-endian 32-bit words (one word for 0).
    const key: number[] = [];
    let n = seed;
    do {
      key.push(n % 4294967296);
      n = Math.floor(n / 4294967296);
    } while (n > 0);
    this.initByArray(key);
  }

  private initGenrand(s: number): void {
    const mt = this.mt;
    mt[0] = s >>> 0;
    for (let i = 1; i < N; i++) {
      const prev = mt[i - 1] ^ (mt[i - 1] >>> 30);
      mt[i] = (Math.imul(1812433253, prev) + i) >>> 0;
    }
  }

  private initByArray(key: number[]): void {
    this.initGenrand(19650218);
    const mt = this.mt;
    let i = 1;
    let j = 0;
    for (let k = Math.max(N, key.length); k > 0; k--) {
      const prev = mt[i - 1] ^ (mt[i - 1] >>> 30);
      mt[i] = ((mt[i] ^ Math.imul(prev, 1664525)) + key[j] + j) >>> 0;
      i++;
      j++;
      if (i >= N) {
        mt[0] = mt[N - 1];
        i = 1;
      }
      if (j >= key.length) j = 0;
    }
    for (let k = N - 1; k > 0; k--) {
      const prev = mt[i - 1] ^ (mt[i - 1] >>> 30);
      mt[i] = ((mt[i] ^ Math.imul(prev, 1566083941)) - i) >>> 0;
      i++;
      if (i >= N) {
        mt[0] = mt[N - 1];
        i = 1;
      }
    }
    mt[0] = 0x80000000;
    this.index = N;
  }

  private twist(): void {
    const mt = this.mt;
    for (let k = 0; k < N; k++) {
      const y = (mt[k] & 0x80000000) | (mt[(k + 1) % N] & 0x7fffffff);
      mt[k] = mt[(k + M) % N] ^ (y >>> 1) ^ (y & 1 ? 0x9908b0df : 0);
    }
    this.index = 0;
  }

  /** The next 32 random bits (`genrand_uint32`). */
  u32(): number {
    if (this.index >= N) this.twist();
    let y = this.mt[this.index++];
    y ^= y >>> 11;
    y ^= (y << 7) & 0x9d2c5680;
    y ^= (y << 15) & 0xefc60000;
    y ^= y >>> 18;
    return y >>> 0;
  }

  /** `random.random()`: 53 random bits as a float in [0, 1). */
  random(): number {
    const a = this.u32() >>> 5;
    const b = this.u32() >>> 6;
    return (a * 67108864 + b) / 9007199254740992;
  }

  /** `random.getrandbits(k)` for any k, as a bigint: words are taken least significant first. */
  bitsBig(k: number): bigint {
    let value = 0n;
    let shift = 0n;
    for (let remaining = k; remaining > 0; remaining -= 32) {
      let word = this.u32();
      if (remaining < 32) word >>>= 32 - remaining;
      value |= BigInt(word) << shift;
      shift += 32n;
    }
    return value;
  }

  /** `random.getrandbits(k)` for k up to 53, as a number. */
  bits(k: number): number {
    if (k < 0 || k > 53) throw new Error('bits() takes 0 to 53 bits; use bitsBig');
    if (k === 0) return 0;
    return Number(this.bitsBig(k));
  }

  /** `random._randbelow(n)`: an integer in [0, n), by drawing the bit length of n until the draw is below n. */
  below(n: number): number {
    if (!(n > 0)) throw new Error('below() needs n > 0');
    const k = n < 4294967296 ? 32 - Math.clz32(n) : n.toString(2).length;
    let r = this.bits(k);
    while (r >= n) r = this.bits(k);
    return r;
  }

  /** `random.randint(a, b)`, both ends included. */
  randint(a: number, b: number): number {
    return a + this.below(b - a + 1);
  }

  /** `random.choice(seq)`. */
  choice<T>(seq: ArrayLike<T>): T {
    if (seq.length === 0) throw new Error('choice() of an empty sequence');
    return seq[this.below(seq.length)];
  }

  /** `random.shuffle(x)`, in place. */
  shuffle<T>(x: T[]): void {
    for (let i = x.length - 1; i >= 1; i--) {
      const j = this.below(i + 1);
      [x[i], x[j]] = [x[j], x[i]];
    }
  }
}
