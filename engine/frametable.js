// Frame table = [{sourceFrame, durationTicks}]. Treat as immutable; every edit returns a new array.
const cache = new WeakMap();

// starts[i] = offset of frame i; starts[n] = total duration.
export function tableStarts(table) {
  let s = cache.get(table);
  if (!s) {
    s = new Array(table.length + 1); s[0] = 0;
    for (let i = 0; i < table.length; i++) s[i + 1] = s[i] + table[i].durationTicks;
    Object.freeze(s); cache.set(table, s);
  }
  return s;
}
export const tableDuration = t => tableStarts(t)[t.length];

// Index of the frame showing at `offset` ticks from clip start, or -1 if outside.
export function frameIndexAt(table, offset) {
  const s = tableStarts(table);
  if (offset < 0 || offset >= s[table.length]) return -1;
  let lo = 0, hi = table.length - 1;
  while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (s[mid] <= offset) lo = mid; else hi = mid - 1; }
  return lo;
}

const check = (t, i) => {
  if (!Number.isInteger(i) || i < 0 || i >= t.length) throw new RangeError(`frame index ${i} out of range 0..${t.length - 1}`);
};

export function tableFromSource(durationsUs, sourceUsToTicks, tickRate) {
  return durationsUs.map((us, i) => ({ sourceFrame: i, durationTicks: sourceUsToTicks(us, tickRate) }));
}
export function setDelay(t, i, durationTicks) {
  check(t, i);
  if (!(Number.isInteger(durationTicks) && durationTicks > 0)) throw new RangeError('durationTicks must be a positive integer');
  return t.map((f, j) => j === i ? { ...f, durationTicks } : f);
}
export function dropFrames(t, indices) {
  indices.forEach(i => check(t, i));
  const set = new Set(indices);
  const out = t.filter((_, j) => !set.has(j));
  if (!out.length) throw new RangeError('cannot drop every frame');
  return out;
}
export function duplicateFrame(t, i, copies = 1) {
  check(t, i);
  const dup = Array.from({ length: copies }, () => ({ ...t[i] }));
  return [...t.slice(0, i + 1), ...dup, ...t.slice(i + 1)];
}
// Keep frames [from, to).
export function trimFrames(t, from, to) {
  if (!(Number.isInteger(from) && Number.isInteger(to) && from >= 0 && to <= t.length && from < to))
    throw new RangeError(`bad trim range ${from}..${to} for ${t.length} frames`);
  return t.slice(from, to);
}
