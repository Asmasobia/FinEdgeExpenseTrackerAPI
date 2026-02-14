exports.calculateSummary =(transactions) =>{
    let totalExpense=0, totalIncome=0;
    transactions.forEach(t=>{
        if(t.type==='income') totalIncome+=t.amount;
        else totalExpense+=t.amount;
    });
    return {totalExpense,totalIncome, balance :totalIncome-totalExpense};
}