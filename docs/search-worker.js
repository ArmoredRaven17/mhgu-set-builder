/* search-worker.js — runs the search off the UI thread.
 *
 * The data files and the two engines assign to `window`; a worker has no
 * `window`, so it is aliased to the worker global before they are imported.
 * Script URLs (with their cache-busting versions) are sent by the page, so
 * there is no second list of versions to keep in step with index.html.
 *
 * Cancellation terminates the worker rather than polling a flag: the search is
 * synchronous, so a busy worker cannot receive messages. The page simply drops
 * this worker and starts a fresh one.
 */
self.window = self;

let data = null;

self.onmessage = function (e) {
  const msg = e.data || {};
  if (msg.type === "init") {
    importScripts.apply(self, msg.scripts);
    data = {
      skills: self.SB_SKILLS, souls: self.SB_SOULS,
      decos: self.SB_DECOS, armor: self.SB_ARMOR,
    };
    self.postMessage({ type: "ready" });
    return;
  }
  if (msg.type === "search") {
    if (!data) { self.postMessage({ type: "error", message: "worker not initialized" }); return; }
    try {
      const res = self.SBSearch.search(msg.query, data, {
        progress: s => self.postMessage({ type: "progress", explored: s.explored, found: s.found }),
      });
      self.postMessage({ type: "done", res: res });
    } catch (err) {
      self.postMessage({ type: "error", message: String(err && err.message || err) });
    }
  }
};
