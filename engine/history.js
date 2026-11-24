// Undo/redo + drag sessions over immutable project snapshots. No DOM, no clock dependency
// (inject `now` for tests). Library contents are NOT part of history.
import { run } from './commands.js';
import { canonical } from './canon.js';

export function createHistory(initial, { limit = 200, coalesceMs = 1000, now = Date.now } = {}) {
  let present = initial, base = null, preview = null, activeDrag = null;
  let past = [], future = [], lastEntry = null;
  const subs = new Set();
  const notify = () => { for (const f of [...subs]) f(); };
  const idle = what => { if (activeDrag) throw new Error(`${what} while a drag is in progress`); };
  function push(entry) {
    past.push(entry); if (past.length > limit) past.shift();
    future = []; lastEntry = entry;
  }

  return {
    get present() { return present; },                   // last committed project
    get current() { return preview ?? present; },        // what the GUI should render
    get dragging() { return activeDrag !== null; },
    get canUndo() { return !activeDrag && past.length > 0; },
    get canRedo() { return !activeDrag && future.length > 0; },
    get undoLabel() { return past.length ? past[past.length - 1].label : null; },
    get redoLabel() { return future.length ? future[future.length - 1].label : null; },

    subscribe(fn) { subs.add(fn); return () => subs.delete(fn); },

    // Run a command as one undo step. Throws CommandError (state unchanged) on failure.
    // Same coalesceKey within coalesceMs of the previous step merges into it (nudges, typing).
    do(cmd, { label = cmd.type, coalesceKey = null } = {}) {
      idle('do');
      const { project, result } = run(present, cmd);
      if (project === present) return result;            // no-op (e.g. idempotent addMedia)
      const top = past[past.length - 1], t = now();
      if (coalesceKey && top && top === lastEntry && top.key === coalesceKey && t - top.time <= coalesceMs) {
        top.after = project; top.time = t;
      } else {
        push({ label, key: coalesceKey, before: present, after: project, time: t });
      }
      present = project; notify();
      return result;
    },

    undo() {
      idle('undo');
      const e = past.pop(); if (!e) return false;
      future.push(e); present = e.before; lastEntry = null; notify(); return true;
    },
    redo() {
      idle('redo');
      const e = future.pop(); if (!e) return false;
      past.push(e); present = e.after; lastEntry = null; notify(); return true;
    },

    // Drag session: press-move-release. update() recomputes from the project as it was at
    // press (not from the previous preview). Nothing enters history until commit().
    beginDrag(label = 'drag') {
      idle('beginDrag');
      const b = present;
      base = b; preview = null;
      const drag = {
        update(cmd) {
          if (activeDrag !== drag) throw new Error('drag is finished');
          const { project } = run(b, cmd);               // throws => preview unchanged
          preview = project; notify(); return project;
        },
        // Returns true if a history entry was created (false if nothing changed).
        commit() {
          if (activeDrag !== drag) throw new Error('drag is finished');
          const p = preview;
          activeDrag = null; base = null; preview = null;
          const changed = p && p !== b && canonical(p) !== canonical(b);
          if (changed) { push({ label, key: null, before: b, after: p, time: now() }); present = p; }
          notify(); return !!changed;
        },
        cancel() {
          if (activeDrag !== drag) return;
          activeDrag = null; base = null; preview = null; notify();
        },
      };
      activeDrag = drag;
      return drag;
    },

    // New document (import): replaces the project and discards all history.
    reset(project) {
      activeDrag = null; base = null; preview = null;
      present = project; past = []; future = []; lastEntry = null; notify();
    },
  };
}
