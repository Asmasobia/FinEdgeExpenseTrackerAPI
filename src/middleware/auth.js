/**
 * Authentication middleware: proves who is making a request.
 *
 * Why this file did not exist and had to
 * --------------------------------------------------------------------------------
 * `userService.loginUser` signed a JWT and handed it to the client, and nothing in the
 * application ever verified one. Signing a token without verifying it is not partial
 * authentication — it is none. Every transaction route was open:
 *
 *     router.get('/', getAllTransactions);        // no auth
 *     router.delete('/:id', deleteTransaction);   // no auth
 *
 * So any anonymous caller could read, alter and delete the whole ledger. For an expense
 * tracker — a record of what somebody earns and spends — that is the headline defect, not
 * a missing feature.
 *
 * What a JWT actually gives you
 * --------------------------------------------------------------------------------
 * A JWT is three base64url segments: header, payload, signature. The first two are
 * ENCODED, not encrypted — anyone holding a token can read the payload. The only thing
 * a token proves is that whoever produced it knew the signing secret, because the
 * signature covers `header.payload` and cannot be recomputed without that secret.
 *
 * Two consequences follow, and both shape the code below:
 *
 *   1. Never put a secret in the payload. `{ userId }` is fine; it is not confidential.
 *   2. **Never trust the payload without verifying the signature first.** Decoding is not
 *      verifying. `jwt.decode()` parses the payload and checks nothing — an attacker can
 *      craft `{"userId":"<someone else>"}` with any signature at all and it will decode
 *      perfectly. `jwt.verify()` recomputes the signature and rejects a mismatch, and it
 *      also enforces `exp`. Using `decode` where `verify` was meant is one of the most
 *      common authentication bugs there is, and it fails open: it works in testing and
 *      authenticates anybody in production.
 */

const jwt = require('jsonwebtoken');

const config = require('../config');

/**
 * Pull the token out of an `Authorization: Bearer <token>` header.
 *
 * Returns null rather than throwing, so the caller decides the status code. The scheme is
 * matched case-insensitively because RFC 7235 defines it that way, and clients really do
 * send `bearer`. Splitting on whitespace and requiring exactly two parts rejects both a
 * bare token with no scheme and a header with stray extra fields, instead of quietly
 * accepting something half-formed.
 */
function extractBearerToken(header) {
  if (typeof header !== 'string') return null;
  const parts = header.trim().split(/\s+/);
  if (parts.length !== 2) return null;
  if (parts[0].toLowerCase() !== 'bearer') return null;
  return parts[1] || null;
}

/**
 * Require a valid token. On success attaches `req.user` and calls `next()`; otherwise ends
 * the request with 401.
 *
 * Responds directly instead of delegating to `next(error)` because the current
 * errorHandler maps every error to 500, which would report a missing token as a server
 * fault. Once the error taxonomy exists this could throw an `UnauthorizedError` instead;
 * until then, answering here is what makes the status correct.
 *
 * 401 (not 403) is the right code: 401 means "I do not know who you are", 403 means "I
 * know who you are and you may not do this". A missing or invalid token is the former.
 */
exports.requireAuth = (req, res, next) => {
  const token = extractBearerToken(req.headers.authorization);

  if (!token) {
    return res.status(401).json({
      message: 'Missing or malformed Authorization header. Expected: Authorization: Bearer <token>',
    });
  }

  try {
    // The `algorithms` allow-list is not optional hardening — it closes a real attack.
    // Without it, the library honours the algorithm named in the token's own header, and
    // the payload's author controls that header. Historically that enabled `alg: "none"`
    // (signature dropped entirely) and RS256→HS256 confusion, where a service verifying
    // with a public key is tricked into treating that public key as an HMAC secret — and
    // a public key is, by definition, known to the attacker. Pinning the algorithm we
    // actually sign with means the token cannot choose how it is checked.
    const payload = jwt.verify(token, config.jwtSecret, { algorithms: ['HS256'] });

    // Guard the payload shape. `verify` proves the token is authentic and unexpired; it
    // says nothing about the payload containing what this application expects. A token
    // signed by this service but issued before `userId` existed would sail through and
    // leave `req.user.userId` undefined — which downstream would scope queries to
    // `undefined` and, without the model's own guard, match records that also lack an
    // owner. Rejecting it here keeps that from ever becoming a data leak.
    if (!payload || typeof payload.userId !== 'string' || payload.userId === '') {
      return res.status(401).json({ message: 'Token is valid but carries no user identity' });
    }

    req.user = { userId: payload.userId };
    return next();
  } catch (error) {
    // Distinguishing expiry from invalidity is safe and genuinely useful: the client
    // already holds the token, so "it expired" reveals nothing it does not know, and it
    // tells a client to refresh rather than to prompt for a new password.
    if (error.name === 'TokenExpiredError') {
      return res.status(401).json({ message: 'Token expired' });
    }
    // Everything else — bad signature, malformed structure, wrong algorithm — collapses
    // into one message on purpose. Explaining precisely why a forgery failed is free
    // feedback for whoever is iterating on forgeries.
    return res.status(401).json({ message: 'Invalid token' });
  }
};
