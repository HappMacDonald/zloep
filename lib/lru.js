// lib/lru.js — byte-bounded LRU with pinning (leases). Pure JS, no DOM.
//
// put(key, value, bytes) -> lease     inserts pinned (so it can't be evicted before use)
// lease(key)             -> lease|null  pins + marks most-recently-used
// lease = { value, release() }       release is idempotent
// Pinned entries are never evicted; the cache may exceed maxBytes while they're held
// and trims when they're released. delete()/clear() of a pinned entry removes it from
// lookup immediately but defers onEvict (e.g. VideoFrame.close) until the last release.

export function createLru({ maxBytes, onEvict = () => {} }) {
  const map = new Map();          // insertion order = recency (oldest first)
  let bytes = 0;
  const st = { hits: 0, misses: 0, evictions: 0 };

  function free(e) { bytes -= e.bytes; st.evictions++; onEvict(e.value, e.key); }

  function trim() {
    if (bytes <= maxBytes) return;
    for (const e of map.values()) {
      if (bytes <= maxBytes) break;
      if (e.pins === 0) { map.delete(e.key); free(e); }
    }
  }

  function leaseOf(e) {
    e.pins++;
    let done = false;
    return {
      value: e.value,
      release() {
        if (done) return;
        done = true;
        e.pins--;
        if (e.pins === 0) { if (e.doomed) free(e); else trim(); }
      },
    };
  }

  function del(key) {
    const e = map.get(key);
    if (!e) return false;
    map.delete(key);
    if (e.pins === 0) free(e); else e.doomed = true;
    return true;
  }

  return {
    has: key => map.has(key),
    lease(key) {
      const e = map.get(key);
      if (!e) { st.misses++; return null; }
      st.hits++;
      map.delete(key); map.set(key, e);          // touch
      return leaseOf(e);
    },
    put(key, value, b) {
      let e = map.get(key);
      if (e) {                                    // duplicate: discard the new value
        onEvict(value, key);
        map.delete(key); map.set(key, e);
        return leaseOf(e);
      }
      e = { key, value, bytes: b, pins: 0, doomed: false };
      map.set(key, e);
      bytes += b;
      const l = leaseOf(e);
      trim();
      return l;
    },
    delete: del,
    deleteWhere(pred) { for (const k of [...map.keys()]) if (pred(k)) del(k); },
    clear() { for (const k of [...map.keys()]) del(k); },
    stats() {
      let pinned = 0;
      for (const e of map.values()) if (e.pins > 0) pinned++;
      return { bytes, entries: map.size, pinned, maxBytes, ...st };
    },
  };
}
