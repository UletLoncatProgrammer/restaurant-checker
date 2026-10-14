// Tiny in-memory fixed-window limiter keyed by client IP. Enough to blunt
// password guessing and runaway clients on a single-process server (each company
// runs its own stack); a shared store would be needed to scale to many processes.
function createLimiter({ windowMs, max, message = "Too many requests, slow down and try again shortly." }) {
  const hits = new Map();
  const timer = setInterval(() => {
    const now = Date.now();
    for (const [k, v] of hits) if (v.reset <= now) hits.delete(k);
  }, Math.min(windowMs, 60000));
  timer.unref();
  const middleware = (req, res, next) => {
    const key = req.ip || "unknown";
    const now = Date.now();
    let h = hits.get(key);
    if (!h || h.reset <= now) {
      h = { n: 0, reset: now + windowMs };
      hits.set(key, h);
    }
    h.n += 1;
    if (h.n > max) {
      res.set("Retry-After", String(Math.ceil((h.reset - now) / 1000)));
      return res.status(429).json({ error: message });
    }
    next();
  };
  middleware.reset = () => hits.clear();
  return middleware;
}

module.exports = { createLimiter };
