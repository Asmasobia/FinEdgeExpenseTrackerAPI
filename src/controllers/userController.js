const userService = require('../services/userService');

exports.registerUser = async (req, res, next) => {
  try {
    const result = await userService.registerUser(req.body);
    res.status(201).json({ message: 'User registered', ...result });
  } catch (error) {
    next(error);
  }
};

exports.loginUser = async (req, res, next) => {
  try {
    const result = await userService.loginUser(req.body);
    res.status(200).json(result);
  } catch (error) {
    next(error);
  }
};