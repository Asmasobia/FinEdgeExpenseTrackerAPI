/**
 * Typed application errors.
 *
 * The problem this solves
 * --------------------------------------------------------------------------------
 * Every failure in this codebase used to be `throw new Error('...')`, and the error handler
 * mapped all of them to HTTP 500. So:
 *
 *   - registering an email that already exists answered 500, not 409
 *   - a wrong password answered 500, not 401
 *   - a missing required field answered 500, not 400
 *
 * That is not a cosmetic problem. Status codes are the part of an HTTP API that clients
 * make decisions on: 4xx means "you sent something wrong, changing it may help", 5xx means
 * "I am broken, retrying identically may help". Reporting a duplicate email as 500 tells a
 * client to retry the exact request that can never succeed, and tells the operator's alerting
 * that the server is failing when it is working perfectly.
 *
 * Why a class hierarchy rather than an error code on a plain object
 * --------------------------------------------------------------------------------
 * The status code has to travel with the error, because the place that *knows* what went
 * wrong (a service, deep in the call stack) is not the place that *writes the response*
 * (the error handler, at the top). The alternatives are worse: returning
 * `{ ok: false, code }` tuples means every caller has to remember to check, and matching on
 * `error.message` text in the handler couples the HTTP layer to English strings that any
 * refactor can silently break. Attaching the code to the error is the one option where the
 * information cannot get lost in transit and cannot be forgotten by an intermediate caller.
 *
 * The `expose` flag is the other half, and it matters more than the status code
 * --------------------------------------------------------------------------------
 * `expose` marks an error whose message was written deliberately for a client to read.
 * Errors we did not author — a TypeError, a filesystem failure — have messages written for
 * a developer reading a log, and those leak. This is not hypothetical here. The model throws:
 *
 *     Could not read transactions from <absolute path>: Unexpected end of JSON input
 *
 * and the old handler sent that straight to the client, publishing the server's directory
 * layout and the OS account name it runs under. Free reconnaissance, in a 500 body.
 *
 * So the rule the handler enforces: errors defined in this file are safe to show; everything
 * else becomes a generic message, with the real detail going to the log instead.
 */

/**
 * Base class. Extends the built-in Error so `instanceof Error`, `.stack` and anything that
 * inspects errors generically keep working.
 */
class AppError extends Error {
  constructor(message, { statusCode = 500, code = 'INTERNAL_ERROR', details } = {}) {
    super(message);
    // Without this, `error.name` reads "Error" for every subclass, because the built-in
    // Error constructor sets `name` from its own prototype and subclassing does not change
    // it. `this.constructor.name` makes a log line say "ConflictError", which is the single
    // most useful word in it.
    this.name = this.constructor.name;
    this.statusCode = statusCode;
    // A stable machine-readable code, separate from the human message. Clients that need to
    // branch on a specific failure should switch on this, never on the message text — the
    // message is prose and prose gets reworded.
    this.code = code;
    // Marks the message as written for a client. See the note above.
    this.expose = statusCode < 500;
    if (details !== undefined) this.details = details;
    // Omits this constructor from the stack trace, so the top frame is the line that
    // actually threw rather than this file. V8-specific, hence the guard.
    if (Error.captureStackTrace) Error.captureStackTrace(this, this.constructor);
  }
}

/** 400 — the request itself is malformed or fails a rule. `details` carries per-field reasons. */
class ValidationError extends AppError {
  constructor(message = 'Invalid request data', details) {
    super(message, { statusCode: 400, code: 'VALIDATION_ERROR', details });
  }
}

/** 401 — identity absent, unproven or expired. Not "you are forbidden"; see auth.js. */
class UnauthorizedError extends AppError {
  constructor(message = 'Unauthorized', code = 'UNAUTHORIZED') {
    super(message, { statusCode: 401, code });
  }
}

/** 403 — identity established, action not permitted. Unused today, and deliberately so:
 *  ownership failures answer 404 instead, so status codes cannot be used to discover which
 *  record ids other users hold. Defined because the distinction is worth keeping visible. */
class ForbiddenError extends AppError {
  constructor(message = 'Forbidden') {
    super(message, { statusCode: 403, code: 'FORBIDDEN' });
  }
}

/** 404 — no such resource, or none visible to this caller. */
class NotFoundError extends AppError {
  constructor(message = 'Resource not found') {
    super(message, { statusCode: 404, code: 'NOT_FOUND' });
  }
}

/**
 * 409 — the request is well formed but conflicts with existing state.
 *
 * This is the code a duplicate email deserves, and it is worth being precise about why it is
 * not 400. 400 says "fix your request"; there is nothing wrong with the request. 409 says
 * "the request is fine, the world is not in a state where it can succeed" — which is exactly
 * a taken email address, and it tells the client to prompt for a different one rather than
 * to re-validate its form.
 */
class ConflictError extends AppError {
  constructor(message = 'Conflict') {
    super(message, { statusCode: 409, code: 'CONFLICT' });
  }
}

module.exports = {
  AppError,
  ValidationError,
  UnauthorizedError,
  ForbiddenError,
  NotFoundError,
  ConflictError,
};
