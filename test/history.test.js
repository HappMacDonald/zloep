import test from 'node:test';
import assert from 'node:assert/strict';
import { createProject, sequenceClip } from '../engine/project.js';
import { apply, CommandError } from '../engine/commands.js';
import { createHistory } from '../engine/history.js';

function mk() {
  let p = createProject({ width: 100, height: 100, fps: [25, 1] });
  p = { ...p, media: [{ sha256: 'aa', name: 'a.webp', size: 1, type: 'image/webp', dimensions: [100, 100], frameCount: 10 }] };
  return apply(p, { type: 'addClip', clip: sequenceClip({ mediaHash: 'aa', frames: [{ sourceFrame: 0, durationTicks: 100 }] }) });
}
const patch = (p) => ({ type: 'patchClip', id: 'c1', patch: p });
const x = h => h.present.clips[0].x;

test('do / undo / redo with labels', () => {
  const h = createHistory(mk());
  h.do(patch({ x: 1 }), { label: 'Move' });
  h.do(patch({ x: 2 }), { label: 'Nudge' });
  assert.equal(h.undoLabel, 'Nudge');
  h.undo(); assert.equal(x(h), 1); assert.equal(h.redoLabel, 'Nudge');
  h.undo(); assert.equal(x(h), 0); assert.equal(h.canUndo, false);
  h.redo(); assert.equal(x(h), 1);
  h.do(patch({ x: 5 })); assert.equal(h.canRedo, false);
});

test('no-op commands create no entry', () => {
  const h = createHistory(mk());
  h.do({ type: 'addMedia', entry: { sha256: 'aa' } });
  assert.equal(h.canUndo, false);
});

test('failed command leaves state unchanged', () => {
  const h = createHistory(mk()), before = h.present;
  assert.throws(() => h.do(patch({ alpha: 9 })), CommandError);
  assert.equal(h.present, before); assert.equal(h.canUndo, false);
});

test('coalescing', () => {
  let t = 0;
  const h = createHistory(mk(), { now: () => t });
  h.do(patch({ x: 1 }), { coalesceKey: 'nudge' });
  t = 500; h.do(patch({ x: 2 }), { coalesceKey: 'nudge' });
  h.undo(); assert.equal(x(h), 0); assert.equal(h.canUndo, false);   // one step
  t = 5000; h.do(patch({ x: 1 }), { coalesceKey: 'nudge' });
  t = 5100; h.do(patch({ x: 2 }), { coalesceKey: 'other' });
  h.undo(); assert.equal(x(h), 1); assert.equal(h.canUndo, true);    // different key: two steps
  h.undo();
  t = 9000; h.do(patch({ x: 1 }), { coalesceKey: 'nudge' });
  t = 11000; h.do(patch({ x: 2 }), { coalesceKey: 'nudge' });        // window expired
  h.undo(); assert.equal(x(h), 1);
});

test('drag session: preview, commit as one step', () => {
  const h = createHistory(mk());
  const d = h.beginDrag('Move bar');
  d.update(patch({ start: 10 }));
  d.update(patch({ start: 20 }));
  assert.equal(h.current.clips[0].start, 20);
  assert.equal(h.present.clips[0].start, 0);
  assert.equal(h.canUndo, false);
  assert.throws(() => h.do(patch({ x: 1 })));
  assert.equal(d.commit(), true);
  assert.equal(h.present.clips[0].start, 20);
  assert.equal(h.undoLabel, 'Move bar');
  h.undo(); assert.equal(h.present.clips[0].start, 0); assert.equal(h.canUndo, false);
});

test('drag cancel and drag back to start', () => {
  const h = createHistory(mk());
  let d = h.beginDrag('a'); d.update(patch({ start: 30 })); d.cancel();
  assert.equal(h.current, h.present); assert.equal(h.canUndo, false);
  d = h.beginDrag('b'); d.update(patch({ start: 30 })); d.update(patch({ start: 0 }));
  assert.equal(d.commit(), false); assert.equal(h.canUndo, false);
  assert.throws(() => d.update(patch({ start: 1 })));                // finished drags are dead
});

test('history limit', () => {
  const h = createHistory(mk(), { limit: 3 });
  for (let i = 1; i <= 5; i++) h.do(patch({ x: i }));
  let n = 0; while (h.undo()) n++;
  assert.equal(n, 3); assert.equal(x(h), 2);
});

test('subscribe and reset', () => {
  const h = createHistory(mk());
  let n = 0; const un = h.subscribe(() => n++);
  h.do(patch({ x: 1 })); assert.equal(n, 1);
  const d = h.beginDrag('d'); d.update(patch({ x: 2 })); assert.equal(n, 2);
  d.commit(); assert.equal(n, 3);
  h.undo(); assert.equal(n, 4);
  h.reset(mk()); assert.equal(h.canUndo, false); assert.equal(h.canRedo, false); assert.equal(n, 5);
  un(); h.do(patch({ x: 1 })); assert.equal(n, 5);
});
