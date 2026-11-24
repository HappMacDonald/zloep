import test from 'node:test';
import assert from 'node:assert/strict';
import { createProject, sequenceClip, textClip, rectClip, validateProject } from '../engine/project.js';
import { planOutput } from '../engine/changepoints.js';
import { apply, run, CommandError } from '../engine/commands.js';

const ent = (sha, n) => ({ sha256: sha, name: sha + '.webp', size: 1, type: 'image/webp', dimensions: [100, 100], frameCount: n });
const still = (hash, n, dur, o = {}) => sequenceClip({
  mediaHash: hash, frames: Array.from({ length: n }, (_, i) => ({ sourceFrame: i, durationTicks: dur })), ...o });
function mk(fps = [25, 1], clips = []) {
  let p = createProject({ width: 100, height: 100, fps });
  p = { ...p, media: [ent('aa', 10)] };
  for (const c of clips) p = apply(p, { type: 'addClip', clip: c });
  return p;
}
const ids = p => p.clips.map(c => c.id);
const durs = p => planOutput(p).frames.map(f => f.durationMs);

test('addClip assigns ids and honors index', () => {
  const p0 = mk();
  const r = run(p0, { type: 'addClip', clip: still('aa', 1, 40) });
  assert.equal(r.result, 'c1');
  const p2 = apply(r.project, { type: 'addClip', clip: rectClip({ duration: 40, width: 5, height: 5 }), index: 0 });
  assert.deepEqual(ids(p2), ['c2', 'c1']);
  assert.equal(p0.clips.length, 0);                              // original untouched
});

test('addClip rejects invalid result', () => {
  assert.throws(() => apply(mk(), { type: 'addClip', clip: still('zz', 1, 40) }), CommandError);
  assert.throws(() => apply(mk(), { type: 'addClip', clip: still('aa', 1, 40), index: 5 }), CommandError);
});

test('patchClip', () => {
  const p = mk([25, 1], [still('aa', 1, 40)]);
  const q = apply(p, { type: 'patchClip', id: 'c1', patch: { x: 10, start: 40 } });
  assert.equal(q.clips[0].x, 10); assert.equal(q.clips[0].start, 40); assert.equal(p.clips[0].x, 0);
  for (const patch of [{ kind: 'rect' }, { id: 'zz' }, { alpha: 2 }, { start: 1.5 }])
    assert.throws(() => apply(p, { type: 'patchClip', id: 'c1', patch }), CommandError);
  assert.throws(() => apply(p, { type: 'patchClip', id: 'nope', patch: { x: 1 } }), CommandError);
});

test('replaceClip, removeClip, reorderClip', () => {
  const p = mk([25, 1], [still('aa', 1, 40), rectClip({ duration: 40, width: 5, height: 5 }), textClip({ duration: 40, text: 'a' })]);
  assert.deepEqual(ids(apply(p, { type: 'reorderClip', id: 'c3', toIndex: 0 })), ['c3', 'c1', 'c2']);
  assert.deepEqual(ids(apply(p, { type: 'removeClip', id: 'c1' })), ['c2', 'c3']);
  const q = apply(p, { type: 'replaceClip', id: 'c2', clip: rectClip({ duration: 80, width: 9, height: 9 }) });
  assert.equal(q.clips[1].id, 'c2'); assert.equal(q.clips[1].width, 9);
  assert.throws(() => apply(p, { type: 'replaceClip', id: 'c2', clip: textClip({ duration: 40 }) }), CommandError);
});

test('splitClip inside a long hold divides the entry', () => {
  const p = mk([25, 1], [still('aa', 1, 200)]);
  const r = run(p, { type: 'splitClip', id: 'c1', at: 50 });
  assert.deepEqual(r.result, { leftId: 'c1', rightId: 'c2' });
  const [l, rt] = r.project.clips;
  assert.deepEqual(l.frames, [{ sourceFrame: 0, durationTicks: 50 }]);
  assert.deepEqual(rt.frames, [{ sourceFrame: 0, durationTicks: 150 }]);
  assert.equal(rt.start, 50);
  assert.deepEqual(durs(r.project), durs(p));                    // output unchanged by a split
});

test('splitClip at a frame boundary, layer order preserved', () => {
  const p = mk([25, 1], [still('aa', 3, 40), rectClip({ duration: 40, width: 5, height: 5 })]);
  const q = apply(p, { type: 'splitClip', id: 'c1', at: 80 });
  assert.deepEqual(ids(q), ['c1', 'c3', 'c2']);
  assert.equal(q.clips[0].frames.length, 2);
  assert.deepEqual(q.clips[1].frames, [{ sourceFrame: 2, durationTicks: 40 }]);
  assert.equal(q.clips[1].start, 80);
  assert.deepEqual(durs(q), durs(p));
});

test('splitClip on a generated clip', () => {
  const p = mk([25, 1], [textClip({ start: 10, duration: 100, text: 'hi' })]);
  const q = apply(p, { type: 'splitClip', id: 'c1', at: 60 });
  assert.equal(q.clips[0].duration, 50);
  assert.equal(q.clips[1].start, 60); assert.equal(q.clips[1].duration, 50);
  assert.equal(q.clips[1].text, 'hi');
});

test('splitClip rejects points not strictly inside', () => {
  const p = mk([25, 1], [still('aa', 1, 100, { start: 20 })]);
  for (const at of [20, 120, 10, 500, 50.5])
    assert.throws(() => apply(p, { type: 'splitClip', id: 'c1', at }), CommandError);
});

test('setFrames', () => {
  const p = mk([25, 1], [still('aa', 2, 40), rectClip({ duration: 40, width: 5, height: 5 })]);
  const q = apply(p, { type: 'setFrames', id: 'c1', frames: [{ sourceFrame: 1, durationTicks: 10 }] });
  assert.deepEqual(q.clips[0].frames, [{ sourceFrame: 1, durationTicks: 10 }]);
  assert.throws(() => apply(p, { type: 'setFrames', id: 'c2', frames: [] }), CommandError);
  assert.throws(() => apply(p, { type: 'setFrames', id: 'c1', frames: [] }), CommandError);
});

test('batch is atomic and validated at the end', () => {
  const p = mk();
  const q = apply(p, { type: 'batch', commands: [
    { type: 'addMedia', entry: ent('bb', 3) },
    { type: 'addClip', clip: still('bb', 1, 40) },
  ] });
  assert.equal(q.media.length, 2); assert.equal(q.clips.length, 1);
  assert.throws(() => apply(p, { type: 'batch', commands: [
    { type: 'addClip', clip: still('aa', 1, 40) },
    { type: 'removeClip', id: 'nope' },
  ] }), CommandError);
  assert.equal(p.clips.length, 0);
});

test('addMedia is idempotent; removeMedia refuses referenced media', () => {
  const p = mk([25, 1], [still('aa', 1, 40)]);
  assert.equal(apply(p, { type: 'addMedia', entry: ent('aa', 10) }).media.length, 1);
  assert.throws(() => apply(p, { type: 'removeMedia', sha256: 'aa' }), CommandError);
  assert.equal(apply(mk(), { type: 'removeMedia', sha256: 'aa' }).media.length, 0);
});

test('rebindMedia: clamp vs flag', () => {
  const p = mk([25, 1], [sequenceClip({ mediaHash: 'aa', frames: [{ sourceFrame: 5, durationTicks: 40 }] })]);
  const clamp = apply(p, { type: 'rebindMedia', from: 'aa', entry: ent('bb', 3), outOfRange: 'clamp' });
  assert.equal(clamp.clips[0].mediaHash, 'bb');
  assert.equal(clamp.clips[0].frames[0].sourceFrame, 2);
  assert.deepEqual(clamp.media.map(m => m.sha256), ['bb']);
  assert.equal(validateProject(clamp).warnings.length, 0);
  const flag = apply(p, { type: 'rebindMedia', from: 'aa', entry: ent('bb', 3) });
  assert.equal(flag.clips[0].frames[0].sourceFrame, 5);
  assert.equal(validateProject(flag).warnings.length, 1);
  assert.throws(() => apply(p, { type: 'rebindMedia', from: 'aa', entry: ent('aa', 10) }), CommandError);
});

test('setSettings', () => {
  const p = mk();
  assert.deepEqual(apply(p, { type: 'setSettings', patch: { output: { loop: 3 } } }).settings.output, { loop: 3, minDelayMs: 0, keyframeInterval: 0 });
  assert.deepEqual(apply(p, { type: 'setSettings', patch: { dilation: [2, 1] } }).settings.dilation, [2, 1]);
  assert.deepEqual(apply(p, { type: 'setSettings', patch: { crop: { x: 10, y: 10, width: 50, height: 50 } } }).settings.crop, { x: 10, y: 10, width: 50, height: 50 });
  assert.throws(() => apply(p, { type: 'setSettings', patch: { tickRate: 5 } }), CommandError);
  assert.throws(() => apply(p, { type: 'setSettings', patch: { crop: { x: 90, y: 0, width: 50, height: 10 } } }), CommandError);
});

test('setFps command rescales clips', () => {
  const p = mk([30, 1], [still('aa', 1, 100, { start: 100 })]);
  const q = apply(p, { type: 'setFps', fps: [30000, 1001] });
  assert.equal(q.settings.tickRate, 30000);
  assert.equal(q.clips[0].start, 1000);
});

test('unknown command', () => {
  assert.throws(() => apply(mk(), { type: 'nope' }), CommandError);
  assert.throws(() => apply(mk(), {}), CommandError);
});
