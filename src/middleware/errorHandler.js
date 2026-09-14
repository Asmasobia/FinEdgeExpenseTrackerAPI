const { AppError, NotFoundError } = require('../errors');

/**
 * Catch-all for unmatched routes.
 *
 * Register this AFTER every route and BEFORE the error handler. Express tries middleware in
 * registration order, so anything mounted here is only reached when no route matched — which
 * is exactly the definition of a 404.
 *
 * Without it, Express falls back to its own default handler, which answers with an HTML
 * page. For a JSON API that is a real annoyance rather than a triviality: a client doing
 * `await res.json()` on a typo'd URL gets a parse error from the *client library*, so the
 * reported failure is "unexpected token < in JSON" instead of "that endpoint does not
 * exist". The route typo is the bug; the parse error is noise pointing away from it.
 *
 * It throws into the shared error path rather than responding directly, so a 404 has the
 * same body shape as every other error. One response format for all failures means a client
 * writes one error-handling branch, not two.
 */
const notFoundHandler = (req, res, next) => {
  next(new NotFoundError(`Cannot ${req.method} ${req.originalUrl}`));
};

/**
 * The single place where an error becomes an HTTP response.
 *
 * THE FOUR PARAMETERS ARE MANDATORY, INCLUDING THE UNUSED `next`.
 * Express distinguishes error-handling middleware from ordinary middleware by
 * `fn.length === 4` — the function's arity, nothing else. Drop the trailing `next` and this
 * silently becomes normal middleware: it is never called with an error, every failure falls
 * through to Express's default handler, and the symptom is "my error handler stopped
 * running" with nothing anywhere pointing at the signature. A linter flagging `next` as
 * unused is wrong here, and that is why this paragraph exists.
 *
 * What this replaces:
 *
 *     const errorHandler = (err, req, res, next) => {
 *         console.error(err.message);
 *         res.status(500).json({ message: err.message || 'Internal Server Error' });
 *     };
 *
 * Two faults in three lines. Everything answered 500 regardless of cause, and every internal
 * message was published verbatim to the client — including the model's "Could not read
 * transactions from <absolute path>", which hands out the server's directory layout and the
 * account name it runs under.
 */
const errorHandler = (err, req, res, next) => {
  // If a response has already begun, the status and headers are gone — they are on the wire.
  // Calling res.status() now throws ERR_HTTP_HEADERS_SENT *inside the error handler*, which
  // replaces a recoverable problem with an unhandled one and can leave the socket hanging.
  // Handing the error back to Express lets it destroy the connection, which is the only
  // honest outcome once a partial response has been sent.
  if (res.headersSent) return next(err);

  // Errors from our own code carry their own status. But `express.json()` throws too, and its
  // errors are not AppErrors: send `{"amount":` and body-parser raises a SyntaxError already
  // tagged `status: 400, expose: true`. Treating that as unknown would answer 500 for what is
  // plainly a malformed client request — the exact confusion this slice exists to remove.
  //
  // `expose === true` is required before trusting a foreign error's status, and that gate is
  // the load-bearing part. It is the library's own assertion that its message was written for
  // a client to read. Trusting `status` alone would let any future dependency that happens to
  // set a `status` property decide our response code and publish its own internal text.
  const isKnown = err instanceof AppError;
  const foreignStatus = Number(err.status ?? err.statusCode);
  const trustForeign =
    !isKnown && err.expose === true && Number.isInteger(foreignStatus) && foreignStatus >= 400 && foreignStatus <= 499;

  const statusCode = isKnown ? err.statusCode : trustForeign ? foreignStatus : 500;
  const canExpose = isKnown ? err.expose : trustForeign;

  // The log is where the truth goes, unabridged, because it is not attacker-visible.
  // Deliberately asymmetric: 5xx gets the full error object (and so the stack) because it is
  // a defect somebody has to find; 4xx gets one line, because a client sending a bad field is
  // ordinary traffic and printing a stack per bad request buries real failures in noise.
  if (statusCode >= 500) {
    console.error(`[ERROR] ${req.method} ${req.originalUrl} -> ${statusCode}`, err);
  } else {
    console.warn(`[WARN] ${req.method} ${req.originalUrl} -> ${statusCode} ${err.name}: ${err.message}`);
  }

  // `expose` is the gate, not the status code. The distinction is "did we write this message
  // for a client to read?" — errors from src/errors.js were, a TypeError or an ENOENT was
  // not. Anything unrecognised gets one fixed string, so no internal detail can escape by
  // being thrown from somewhere nobody thought about.
  const body = {
    error: isKnown ? err.code : trustForeign ? 'BAD_REQUEST' : 'INTERNAL_ERROR',
    message: canExpose ? err.message : 'Internal Server Error',
  };

  // Per-field reasons, when the thrower supplied them. A 400 saying only "Invalid request
  // data" forces the client to guess which of four fields was wrong; naming them is the
  // difference between a usable API and a frustrating one. Safe to expose because these
  // describe the client's own input, not the server's internals.
  if (isKnown && err.details !== undefined) body.details = err.details;

  res.status(statusCode).json(body);
};

module.exports = { errorHandler, notFoundHandler };
