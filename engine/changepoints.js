// Change-point math: project -> list of output frames. Pure; no pixels involved.
import { tableStarts, frameIndexAt } from './frametable.js';
import { clipDuration, projectDuration } from './project.js';
import { canonical } from './canon.js';
import { ticksToMs } from './time.js';

// Every tick at which anything can change.
export function changePoints(project) {
  const pts = new Set([0]);
  for (const c of project.clips) {
    pts.add(c.start);
    if (c.kind === 'sequence') for (const s of tableStarts(c.frames)) pts.add(c.start + s);
    else pts.add(c.start + c.duration);
  }
  return [...pts].sort((a, b) => a - b);
}

const genKeys = new WeakMap();
function genKey(c) {
  let k = genKeys.get(c);
  if (!k) {
    const { id, start, duration, ...props } = c;
    k = 'G|' + canonical(props);
    genKeys.set(c, k);
  }
  return k;
}

// Identifies exactly what a clip contributes at tick t; null if not visible.
export function visualKey(c, t) {
  if (t < c.start || t >= c.start + clipDuration(c)) return null;
  if (c.kind === 'sequence') {
    const f = c.frames[frameIndexAt(c.frames, t - c.start)];
    return `S|${c.mediaHash}|${f.sourceFrame}|${c.x}|${c.y}|${c.alpha}`;
  }
  return genKey(c);
}

// Whole-frame key: visible clips in layer order. '' = blank frame.
export const frameKeyAt = (project, t) =>
  project.clips.map(c => visualKey(c, t)).filter(k => k !== null).join('\n');

// Maximal intervals [startTick, endTick) with constant key.
export function segments(project) {
  const pts = changePoints(project), out = [];
  for (let i = 0; i < pts.length - 1; i++) {
    const key = frameKeyAt(project, pts[i]), last = out[out.length - 1];
    if (last && last.key === key) last.endTick = pts[i + 1];
    else out.push({ startTick: pts[i], endTick: pts[i + 1], key });
  }
  return out;
}

// Output frames: quantize absolute boundaries once, drop zero-length, absorb too-short, merge equal.
// opts: {quantumMs (1 webp / 10 gif), minDelayMs}. Defaults from project.settings.output.
// Each frame: {tick (render at this project time), startMs, durationMs, key}.
export function planOutput(project, opts = {}) {
  const { tickRate, dilation } = project.settings;
  const quantumMs = opts.quantumMs ?? 1;
  const minDelayMs = opts.minDelayMs ?? project.settings.output.minDelayMs ?? 0;
  const toMs = t => ticksToMs(t, tickRate, dilation, quantumMs);

  const q = segments(project)
    .map(s => ({ tick: s.startTick, startMs: toMs(s.startTick), endMs: toMs(s.endTick), key: s.key }))
    .filter(f => f.endMs > f.startMs);
  if (!q.length) return { frames: [], totalMs: 0 };

  let kept = q;
  if (minDelayMs > 0) {
    kept = []; let carry = null;
    for (const f of q) {
      const g = { ...f };
      if (carry !== null) { g.startMs = carry; carry = null; }
      if (g.endMs - g.startMs < minDelayMs) {
        if (kept.length) kept[kept.length - 1].endMs = g.endMs; else carry = g.startMs;
      } else kept.push(g);
    }
    if (!kept.length) kept = [{ ...q[q.length - 1], startMs: q[0].startMs }];  // everything was short
  }

  const merged = [];
  for (const f of kept) {
    const last = merged[merged.length - 1];
    if (last && last.key === f.key) last.endMs = f.endMs; else merged.push({ ...f });
  }
  const frames = merged.map(f => ({ tick: f.tick, startMs: f.startMs, durationMs: f.endMs - f.startMs, key: f.key }));
  return { frames, totalMs: merged[merged.length - 1].endMs };
}
