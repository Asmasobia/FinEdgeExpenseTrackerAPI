/**
 * HTTP layer for transactions: read the request, call the service, choose a status code.
 *
 * Every handler here now reads `req.user.userId` and passes it as the first argument. That
 * property is set by `requireAuth` (src/middleware/auth.js) and by nothing else — it is not
 * read from the body, a query string or a header the client controls. If `requireAuth` is
 * ever left off a route, `req.user` is undefined and the handler throws on property access
 * rather than quietly serving unscoped data: the mistake is loud, at the first request, in
 * development.
 */

const transactionService = require('../services/transactionService');

exports.addTransaction = async (req, res, next) => {
  try {
    // Note the shape: `(ownerId, body)`. The owner is a separate argument rather than
    // something merged into the body, so there is no moment where trusted identity and
    // untrusted input live in the same object and the code has to remember which key came
    // from where.
    const transaction = await transactionService.addTransaction(req.user.userId, req.body);
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
    if (!transaction) return res.status(404).json({ message: 'Transaction not found' });
    res.status(200).json(transaction);
  } catch (error) {
    next(error);
  }
};

exports.updateTransaction = async (req, res, next) => {
  try {
    const transaction = await transactionService.updateTransaction(req.user.userId, req.params.id, req.body);
    if (!transaction) return res.status(404).json({ message: 'Transaction not found' });
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
    if (!deleted) return res.status(404).json({ message: 'Transaction not found' });
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
