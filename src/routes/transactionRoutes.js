const express = require('express');

const {
  addTransaction,
  getAllTransactions,
  getTransactionById,
  updateTransaction,
  deleteTransaction,
  getSummary,
} = require('../controllers/transactionController');
const { requireAuth } = require('../middleware/auth');
const validator = require('../middleware/validator');

const router = express.Router();

/**
 * Authentication for every route in this router.
 *
 * `router.use(requireAuth)` rather than naming the middleware on each of the six routes
 * individually. Both work today; they differ in what happens next year. Listing it per
 * route means the seventh route someone adds is public unless they remember to add it, and
 * a missing auth middleware looks like nothing at all in a diff — there is no line to
 * notice the absence of. Mounting it once means every route added below this line inherits
 * it, and making a route public becomes a visible, deliberate act instead of an omission.
 *
 * Fail closed by default; require an explicit gesture to open something up.
 *
 * Before this, all five routes below had no auth of any kind. A token was issued at login
 * and never checked again, so an anonymous caller with the base URL could list, edit and
 * delete every user's transactions.
 */
router.use(requireAuth);

/**
 * ROUTE ORDER IS LOAD-BEARING HERE.
 *
 * `/summary` must be registered before `/:id`. Express matches routes in registration order
 * and takes the first hit, and `/:id` is a wildcard that happily matches the literal string
 * "summary" — so with the two lines swapped, `GET /transactions/summary` would be handled by
 * `getTransactionById` with `req.params.id === 'summary'`, find no such record, and answer
 * `404 Transaction not found`. That is a genuinely confusing bug to chase: the route is
 * registered, the handler is correct, the URL is right, and it still 404s, because a
 * different handler answered.
 *
 * The general rule: specific literal paths before parameterised ones at the same depth.
 *
 * (The README advertises this as `GET /summary`. It lives under `/transactions` instead,
 * because a summary is a derived view of the transactions collection rather than a resource
 * of its own; the README is corrected in the documentation pass rather than the route bent
 * to match a doc that describes an endpoint which never existed.)
 */
router.get('/summary', getSummary);

router.post('/', validator.validateTransaction, addTransaction);
router.get('/', getAllTransactions);
router.get('/:id', getTransactionById);
router.patch('/:id', validator.validateTransaction, updateTransaction);
router.delete('/:id', deleteTransaction);

module.exports = router;
