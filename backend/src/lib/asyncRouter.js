// Express 4 does not catch rejected promises from async handlers: a failed
// DB query inside `router.get(async ...)` leaves the request hanging and, on
// Node 15+, an unhandled rejection can take the whole server down mid-service.
// This Router() wrapper forwards async errors to the central error handler.
const express = require("express");

const METHODS = ["get", "post", "put", "patch", "delete"];

function wrap(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
}

module.exports = function Router() {
  const router = express.Router();
  for (const m of METHODS) {
    const original = router[m].bind(router);
    router[m] = (path, ...handlers) => original(path, ...handlers.map((h) => (h.length === 4 ? h : wrap(h))));
  }
  return router;
};
