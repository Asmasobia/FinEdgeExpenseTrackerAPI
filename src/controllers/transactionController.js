const transactionService = require('../services/transactionService');

exports.addTransaction = async(req,res,next)=>{
    try{
        const transaction = await transactionService.addTransaction(req.body);
        res.status(201).json(transaction);
    }catch(error){
        next(error);
    }
};

exports.getAllTransactions = async(req,res,next)=>{
    try{
        const transactions = await transactionService.getAllTransactions();
        res.status(200).json(transactions);

    }catch(error){
        next(error);
    }
};

exports.getTransactionById = async (req,res,next)=>{
    try{
        const transaction = await transactionService.getTransactionById(req.params.id);
        if(!transaction) return res.status(404).json({message:'Transaction not found'});
        res.status(200).json(transaction);

    }catch(error){
        next(error);
    }
};

exports.updateTransaction = async (req,res,next)=>{
    try{
        const transaction = await transactionService.updateTransaction(req.params.id,req.body);
        if(!transaction) return res.status(404).json({message:'Transaction not found'});
        res.status(200).json(transaction);
    }catch(error){
        next(error);
    }
};

exports.deleteTransaction = async (req,res,next)=>{
    try{
        // Was `re.params.id` — a typo for `req`, and an undefined identifier, so every
        // DELETE threw `ReferenceError: re is not defined` before reaching the service.
        // Two independent faults sat on this one path: this, and a model function that
        // did not exist under the name the service called.
        const deleted = await transactionService.deleteTransaction(req.params.id);
        if(!deleted) return res.status(404).json({message:'Transaction not found'});
        res.status(200).json({message:'Transaction deleted'});
    }catch(error){
        next(error);
    }
};