// Seeded PRNG replacing Python's random.Random(seed).
// Same seed => reproducible next()/shuffle()/order. Uses mulberry32 (uint32 state).

export interface Rng {
  /** Float in [0, 1). */
  next(): number;
  /** Integer in [0, maxExclusive). */
  int(maxExclusive: number): number;
  /** In-place Fisher-Yates shuffle; returns the same array for chaining. */
  shuffle<T>(a: T[]): T[];
  /** Random element of a. */
  pick<T>(a: T[]): T;
}

/** Create a seeded RNG. mulberry32 on a 32-bit unsigned state. */
export function makeRng(seed: number): Rng {
  // Coerce the seed into a uint32.
  let state = seed >>> 0;

  function next(): number {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  function int(maxExclusive: number): number {
    return Math.floor(next() * maxExclusive);
  }

  function shuffle<T>(a: T[]): T[] {
    for (let i = a.length - 1; i > 0; i--) {
      const j = int(i + 1);
      const tmp = a[i]!;
      a[i] = a[j]!;
      a[j] = tmp;
    }
    return a;
  }

  function pick<T>(a: T[]): T {
    return a[int(a.length)]!;
  }

  return { next, int, shuffle, pick };
}
