// Pure integer time math. Ticks are project time; ms are output time.
export const gcd = (a, b) => { a = Math.abs(a); b = Math.abs(b); while (b) [a, b] = [b, a % b]; return a; };
export const lcm = (a, b) => a / gcd(a, b) * b;
export function reduceFrac(n, d) { const g = gcd(n, d) || 1; return [n / g, d / g]; }

export const tickRateFor = fps => lcm(1000, fps[0]);
// Ticks per grid frame. Integer whenever tickRate is a multiple of fps[0].
export const frameTicks = (tickRate, fps) => tickRate * fps[1] / fps[0];
export function snapTick(tick, tickRate, fps) {
  const f = frameTicks(tickRate, fps);
  return Math.round(tick / f) * f;
}

// Round-half-up division of non-negative BigInts.
const divRound = (n, d) => (2n * n + d) / (2n * d);

// Absolute project tick -> output ms, with dilation [num,den] (duration multiplier),
// rounded to a multiple of quantumMs (1 for WebP, 10 for GIF).
export function ticksToMs(ticks, tickRate, dilation = [1, 1], quantumMs = 1) {
  if (!(ticks >= 0)) throw new RangeError('ticks must be >= 0');
  const num = BigInt(ticks) * 1000n * BigInt(dilation[0]);
  const den = BigInt(tickRate) * BigInt(dilation[1]) * BigInt(quantumMs);
  return Number(divRound(num, den)) * quantumMs;
}

// Output ms -> project tick (floor). Used by playback/scrubbing.
export function msToTicks(ms, tickRate, dilation = [1, 1]) {
  const num = BigInt(Math.round(ms)) * BigInt(tickRate) * BigInt(dilation[1]);
  const den = 1000n * BigInt(dilation[0]);
  return Number(num / den);
}

// Source delay (µs) -> ticks, at least 1.
export function sourceUsToTicks(us, tickRate) {
  const v = Number(divRound(BigInt(Math.round(us)) * BigInt(tickRate), 1000000n));
  return Math.max(1, v);
}

// Most common delay (rounded to ms) -> fps as reduced rational. Ties: first seen wins.
export function guessFps(durationsUs, fallback = [30, 1]) {
  const counts = new Map();
  for (const us of durationsUs) {
    const ms = Math.round(us / 1000);
    if (ms > 0) counts.set(ms, (counts.get(ms) || 0) + 1);
  }
  let best = null, bestN = 0;
  for (const [ms, n] of counts) if (n > bestN) { best = ms; bestN = n; }
  return best === null ? fallback : reduceFrac(1000, best);
}
