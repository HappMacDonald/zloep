// lib/framesource.js — browser only. One ImageDecoder per media + pinned LRU of VideoFrames.
// Implements the FrameSource interface from engine/render.js:
//   has(hash), tryAcquire(hash,i) -> lease|null, acquire(hash,i) -> Promise<lease|null>
// lease = { image: VideoFrame, release() }. Never close() frames yourself.

import { createLru } from './lru.js';

export function createFrameSource({ maxBytes = 256 * 1024 * 1024, Decoder = globalThis.ImageDecoder } = {}) {
  const media = new Map();     // hash -> {blob, type, decoderP, removed}
  const inflight = new Map();  // key -> {waiters, promise, primary}
  const errors = [];
  let decodes = 0;

  const lru = createLru({
    maxBytes,
    onEvict: f => { try { f.close(); } catch { /* already closed */ } },
  });

  const wrap = l => l && { image: l.value, release: l.release };
  const noteError = (where, e) => {
    errors.push(`${where}: ${e && e.message || e}`);
    if (errors.length <= 3) console.warn('[framesource]', where, e);
  };

  function getDecoder(m) {
    m.decoderP ??= (async () => {
      const data = await m.blob.arrayBuffer();
      const d = new Decoder({ data, type: m.type });
      await d.tracks.ready;
      await d.completed;
      return d;
    })();
    return m.decoderP;
  }

  async function decodeOne(m, key, index) {
    try {
      const d = await getDecoder(m);
      const { image } = await d.decode({ frameIndex: index });
      decodes++;
      if (m.removed) { image.close(); return null; }
      return lru.put(key, image, image.codedWidth * image.codedHeight * 4);
    } catch (e) {
      noteError(`decode ${key}`, e);
      return null;
    }
  }

  async function acquire(hash, index) {
    const m = media.get(hash);
    if (!m) return null;
    const key = `${hash}:${index}`;
    const hit = lru.lease(key);
    if (hit) return wrap(hit);

    let rec = inflight.get(key);
    if (!rec) {
      rec = { waiters: 0, primary: null, promise: null };
      rec.promise = decodeOne(m, key, index).then(l => { rec.primary = l; });
      inflight.set(key, rec);
    }
    rec.waiters++;
    await rec.promise;
    // Synchronously: take our own lease, then (if last waiter) drop the primary one.
    const mine = rec.primary ? lru.lease(key) : null;
    if (--rec.waiters === 0) {
      inflight.delete(key);
      if (rec.primary) rec.primary.release();
    }
    return wrap(mine);
  }

  return {
    /** Register a File/Blob under its sha256. `type` overrides blob.type. */
    addMedia(hash, blob, type = blob.type) {
      if (!media.has(hash)) media.set(hash, { blob, type, decoderP: null, removed: false });
    },
    async removeMedia(hash) {
      const m = media.get(hash);
      if (!m) return;
      m.removed = true;
      media.delete(hash);
      lru.deleteWhere(k => k.startsWith(hash + ':'));
      if (m.decoderP) { try { (await m.decoderP).close(); } catch { /* ignore */ } }
    },
    has: hash => media.has(hash),
    /** {frameCount, animated} — awaits decoder setup. */
    async info(hash) {
      const m = media.get(hash);
      if (!m) return null;
      const t = (await getDecoder(m)).tracks.selectedTrack;
      return { frameCount: t.frameCount, animated: t.animated };
    },
    acquire,
    tryAcquire: (hash, index) => wrap(lru.lease(`${hash}:${index}`)),
    /** Fire-and-forget prefetch. */
    warm(hash, index) { acquire(hash, index).then(l => l && l.release()); },
    stats: () => ({ ...lru.stats(), decodes, media: media.size, inflight: inflight.size, errors: errors.length }),
    errors: () => errors.slice(),
    async dispose() {
      for (const h of [...media.keys()]) await this.removeMedia(h);
      lru.clear();
    },
  };
}
