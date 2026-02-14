const transactionModel = require('../models/transactionModel');
const aiHelper= require('../utils/aiHelper');
const analytics= require('../utils/analytics');

exports.addTransaction = async (data) => {
    const transaction = {id:Date.toISOString(),...data};
    await transactionModel.create(transaction);
    return transaction;
};

exports.getAllTransactions = async()=>{
    return await transactionModel.getAll();
};

exports.getTransactionById = async(id)=>{
    return await transactionModel.findById(id);
};

exports.updateTransaction = async(id,data)=>{
    return await transactionModel.update(id,data);
};

exports.deleteTransaction = async(id)=>{
    return await transactionModel.delete(id);
};

exports.getSummary = async()=>{
    const transactions = await transactionModel.getAll();
    return analytics.generateSummary(transactions);
};