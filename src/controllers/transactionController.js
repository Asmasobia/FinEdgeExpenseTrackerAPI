/**
 * HTTP layer for transactions: read the request, call the service, choose a status code.
 *
 * Every handler here now reads `req.user.userId` and passes it as the first argument. That
 * property is set by `requireAuth` (src/middleware/auth.js) and by nothing else — it is not
 * read from the body, a query string or a header the client controls. If `requireAuth` is
 * ever left off a route, `req.user` is undefined and the handler throws on property access
 * rather than quietly serving unscoped data: the mistake is loud, at the first request, in
 * development.
 *
 * Writes persist `req.validated`, never `req.body`. `req.validated` is the whitelisted,
 * normalised object the validator built from known fields only; `req.body` is whatever the
 * client sent. Storing the raw body let a client add arbitrary keys to a stored row (mass
 * assignment). The same reasoning as `req.user`: read from the property some trusted middleware
 * produced, not from the one the client controls — and here, as there, a route that forgets its
 * middleware fails loudly, because `req.validated` is undefined and the model's ownerId/field
 * guards reject it.
 */

const { NotFoundError } = require('../errors');
const transactionService = require('../services/transactionService');

exports.addTransaction = async (req, res, next) => {
  try {
    // Note the shape: `(ownerId, body)`. The owner is a separate argument rather than
    // something merged into the body, so there is no moment where trusted identity and
    // untrusted input live in the same object and the code has to remember which key came
    // from where.
    const transaction = await transactionService.addTransaction(req.user.userId, req.validated);
    res.status(201).json(transaction);
  } catch (error) {
    next(error);
  }
};

exports.getAllTransactions = async (req, res, next) => {
  try {
    const transactions = await transactionService.getAllTransactions(req.user.userId);
    res.status(200).json(transactions);
  } catch (error) {
    next(error);
  }
};

exports.getTransactionById = async (req, res, next) => {
  try {
    const transaction = await transactionService.getTransactionById(req.user.userId, req.params.id);
    // 404 here means one of two things — no such transaction, or one that exists but is not
    // this caller's. Deliberately indistinguishable; see `findByIdForOwner` in the model for
    // why telling them apart would let a caller enumerate other users' record ids.
    if (!transaction) return next(new NotFoundError('Transaction not found'));
    res.status(200).json(transaction);
  } catch (error) {
    next(error);
  }
};

exports.updateTransaction = async (req, res, next) => {
  try {
    const transaction = await transactionService.updateTransaction(req.user.userId, req.params.id, req.validated);
    if (!transaction) return next(new NotFoundError('Transaction not found'));
    res.status(200).json(transaction);
  } catch (error) {
    next(error);
  }
};

exports.deleteTransaction = async (req, res, next) => {
  try {
    // Was `re.params.id` — a typo for `req`, and an undefined identifier, so every
    // DELETE threw `ReferenceError: re is not defined` before reaching the service.
    // Two independent faults sat on this one path: this, and a model function that
    // did not exist under the name the service called.
    const deleted = await transactionService.deleteTransaction(req.user.userId, req.params.id);
    if (!deleted) return next(new NotFoundError('Transaction not found'));
    res.status(200).json({ message: 'Transaction deleted' });
  } catch (error) {
    next(error);
  }
};

/**
 * Income/expense totals for the caller.
 *
 * New handler: the service function existed and was documented in the README, but no route
 * or controller ever reached it.
 */
exports.getSummary = async (req, res, next) => {
  try {
    const summary = await transactionService.getSummary(req.user.userId);
    res.status(200).json(summary);
  } catch (error) {
    next(error);
  }
};

/**
 * Budget suggestion for the caller.
 *
 * 200 even when there is not enough data to suggest anything. "I looked, and here is why there is no
 * figure" is a successful answer to the question that was asked — the request was valid and the
 * server did its job. A 404 would imply the endpoint or the resource does not exist, and a 204 would
 * discard the explanation the client needs in order to say something useful to the user. The
 * `basis` field in the body is what distinguishes the cases.
 */
exports.getInsights = async (req, res, next) => {
  try {
    const suggestion = await transactionService.getInsights(req.user.userId);
    res.status(200).json(suggestion);
  } catch (error) {
    next(error);
  }
};
