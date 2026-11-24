// engine/render.js — pure ESM, no DOM. Draws via a duck-typed ctx and env.
//
// env = {
//   frames:    FrameSource,     // decoded source frames (browser impl comes later)
//   generated: GeneratedCache,  // rasterized text bitmaps
// }
//
// Lease = { image, release() }   image = any CanvasImageSource (VideoFrame, ImageBitmap, canvas)
//   While a lease is held, the cache must not evict/close the image. release() is idempotent.
//
// FrameSource:
//   has(hash)                    -> boolean   (false for stubs / unknown media)
//   acquire(hash, index)         -> Promise<Lease|null>   (null = could not decode)
//   tryAcquire(hash, index)      -> Lease|null            (sync; null = not cached yet)
//
// GeneratedCache (text only):
//   acquire(clip)    -> Promise<Lease & {ox,oy}>   ox,oy = bitmap top-left relative to clip x,y
//                       (negative when outline/shadow pad the bitmap)
//   tryAcquire(clip) -> (Lease & {ox,oy})|null
//
// Prepared = { tick, layers, missing:[hash], outOfRange:[clipId], release() }
//   layers[i] = {image,x,y,alpha}  |  {rect:{x,y,width,height,fill},alpha}
//   (x,y of image layers already include ox,oy)

import { canonical } from './canon.js';
import { frameIndexAt } from './frametable.js';

// Everything that does NOT change the pixels of a rasterized clip.
const RASTER_OMIT = new Set(['id', 'start', 'duration', 'x', 'y', 'alpha']);

/** Cache key for a generated clip's bitmap: moving/fading/retiming doesn't change it. */
export function rasterKey(clip) {
  const o = {};
  for (const k of Object.keys(clip)) if (!RASTER_OMIT.has(k)) o[k] = clip[k];
  return canonical(o);
}

/** sourceFrame shown `rel` ticks into a sequence clip, or -1 if outside the table. */
export function sequenceFrameAt(clip, rel) {
  const i = frameIndexAt(clip.frames, rel);
  return i < 0 ? -1 : clip.frames[i].sourceFrame;
}

/** Which clips draw at `tick`, in layer order (array order, last = top). No I/O. */
export function planLayers(project, tick) {
  const media = new Map(project.media.map(m => [m.sha256, m]));
  const items = [];
  const outOfRange = [];
  for (const clip of project.clips) {
    if (!(clip.alpha > 0)) continue;
    if (clip.kind === 'sequence') {
      const index = sequenceFrameAt(clip, tick - clip.start);
      if (index < 0) continue;
      const m = media.get(clip.mediaHash);
      if (m && index >= m.frameCount) { outOfRange.push(clip.id); continue; }
      items.push({ type: 'frame', clip, hash: clip.mediaHash, index });
    } else {
      if (tick < clip.start || tick >= clip.start + clip.duration) continue;
      if (clip.kind === 'text') {
        if (clip.text === '') continue;
        items.push({ type: 'text', clip });
      } else if (clip.kind === 'rect') {
        if (!(clip.width > 0 && clip.height > 0)) continue;
        items.push({ type: 'rect', clip });
      }
    }
  }
  return { items, outOfRange };
}

function rectLayer(clip) {
  const { x, y, width, height, fill } = clip;
  return { rect: { x, y, width, height, fill }, alpha: clip.alpha };
}

function finish(tick, layers, missing, outOfRange, leases) {
  let done = false;
  return {
    tick,
    layers: layers.filter(Boolean),
    missing: [...missing],
    outOfRange,
    release() {
      if (done) return;
      done = true;
      for (const l of leases) l.release();
    },
  };
}

/** Async: waits for every source. Never throws for missing media (reports it). */
export async function prepareFrame(project, tick, env) {
  const { items, outOfRange } = planLayers(project, tick);
  const leases = [];
  const missing = new Set();
  const layers = new Array(items.length).fill(null);

  const results = await Promise.allSettled(items.map(async (it, i) => {
    const c = it.clip;
    if (it.type === 'rect') { layers[i] = rectLayer(c); return; }
    if (it.type === 'frame') {
      if (!env.frames.has(it.hash)) { missing.add(it.hash); return; }
      const lease = await env.frames.acquire(it.hash, it.index);
      if (!lease) { missing.add(it.hash); return; }
      leases.push(lease);
      layers[i] = { image: lease.image, x: c.x, y: c.y, alpha: c.alpha };
      return;
    }
    const lease = await env.generated.acquire(c);
    leases.push(lease);
    layers[i] = { image: lease.image, x: c.x + lease.ox, y: c.y + lease.oy, alpha: c.alpha };
  }));

  const failed = results.find(r => r.status === 'rejected');
  if (failed) {                       // all settled by now, so releasing is safe
    for (const l of leases) l.release();
    throw failed.reason;
  }
  return finish(tick, layers, missing, outOfRange, leases);
}

/** Sync: Prepared if everything is already cached, else null (no leases left held). */
export function tryPrepareFrame(project, tick, env) {
  const { items, outOfRange } = planLayers(project, tick);
  const leases = [];
  const missing = new Set();
  const layers = [];
  const bail = () => { for (const l of leases) l.release(); return null; };

  for (const it of items) {
    const c = it.clip;
    if (it.type === 'rect') { layers.push(rectLayer(c)); continue; }
    if (it.type === 'frame') {
      if (!env.frames.has(it.hash)) { missing.add(it.hash); continue; }
      const lease = env.frames.tryAcquire(it.hash, it.index);
      if (!lease) return bail();
      leases.push(lease);
      layers.push({ image: lease.image, x: c.x, y: c.y, alpha: c.alpha });
      continue;
    }
    const lease = env.generated.tryAcquire(c);
    if (!lease) return bail();
    leases.push(lease);
    layers.push({ image: lease.image, x: c.x + lease.ox, y: c.y + lease.oy, alpha: c.alpha });
  }
  return finish(tick, layers, missing, outOfRange, leases);
}

const imgW = im => im.displayWidth ?? im.width;
const imgH = im => im.displayHeight ?? im.height;

/**
 * Sync draw. size = project {width,height}. scale=1 is the exact path (export);
 * other scales are for reduced previews only. Offsets are rounded to whole pixels.
 */
export function drawFrame(ctx, prepared, { width, height, scale = 1 }) {
  const S = v => Math.round(v * scale);
  ctx.clearRect(0, 0, S(width), S(height));
  for (const L of prepared.layers) {
    ctx.globalAlpha = L.alpha;
    if (L.rect) {
      const r = L.rect;
      ctx.fillStyle = r.fill;
      ctx.fillRect(S(r.x), S(r.y), S(r.width), S(r.height));
    } else if (scale === 1) {
      ctx.drawImage(L.image, Math.round(L.x), Math.round(L.y));
    } else {
      ctx.drawImage(L.image, S(L.x), S(L.y), S(imgW(L.image)), S(imgH(L.image)));
    }
  }
  ctx.globalAlpha = 1;
}

/** prepare + draw + release. Export uses this. */
export async function renderFrame(ctx, project, tick, env, opts = {}) {
  const prepared = await prepareFrame(project, tick, env);
  try {
    const { width, height } = project.settings;
    drawFrame(ctx, prepared, { width, height, scale: opts.scale ?? 1 });
    return { missing: prepared.missing, outOfRange: prepared.outOfRange };
  } finally {
    prepared.release();
  }
}
