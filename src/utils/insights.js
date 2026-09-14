exports.suggestBudget = (transactions) =>{
    const expenses = transactions.filter(t=>t.type==='expense').map(t=>t.amount);
    const avgExpense = expenses.reduce((a,b)=>a+b,0)/expenses.length||0;
    return `Budget suggested is :${avgExpense*1.1}`;
};