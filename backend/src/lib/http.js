// Small typed error so route code can `throw new HttpError(409, "...")` from
// anywhere (including inside a DB transaction) and the central error handler
// turns it into a clean JSON response.
class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

module.exports = { HttpError };
