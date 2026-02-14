exports.validateTransaction = (req, res, next) => {
    const { type, category, amount, date } = req.body;
    if (!type || !['income', 'expense'].includes(type) || !category || !amount || !date) {
      return res.status(400).json({ message: 'Invalid transaction data' });
    }
    next();
  };