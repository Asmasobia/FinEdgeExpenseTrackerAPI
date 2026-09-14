const express = require('express');

const { registerUser, loginUser } = require('../controllers/userController');
const validator = require('../middleware/validator');

const router = express.Router();

/**
 * These two routes are deliberately NOT behind `requireAuth` — they are how a caller obtains a
 * token in the first place, so requiring one would make the API impossible to enter. This is the
 * "explicit gesture to open something up" that `transactionRoutes.js` refers to: publicness lives
 * in its own router, visible as the absence of `router.use(requireAuth)` at the top of a file
 * whose only two routes are registration and login, rather than hidden as a forgotten middleware
 * among a dozen protected ones.
 *
 * Both gained validation, which they had none of. Registration accepted a one-character password,
 * and because the only check lived in the service it answered 500 rather than 400.
 */
router.post('/', validator.validateRegister, registerUser);
router.post('/login', validator.validateLogin, loginUser);

module.exports = router;
