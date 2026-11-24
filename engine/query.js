// Read-only selectors for the GUI. Pure.
import { changePoints, } from './changepoints.js';
import { planOutput } from './changepoints.js';
import { clipEnd } from './project.js';
import { snapTick } from './time.js';

// Visible clips at tick t, in layer order (last = topmost).
export const clipsAt = (p, t) => p.clips.filter(c => t >= c.start && t < clipEnd(c));

// {x,y,width,height} in project pixels. Text extents need a canvas, so the render layer
// passes measureText(clip) -> {x,y,width,height}; without it text bounds are null.
export function clipBounds(p, clip, measureText) {
  if (clip.kind === 'rect') return { x: clip.x, y: clip.y, width: clip.width, height: clip.height };
  if (clip.kind === 'sequence') {
    const m = p.media.find(m => m.sha256 === clip.mediaHash);
    return m ? { x: clip.x, y: clip.y, width: m.dimensions[0], height: m.dimensions[1] } : null;
  }
  return measureText ? measureText(clip) : null;
}

// Topmost visible clip whose bounds contain (px,py) at tick t, or null.
export function hitTest(p, t, px, py, measureText) {
  const vis = clipsAt(p, t);
  for (let i = vis.length - 1; i >= 0; i--) {
    const b = clipBounds(p, vis[i], measureText);
    if (b && px >= b.x && px < b.x + b.width && py >= b.y && py < b.y + b.height) return vis[i];
  }
  return null;
}

// Snap a tick to: nearest clip edge / frame boundary / playhead within thresholdTicks,
// else (if grid) the fps grid. excludeId removes the dragged clip's own edges from the targets.
export function snapTime(p, tick, { thresholdTicks = 0, playhead = null, excludeId = null, grid = true } = {}) {
  const base = excludeId ? { ...p, clips: p.clips.filter(c => c.id !== excludeId) } : p;
  const cands = changePoints(base);
  if (playhead !== null) cands.push(playhead);
  let best = null, bd = Infinity;
  for (const c of cands) {
    const d = Math.abs(c - tick);
    if (d <= thresholdTicks && d < bd) { best = c; bd = d; }
  }
  const out = best !== null ? best : grid ? snapTick(tick, p.settings.tickRate, p.settings.fps) : tick;
  return Math.max(0, out);
}

// One entry per clip for the timeline renderer.
export function timelineBars(p) {
  return p.clips.map((c, i) => {
    let label;
    if (c.kind === 'sequence') label = p.media.find(m => m.sha256 === c.mediaHash)?.name ?? c.mediaHash.slice(0, 8);
    else if (c.kind === 'text') label = c.text.slice(0, 24) || '(empty text)';
    else label = 'rect';
    return { id: c.id, kind: c.kind, layer: i, start: c.start, end: clipEnd(c), label };
  });
}

// Hashes the current project's clips use (for "clear unused" on the library).
export const referencedHashes = p =>
  new Set(p.clips.filter(c => c.kind === 'sequence').map(c => c.mediaHash));

// For the export dialog.
export function outputSummary(p, opts) {
  const plan = planOutput(p, opts);
  return { frameCount: plan.frames.length, totalMs: plan.totalMs };
}
