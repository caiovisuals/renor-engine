import { describe, expect, it } from 'vitest';
import { PyRandom } from '../../scripts/eval/secret-guard/pythonRandom';

/**
 * PyRandom is CPython's `random.Random`, exactly (scripts/eval/secret-guard/pythonRandom.ts). The decision-layer
 * investigation generated its planted sets with Python's generator, and the sets are only the same sets if every
 * draw is the same, so this pins the port against values taken from Python 3.14.7 (the algorithm is the one Python
 * has used since 3.2: MT19937 seeded by `init_by_array`, `randbelow` by bit-length rejection, `shuffle` from the end).
 *
 * Each block is one seed and was produced by calling, on a fresh `random.Random(seed)`:
 *   random()  x4;   getrandbits(32) x6;   getrandbits(1, 7, 31, 32, 33, 53, 64);   getrandbits(128);
 *   randint(1000, 9999), randint(0, 9), randint(12, 18), randint(10**9, 10**10 - 1), randint(1, 254);
 *   choice('a..z'), choice([4, 6]), choice(range(40)), choice(['us', 'us2', 'uk', 'br', 'br2']);
 *   shuffle(range(20));   shuffle(range(1000)): its first ten, and the sum of index * value.
 * (Big integers are strings: a JSON number would round them.)
 */
const PYTHON: Record<string, {
  random: number[];
  u32: number[];
  bits: string[];
  bits128: string;
  randint: number[];
  choice: Array<string | number>;
  shuffle20: number[];
  shuffle1000_head: number[];
  shuffle1000_sum_i_x: number;
}> = {
  20261003: {
    random: [0.028164495600748074, 0.9217604846129798, 0.33883843507066314, 0.1434055107959067],
    u32: [120965577, 2619064220, 3958931158, 21187555, 1455299991, 3926716482],
    bits: ["0", "78", "1979465579", "21187555", "5750267287", "7581412462311735", "5320848665176116818"],
    bits128: "1678651123849303825611167798597634505",
    randint: [1461, 9, 12, 7432951890, 135],
    choice: ["a", 4, 21, "us2"],
    shuffle20: [12, 2, 17, 11, 3, 5, 7, 18, 14, 13, 6, 9, 1, 8, 16, 15, 4, 10, 19, 0],
    shuffle1000_head: [374, 141, 449, 203, 377, 153, 345, 894, 179, 44],
    shuffle1000_sum_i_x: 243105008,
  },
  20261004: {
    random: [0.17460787336641603, 0.7545720882920675, 0.3928502073468587, 0.5231492086553403],
    u32: [749935133, 232581420, 3240862439, 1300416022, 1687278798, 1178643360],
    bits: ["0", "6", "1620431219", "1300416022", "1687278798", "1717834546486086", "13710763633731943340"],
    bits128: "103029571986952508141191539599240010269",
    randint: [3860, 0, 18, 6595383318, 71],
    choice: ["f", 4, 19, "br"],
    shuffle20: [6, 19, 0, 18, 14, 4, 13, 17, 7, 2, 10, 16, 11, 3, 15, 8, 12, 9, 1, 5],
    shuffle1000_head: [932, 743, 750, 965, 156, 960, 237, 47, 228, 126],
    shuffle1000_sum_i_x: 249877349,
  },
  77: {
    random: [0.799115369116727, 0.3259061440625364, 0.24049351508267347, 0.8225558693681814],
    u32: [3432174397, 1085460482, 1399756255, 847458566, 1032911788, 829487794],
    bits: ["1", "32", "699878127", "847458566", "1032911788", "8463726215890282", "5392444535701028124"],
    bits128: "67142585016974355488185790212185707325",
    randint: [5140, 5, 13, 2032911788, 211],
    choice: ["z", 6, 20, "us2"],
    shuffle20: [11, 18, 14, 0, 15, 5, 12, 2, 3, 9, 19, 16, 4, 1, 13, 17, 7, 6, 10, 8],
    shuffle1000_head: [902, 841, 405, 756, 354, 835, 862, 91, 744, 535],
    shuffle1000_sum_i_x: 248590672,
  },
  20261002: {
    random: [0.16098361967034136, 0.1415197764541205, 0.9150214757124355, 0.3704611465770826],
    u32: [691419376, 2909279115, 607822801, 3705439894, 3929987320, 2324995878],
    bits: ["0", "86", "303911400", "3705439894", "8224954616", "3655581400730292", "6516801482351400569"],
    bits128: "293575194119882772245309259195612543216",
    randint: [3637, 2, 18, 6886085812, 180],
    choice: ["f", 4, 34, "uk"],
    shuffle20: [3, 15, 0, 2, 6, 9, 8, 14, 18, 13, 7, 10, 1, 19, 16, 12, 11, 17, 4, 5],
    shuffle1000_head: [226, 756, 466, 216, 250, 24, 73, 774, 858, 408],
    shuffle1000_sum_i_x: 249684910,
  },
  0: {
    random: [0.8444218515250481, 0.7579544029403025, 0.420571580830845, 0.25891675029296335],
    u32: [3626764237, 1654615998, 3255389356, 3823568514, 1806341205, 173879092],
    bits: ["1", "49", "1627694678", "3823568514", "1806341205", "8696133065399866", "8963783824838420066"],
    bits128: "302934307671667531413257853548643485645",
    randint: [7311, 6, 12, 7490875490, 104],
    choice: ["m", 6, 2, "uk"],
    shuffle20: [10, 18, 16, 14, 0, 17, 11, 2, 3, 9, 5, 7, 4, 19, 6, 15, 8, 1, 13, 12],
    shuffle1000_head: [439, 621, 160, 549, 237, 389, 658, 507, 124, 290],
    shuffle1000_sum_i_x: 251292570,
  },
  1: {
    random: [0.13436424411240122, 0.8474337369372327, 0.763774618976614, 0.2550690257394217],
    u32: [577090037, 2444712010, 3639700191, 3445702192, 3280387012, 271041745],
    bits: ["0", "72", "1819850095", "3445702192", "3280387012", "1062116443042876", "14037279428536751483"],
    bits128: "272996653310673477252411125948039410165",
    randint: [3201, 9, 18, 5566009041, 31],
    choice: ["e", 4, 16, "us"],
    shuffle20: [11, 5, 17, 19, 9, 0, 16, 1, 15, 6, 10, 13, 14, 12, 7, 3, 8, 2, 18, 4],
    shuffle1000_head: [852, 836, 280, 575, 208, 609, 932, 725, 47, 985],
    shuffle1000_sum_i_x: 249757595,
  },
};

describe('PyRandom against Python 3.14', () => {
  for (const [seed, want] of Object.entries(PYTHON)) {
    describe(`seed ${seed}`, () => {
      const fresh = () => new PyRandom(Number(seed));

      it('gives the same floats and 32-bit words', () => {
        const a = fresh();
        expect([a.random(), a.random(), a.random(), a.random()]).toEqual(want.random);
        const b = fresh();
        expect(Array.from({ length: 6 }, () => b.u32())).toEqual(want.u32);
      });

      it('gives the same bits, for every width from 1 to 128', () => {
        const a = fresh();
        expect([a.bits(1), a.bits(7), a.bits(31), a.bits(32), a.bits(33), a.bits(53), a.bitsBig(64)].map(String)).toEqual(want.bits);
        expect(fresh().bitsBig(128).toString()).toBe(want.bits128);
      });

      it('gives the same integers and choices', () => {
        const a = fresh();
        expect([a.randint(1000, 9999), a.randint(0, 9), a.randint(12, 18), a.randint(10 ** 9, 10 ** 10 - 1), a.randint(1, 254)]).toEqual(want.randint);
        const b = fresh();
        const indexes = Array.from({ length: 40 }, (_, i) => i);
        expect([b.choice('abcdefghijklmnopqrstuvwxyz'), b.choice([4, 6]), b.choice(indexes), b.choice(['us', 'us2', 'uk', 'br', 'br2'])]).toEqual(want.choice);
      });

      it('shuffles the same way', () => {
        const small = Array.from({ length: 20 }, (_, i) => i);
        fresh().shuffle(small);
        expect(small).toEqual(want.shuffle20);
        const big = Array.from({ length: 1000 }, (_, i) => i);
        fresh().shuffle(big);
        expect(big.slice(0, 10)).toEqual(want.shuffle1000_head);
        expect(big.reduce((sum, x, i) => sum + i * x, 0)).toBe(want.shuffle1000_sum_i_x);
      });
    });
  }

  it('is a pure function of the seed', () => {
    const a = new PyRandom(20261003);
    const b = new PyRandom(20261003);
    expect(Array.from({ length: 50 }, () => a.u32())).toEqual(Array.from({ length: 50 }, () => b.u32()));
    expect(new PyRandom(1).u32()).not.toBe(new PyRandom(2).u32());
  });

  it('refuses a seed it cannot reproduce', () => {
    for (const bad of [-1, 1.5, Number.NaN, 2 ** 53]) expect(() => new PyRandom(bad)).toThrow(/non-negative integer seed/);
  });

  it('keeps `below` inside its range and does not skip values', () => {
    const r = new PyRandom(5);
    const seen = new Set<number>();
    for (let i = 0; i < 2000; i++) {
      const x = r.below(7);
      expect(x).toBeGreaterThanOrEqual(0);
      expect(x).toBeLessThan(7);
      seen.add(x);
    }
    expect(seen.size).toBe(7);
    expect(() => r.below(0)).toThrow();
    expect(() => r.choice([])).toThrow();
  });
});
