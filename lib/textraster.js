// lib/textraster.js — browser only. Implements GeneratedCache from engine/render.js (text only).
//   acquire(clip) -> Promise<{image,ox,oy,release}>, tryAcquire(clip) -> same|null
//   measureText(clip) -> {width,height}   unpadded box, anchor = top-left (x,y)
//   clear()  call after fonts change (cache keys don't include font availability)
//
// Layout: lines split on '\n', line height = fontSize*1.2, baseline centred in the line
// using fontBoundingBox metrics. outline.width = full lineWidth (half falls outside the glyph).
// Shadow is cast by the outline stroke when there is one, otherwise by the fill.

import { createLru } from './lru.js';
import { rasterKey } from '../engine/render.js';

const LINE_HEIGHT = 1.2;

export function createGeneratedCache({
  maxBytes = 64 * 1024 * 1024,
  makeCanvas = (w, h) => new OffscreenCanvas(w, h),
  ensureFont = (font, text) => globalThis.document?.fonts?.load(font, text) ?? Promise.resolve(),
} = {}) {
  const lru = createLru({ maxBytes, onEvict: v => { v.image.width = 0; v.image.height = 0; } });
  let scratch = null;
  const scratchCtx = () => (scratch ??= makeCanvas(8, 8).getContext('2d'));

  const family = f => (f.includes(',') ? f : `"${f.replace(/"/g, '')}", sans-serif`);
  const fontOf = c => `${c.fontWeight} ${c.fontSize}px ${family(c.fontFamily)}`;

  function layout(clip) {
    const ctx = scratchCtx();
    const font = fontOf(clip);
    ctx.font = font; ctx.textBaseline = 'alphabetic';
    const lines = clip.text.split('\n');
    let width = 0, asc = 0, desc = 0;
    for (const ln of lines) {
      const m = ctx.measureText(ln);
      width = Math.max(width, m.width);
      asc = Math.max(asc, m.fontBoundingBoxAscent ?? clip.fontSize * 0.8);
      desc = Math.max(desc, m.fontBoundingBoxDescent ?? clip.fontSize * 0.2);
    }
    const lh = clip.fontSize * LINE_HEIGHT;
    return {
      font, lines, lh,
      width: Math.ceil(width),
      height: Math.ceil(lh * lines.length),
      base: Math.round((lh - (asc + desc)) / 2 + asc),
    };
  }

  function pads(clip) {
    const base = Math.ceil(clip.fontSize * 0.1) + 1;          // glyph overhang (italics etc.)
    const o = clip.outline ? Math.ceil(clip.outline.width / 2) + 1 : 0;
    const s = clip.shadow;
    const b = s ? Math.ceil(s.blur) + 1 : 0;
    const sx = s ? Math.ceil(s.dx) : 0, sy = s ? Math.ceil(s.dy) : 0;
    return {
      l: Math.max(base, o, s ? b - sx : 0),
      r: Math.max(base, o, s ? b + sx : 0),
      t: Math.max(base, o, s ? b - sy : 0),
      b: Math.max(base, o, s ? b + sy : 0),
    };
  }

  function rasterize(clip) {
    const L = layout(clip), P = pads(clip);
    const W = L.width + P.l + P.r, H = L.height + P.t + P.b;
    const image = makeCanvas(W, H);
    const ctx = image.getContext('2d');
    ctx.font = L.font; ctx.textBaseline = 'alphabetic'; ctx.textAlign = 'left';
    ctx.lineJoin = 'round'; ctx.miterLimit = 2;
    const s = clip.shadow, o = clip.outline;
    const shadow = on => {
      if (on && s) { ctx.shadowColor = s.color; ctx.shadowBlur = s.blur; ctx.shadowOffsetX = s.dx; ctx.shadowOffsetY = s.dy; }
      else { ctx.shadowColor = 'rgba(0,0,0,0)'; ctx.shadowBlur = 0; ctx.shadowOffsetX = 0; ctx.shadowOffsetY = 0; }
    };
    const yOf = i => P.t + Math.round(i * L.lh) + L.base;
    if (o) {                                   // all strokes first, then all fills
      shadow(true);
      ctx.lineWidth = o.width; ctx.strokeStyle = o.color;
      L.lines.forEach((ln, i) => ctx.strokeText(ln, P.l, yOf(i)));
    }
    shadow(!o);
    ctx.fillStyle = clip.fill;
    L.lines.forEach((ln, i) => ctx.fillText(ln, P.l, yOf(i)));
    return { image, ox: -P.l, oy: -P.t, bytes: W * H * 4 };
  }

  const wrap = l => l && { image: l.value.image, ox: l.value.ox, oy: l.value.oy, release: l.release };

  return {
    measureText(clip) { const L = layout(clip); return { width: L.width, height: L.height }; },
    tryAcquire: clip => wrap(lru.lease(rasterKey(clip))),
    async acquire(clip) {
      const key = rasterKey(clip);
      const hit = lru.lease(key);
      if (hit) return wrap(hit);
      try { await ensureFont(fontOf(clip), clip.text); } catch { /* fall back to whatever the browser has */ }
      const again = lru.lease(key);               // another caller may have rasterized meanwhile
      if (again) return wrap(again);
      const v = rasterize(clip);                  // sync from here: no race
      return wrap(lru.put(key, v, v.bytes));
    },
    clear: () => lru.clear(),
    stats: () => lru.stats(),
  };
}
