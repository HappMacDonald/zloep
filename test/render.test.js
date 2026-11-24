import assert from 'node:assert/strict';
import { rasterKey, sequenceFrameAt, prepareFrame, tryPrepareFrame, drawFrame, renderFrame } from '../engine/render.js';

let n = 0;
const test = async (name, fn) => { await fn(); n++; console.log('ok', name); };

const proj = () => ({
  version: 1, idSeq: 5,
  media: [{ sha256: 'H1', name: 'a', size: 1, type: 'image/webp', dimensions: [10, 10], frameCount: 3 }],
  settings: { width: 100, height: 50 },
  clips: [
    { id: 'c1', kind: 'sequence', mediaHash: 'H1', start: 5, x: 1, y: 2, alpha: 1,
      frames: [{ sourceFrame: 0, durationTicks: 10 }, { sourceFrame: 2, durationTicks: 20 }] },
    { id: 'c2', kind: 'rect', start: 0, duration: 100, x: 3, y: 4, width: 5, height: 6, fill: '#f00', alpha: 0.5 },
    { id: 'c3', kind: 'text', start: 10, duration: 10, x: 20, y: 30, text: 'hi', fontFamily: 'A',
      fontSize: 12, fontWeight: 400, fill: '#000', outline: null, shadow: null, alpha: 1 },
  ],
});

function fakeEnv({ have = ['H1'] } = {}) {
  const warm = new Set();
  const env = { out: 0 };
  const lease = (image, extra = {}) => {
    env.out++;
    let done = false;
    return { image, ...extra, release() { if (!done) { done = true; env.out--; } } };
  };
  env.frames = {
    has: h => have.includes(h),
    tryAcquire: (h, i) => warm.has(`f${h}:${i}`) ? lease({ tag: `${h}:${i}`, width: 10, height: 10 }) : null,
    acquire: async (h, i) => { warm.add(`f${h}:${i}`); return lease({ tag: `${h}:${i}`, width: 10, height: 10 }); },
  };
  env.generated = {
    tryAcquire: c => warm.has('t' + c.text) ? lease({ tag: 'text:' + c.text, width: 30, height: 14 }, { ox: -2, oy: -3 }) : null,
    acquire: async c => { warm.add('t' + c.text); return lease({ tag: 'text:' + c.text, width: 30, height: 14 }, { ox: -2, oy: -3 }); },
  };
  return env;
}

function fakeCtx() {
  const ops = [];
  return {
    ops, globalAlpha: 1, fillStyle: '',
    clearRect: (...a) => ops.push(['clear', ...a]),
    drawImage(img, ...a) { ops.push(['img', img.tag, ...a, this.globalAlpha]); },
    fillRect(...a) { ops.push(['rect', this.fillStyle, ...a, this.globalAlpha]); },
  };
}

await test('sequenceFrameAt', () => {
  const c = proj().clips[0];
  assert.equal(sequenceFrameAt(c, -1), -1);
  assert.equal(sequenceFrameAt(c, 0), 0);
  assert.equal(sequenceFrameAt(c, 9), 0);
  assert.equal(sequenceFrameAt(c, 10), 2);
  assert.equal(sequenceFrameAt(c, 29), 2);
  assert.equal(sequenceFrameAt(c, 30), -1);
});

await test('layer order, offsets, alpha (tick 12)', async () => {
  const env = fakeEnv(), ctx = fakeCtx();
  const r = await renderFrame(ctx, proj(), 12, env);
  assert.deepEqual(ctx.ops, [
    ['clear', 0, 0, 100, 50],
    ['img', 'H1:0', 1, 2, 1],
    ['rect', '#f00', 3, 4, 5, 6, 0.5],
    ['img', 'text:hi', 18, 27, 1],
  ]);
  assert.deepEqual(r, { missing: [], outOfRange: [] });
  assert.equal(ctx.globalAlpha, 1);
  assert.equal(env.out, 0);
});

await test('clip activity by tick', async () => {
  const env = fakeEnv(), ctx = fakeCtx();
  await renderFrame(ctx, proj(), 20, env);   // text ended (end exclusive), seq on frame 2
  assert.deepEqual(ctx.ops.map(o => o[1]), [0, 'H1:2', '#f00']);
  const ctx2 = fakeCtx();
  await renderFrame(ctx2, proj(), 40, env);  // seq ended
  assert.deepEqual(ctx2.ops.map(o => o[1]), [0, '#f00']);
});

await test('missing media is reported once, not thrown', async () => {
  const p = proj();
  p.clips.push({ ...p.clips[0], id: 'c4' });
  const env = fakeEnv({ have: [] }), ctx = fakeCtx();
  const r = await renderFrame(ctx, p, 12, env);
  assert.deepEqual(r.missing, ['H1']);
  assert.equal(ctx.ops.filter(o => o[0] === 'img' && o[1] !== 'text:hi').length, 0);
});

await test('out-of-range sourceFrame is reported and skipped', async () => {
  const p = proj();
  p.clips[0].frames[0].sourceFrame = 5;      // manifest frameCount is 3
  const env = fakeEnv(), ctx = fakeCtx();
  const r = await renderFrame(ctx, p, 12, env);
  assert.deepEqual(r.outOfRange, ['c1']);
  assert.equal(env.out, 0);
});

await test('tryPrepareFrame: null when cold (no leaked leases), ok when warm', async () => {
  const env = fakeEnv();
  assert.equal(tryPrepareFrame(proj(), 12, env), null);
  assert.equal(env.out, 0);
  (await prepareFrame(proj(), 12, env)).release();   // warms the caches
  const pr = tryPrepareFrame(proj(), 12, env);
  assert.ok(pr);
  assert.equal(pr.layers.length, 3);
  assert.equal(env.out, 3 - 1);                      // two leases (frame + text); rect has none
  pr.release(); pr.release();
  assert.equal(env.out, 0);
});

await test('leases released even if draw throws', async () => {
  const env = fakeEnv(), ctx = fakeCtx();
  ctx.drawImage = () => { throw new Error('boom'); };
  await assert.rejects(renderFrame(ctx, proj(), 12, env), /boom/);
  assert.equal(env.out, 0);
});

await test('leases released if an acquire rejects', async () => {
  const env = fakeEnv(), ctx = fakeCtx();
  env.generated.acquire = async () => { throw new Error('font'); };
  await assert.rejects(renderFrame(ctx, proj(), 12, env), /font/);
  assert.equal(env.out, 0);
});

await test('alpha 0 clips are skipped', async () => {
  const p = proj(); p.clips[1].alpha = 0;
  const ctx = fakeCtx();
  await renderFrame(ctx, p, 40, fakeEnv());
  assert.deepEqual(ctx.ops, [['clear', 0, 0, 100, 50]]);
});

await test('reduced scale', async () => {
  const ctx = fakeCtx();
  await renderFrame(ctx, proj(), 40, fakeEnv(), { scale: 0.5 });
  assert.deepEqual(ctx.ops, [['clear', 0, 0, 50, 25], ['rect', '#f00', 2, 2, 3, 3, 0.5]]);
});

await test('rasterKey ignores position/time/alpha, tracks content', () => {
  const t = proj().clips[2];
  const k = rasterKey(t);
  assert.equal(typeof k, 'string');
  assert.equal(rasterKey({ ...t, x: 99, y: 1, alpha: 0.2, start: 7, duration: 3, id: 'zz' }), k);
  assert.notEqual(rasterKey({ ...t, text: 'ho' }), k);
  assert.notEqual(rasterKey({ ...t, fontSize: 13 }), k);
  assert.notEqual(rasterKey({ ...t, outline: { color: '#fff', width: 2 } }), k);
});

console.log(`\n${n} passed`);
