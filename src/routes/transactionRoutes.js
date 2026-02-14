const express = require('express');
const {
    addTransaction,
    getAllTransactions,
    getTransactionById,
    updateTransaction,
    deleteTransaction,
} = require('../controllers/transactionController');
const validator = require('../middleware/validator');
const router = express.Router();

router.post('/', validator.validateTransaction, addTransaction);
router.get('/', getAllTransactions);
router.get('/:id', getTransactionById);
router.patch('/:id', validator.validateTransaction, updateTransaction);
router.delete('/:id', deleteTransaction);

module.exports = router;