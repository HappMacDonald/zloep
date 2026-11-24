import test from 'node:test';
import assert from 'node:assert/strict';
import { createProject, sequenceClip, rectClip, textClip } from '../engine/project.js';
import { apply } from '../engine/commands.js';
import { clipsAt, clipBounds, hitTest, snapTime, timelineBars, referencedHashes, outputSummary } from '../engine/query.js';

function mk() {
  let p = createProject({ width: 100, height: 100, fps: [25, 1] });
  p = { ...p, media: [{ sha256: 'aa', name: 'a.webp', size: 1, type: 'image/webp', dimensions: [100, 100], frameCount: 10 }] };
  const add = clip => { p = apply(p, { type: 'addClip', clip }); };
  add(sequenceClip({ mediaHash: 'aa', frames: [{ sourceFrame: 0, durationTicks: 200 }] }));        // c1
  add(rectClip({ start: 50, duration: 50, x: 10, y: 10, width: 20, height: 20 }));                 // c2
  add(textClip({ start: 0, duration: 200, text: 'hello' }));                                       // c3
  return p;
}
const ids = a => a.map(c => c.id);

test('clipsAt: layer order and half-open ends', () => {
  const p = mk();
  assert.deepEqual(ids(clipsAt(p, 60)), ['c1', 'c2', 'c3']);
  assert.deepEqual(ids(clipsAt(p, 100)), ['c1', 'c3']);          // rect ends at 100 (exclusive)
  assert.deepEqual(clipsAt(p, 200), []);
});

test('clipBounds and hitTest', () => {
  const p = mk(), measure = () => ({ x: 0, y: 0, width: 5, height: 5 });
  assert.deepEqual(clipBounds(p, p.clips[0]), { x: 0, y: 0, width: 100, height: 100 });
  assert.equal(clipBounds(p, p.clips[2]), null);
  assert.deepEqual(clipBounds(p, p.clips[2], measure), { x: 0, y: 0, width: 5, height: 5 });
  assert.equal(hitTest(p, 60, 15, 15, measure).id, 'c2');
  assert.equal(hitTest(p, 10, 15, 15, measure).id, 'c1');        // rect not visible yet
  assert.equal(hitTest(p, 60, 2, 2, measure).id, 'c3');          // text is on top
  assert.equal(hitTest(p, 60, 2, 2).id, 'c2' === 'c2' ? 'c1' : '');  // no measurer: text unhittable
  assert.equal(hitTest(p, 60, 200, 200, measure), null);
});

test('snapTime', () => {
  const p = mk();                                                // edges at 0, 50, 100, 200; grid = 40 ticks
  assert.equal(snapTime(p, 52, { thresholdTicks: 5 }), 50);
  assert.equal(snapTime(p, 70, { thresholdTicks: 5 }), 80);      // falls back to grid
  assert.equal(snapTime(p, 70, { thresholdTicks: 5, playhead: 71 }), 71);
  assert.equal(snapTime(p, 52, { thresholdTicks: 5, excludeId: 'c2' }), 40);
  assert.equal(snapTime(p, 70, { grid: false }), 70);
  assert.equal(snapTime(p, -30, { grid: false }), 0);
});

test('timelineBars, referencedHashes, outputSummary', () => {
  const p = mk();
  assert.deepEqual(timelineBars(p).map(b => [b.id, b.layer, b.start, b.end, b.label]),
    [['c1', 0, 0, 200, 'a.webp'], ['c2', 1, 50, 100, 'rect'], ['c3', 2, 0, 200, 'hello']]);
  assert.deepEqual([...referencedHashes(p)], ['aa']);
  assert.deepEqual(outputSummary(p), { frameCount: 3, totalMs: 200 });
});
