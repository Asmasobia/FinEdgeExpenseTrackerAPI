const userService = require('../services/userService');

/**
 * Both handlers pass `req.validated` rather than `req.body`, for the same whitelisting reason as
 * the transaction controller: only the fields the validator recognised get through. It matters
 * here in a specific way — `registerUser` builds the stored user object, so handing it the raw
 * body would let a request add its own keys to a user record.
 */

exports.registerUser = async (req, res, next) => {
  try {
    const result = await userService.registerUser(req.validated);
    res.status(201).json({ message: 'User registered', ...result });
  } catch (error) {
    next(error);
  }
};

exports.loginUser = async (req, res, next) => {
  try {
    const result = await userService.loginUser(req.validated);
    res.status(200).json(result);
  } catch (error) {
    next(error);
  }
};
