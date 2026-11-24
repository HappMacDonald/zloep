import test from 'node:test';
import assert from 'node:assert/strict';
import { canonical, deepEqual } from '../engine/canon.js';
import { tickRateFor, frameTicks, ticksToMs, msToTicks, guessFps, sourceUsToTicks } from '../engine/time.js';
import * as ft from '../engine/frametable.js';
import { createProject, sequenceClip, textClip, rectClip, addClip, setFps, validateProject, projectDuration } from '../engine/project.js';
import { planOutput } from '../engine/changepoints.js';

const still = (hash, n, dur, o = {}) => sequenceClip({
  mediaHash: hash, frames: Array.from({ length: n }, (_, i) => ({ sourceFrame: i, durationTicks: dur })), ...o });
function mk(fps = [25, 1], clips = []) {
  let p = createProject({ width: 100, height: 100, fps });
  p = { ...p, media: [{ sha256: 'aa', name: 'a.webp', size: 1, type: 'image/webp', dimensions: [100, 100], frameCount: 10 }] };
  for (const c of clips) p = addClip(p, c).project;
  return p;
}
const durs = plan => plan.frames.map(f => f.durationMs);

test('canonical ignores key order', () => {
  assert.equal(canonical({ b: 1, a: [2, { d: 1, c: 2 }] }), canonical({ a: [2, { c: 2, d: 1 }], b: 1 }));
  assert.ok(!deepEqual({ a: 1 }, { a: 2 }));
});

test('tick rates', () => {
  assert.equal(tickRateFor([30, 1]), 3000);
  assert.equal(tickRateFor([25, 1]), 1000);
  assert.equal(tickRateFor([30000, 1001]), 30000);
  assert.equal(frameTicks(30000, [30000, 1001]), 1001);
  assert.equal(frameTicks(3000, [24, 1]), 125);
});

test('ticksToMs / msToTicks', () => {
  assert.equal(ticksToMs(100, 3000), 33);
  assert.equal(ticksToMs(200, 3000), 67);
  assert.equal(ticksToMs(3000, 3000, [2, 1]), 2000);
  assert.equal(ticksToMs(45, 1000, [1, 1], 10), 50);
  assert.equal(ticksToMs(44, 1000, [1, 1], 10), 40);
  assert.equal(msToTicks(100, 3000), 300);
  assert.equal(msToTicks(200, 3000, [2, 1]), 300);
  assert.equal(sourceUsToTicks(40000, 1000), 40);
  assert.equal(sourceUsToTicks(1, 1000), 1);
});

test('guessFps', () => {
  assert.deepEqual(guessFps([40000, 40000, 40000, 30000]), [25, 1]);
  assert.deepEqual(guessFps([33000, 34000, 33000]), [1000, 33]);
  assert.deepEqual(guessFps([]), [30, 1]);
});

test('frame table lookup and edits', () => {
  const t = [0, 1, 2].map(i => ({ sourceFrame: i, durationTicks: 40 }));
  assert.equal(ft.tableDuration(t), 120);
  assert.deepEqual([0, 39, 40, 119, 120, -1].map(o => ft.frameIndexAt(t, o)), [0, 0, 1, 2, -1, -1]);
  assert.equal(ft.tableDuration(ft.duplicateFrame(t, 1)), 160);
  assert.deepEqual(ft.dropFrames(t, [0, 2]).map(f => f.sourceFrame), [1]);
  assert.equal(ft.setDelay(t, 1, 100)[1].durationTicks, 100);
  assert.equal(t[1].durationTicks, 40);                       // original untouched
  assert.deepEqual(ft.trimFrames(t, 1, 3).map(f => f.sourceFrame), [1, 2]);
  assert.throws(() => ft.dropFrames(t, [0, 1, 2]), RangeError);
  assert.throws(() => ft.trimFrames(t, 2, 2), RangeError);
  const fromSrc = ft.tableFromSource([40000, 80000], sourceUsToTicks, 1000);
  assert.deepEqual(fromSrc, [{ sourceFrame: 0, durationTicks: 40 }, { sourceFrame: 1, durationTicks: 80 }]);
});

test('project validation', () => {
  const ok = mk([25, 1], [still('aa', 3, 40), textClip({ duration: 40, text: 'x' }), rectClip({ duration: 40, width: 5, height: 5 })]);
  assert.deepEqual(validateProject(ok), { errors: [], warnings: [] });
  assert.equal(projectDuration(ok), 120);
  assert.ok(validateProject(mk([25, 1], [still('zz', 1, 40)])).errors.some(e => e.includes('unknown media')));
  assert.ok(validateProject(mk([25, 1], [still('aa', 1, 40, { start: 1.5 })])).errors.length > 0);
  const oor = validateProject(mk([25, 1], [sequenceClip({ mediaHash: 'aa', frames: [{ sourceFrame: 99, durationTicks: 40 }] })]));
  assert.equal(oor.errors.length, 0);
  assert.equal(oor.warnings.length, 1);
});

test('setFps scales exactly', () => {
  const p = mk([30, 1], [still('aa', 1, 100, { start: 100 })]);
  const q = setFps(p, [30000, 1001]);
  assert.equal(q.settings.tickRate, 30000);
  assert.equal(q.clips[0].start, 1000);
  assert.equal(q.clips[0].frames[0].durationTicks, 1000);
  assert.deepEqual(validateProject(q).errors, []);
  assert.equal(setFps(p, [25, 1]).settings.tickRate, 3000);
  assert.equal(p.clips[0].start, 100);                        // original untouched
});

test('plan: distinct frames', () => {
  assert.deepEqual(durs(planOutput(mk([25, 1], [still('aa', 3, 40)]))), [40, 40, 40]);
});

test('plan: identical holds merge', () => {
  const c = sequenceClip({ mediaHash: 'aa', frames: [{ sourceFrame: 0, durationTicks: 40 }, { sourceFrame: 0, durationTicks: 40 }, { sourceFrame: 1, durationTicks: 40 }] });
  assert.deepEqual(durs(planOutput(mk([25, 1], [c]))), [80, 40]);
});

test('plan: overlay splits a hold', () => {
  const p = mk([25, 1], [still('aa', 1, 200), textClip({ start: 50, duration: 50, text: 'hi' })]);
  const plan = planOutput(p);
  assert.deepEqual(durs(plan), [50, 50, 100]);
  assert.deepEqual(plan.frames.map(f => f.tick), [0, 50, 100]);
  assert.equal(plan.totalMs, 200);
});

test('plan: gap is a blank frame', () => {
  const plan = planOutput(mk([25, 1], [still('aa', 1, 40, { start: 40 })]));
  assert.deepEqual(durs(plan), [40, 40]);
  assert.equal(plan.frames[0].key, '');
});

test('plan: absolute-boundary rounding does not drift', () => {
  const plan = planOutput(mk([30, 1], [still('aa', 4, 100)]));
  assert.deepEqual(durs(plan), [33, 34, 33, 33]);             // boundaries 0,33,67,100,133
  assert.equal(plan.totalMs, 133);
});

test('plan: GIF quantum', () => {
  const plan = planOutput(mk([30, 1], [still('aa', 3, 100)]), { quantumMs: 10 });
  assert.deepEqual(durs(plan), [30, 40, 30]);
});

test('plan: zero-length frames dropped', () => {
  const p = mk([30, 1], [still('aa', 1, 100), rectClip({ start: 1, duration: 99, width: 5, height: 5 })]);
  const plan = planOutput(p);
  assert.equal(plan.frames.length, 1);
  assert.equal(plan.frames[0].tick, 1);
  assert.equal(plan.frames[0].durationMs, 33);
});

test('plan: min delay absorbs short frames', () => {
  const c = sequenceClip({ mediaHash: 'aa', frames: [{ sourceFrame: 0, durationTicks: 100 }, { sourceFrame: 1, durationTicks: 5 }, { sourceFrame: 2, durationTicks: 100 }] });
  const plan = planOutput(mk([25, 1], [c]), { minDelayMs: 10 });
  assert.deepEqual(durs(plan), [105, 100]);
  assert.deepEqual(plan.frames.map(f => f.tick), [0, 105]);
});

test('plan: dilation', () => {
  const base = mk([25, 1], [still('aa', 2, 40)]);
  assert.deepEqual(durs(planOutput({ ...base, settings: { ...base.settings, dilation: [2, 1] } })), [80, 80]);
  assert.deepEqual(durs(planOutput({ ...base, settings: { ...base.settings, dilation: [1, 2] } })), [20, 20]);
});

test('plan: empty project', () => {
  assert.deepEqual(planOutput(mk()), { frames: [], totalMs: 0 });
});
