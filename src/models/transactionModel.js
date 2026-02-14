const fs =require('fs/promises');
const path = require('path');
const transactionsFilePath = path.join(__dirname,'../data/transactions.json');

async function ensureFile(){
    try{
        await fs.access(transactionsFilePath);
    }catch{
        await fs.mkdir(path.dirname(transactionsFilePath),{recursive:true});
        await fs.writeFile(transactionFilePath,'[]');
    }
};
async function readTransactions(){
    await ensureFile();
    const data = await fs.readFile(transactionsFilePath,'utf-8');
    return JSON.parse(data);
};
async function writeTransactions(transactions){
    await ensureFile();
    await fs.writeFile(transactionsFilePath,JSON.stringify(transactions,null,2));
};
exports.getAll = async()=>readTransactions();
exports.findById = async(id)=> (await readTransactions()).find(t=>t.id===id);
exports.create = async(transaction)=>{
    const transactions = await readTransactions();
    transactions.push(transaction);
    await writeTransactions(transactions);
    return transaction;
};
exports.update = async(id,data)=>{
    const transactions=await readTransactions();
    const index = transactions.findIndex(t=>t.id===id);
    if (index===-1) return null;
    transactions[index]={...transactions[index],...data};
    await writeTransactions(transactions);
    return transactions[index];
};

exports.readFile = async(id)=>{
    const transactions= await readTransactions();
    const filtered = transactions.filter(t=>t.id===id);
    if(filtered.length===0) return null;
    await writeTransactions(filtered);
    return true;
};