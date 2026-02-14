const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const UserModel = require('../models/userModel');
const crypto = require('crypto');

exports.registerUser = async({username, email, password})=>{
    if(!username || !email || !password) throw new Error('All fields are required');
    const existing = await UserModel.findByEmail(email);
    if (existing) throw new Error('Email exists');
    const hashedPassword=await bcrypt.hash(password,10);
    const newUser = {id: crypto.randomUUID(), username, email, password:hashedPassword,createdAt: new Date().toISOString()};
    await UserModel.create(newUser);
    return {userId: newUser.id};
};

exports.loginUser = async({email,password})=>{
    if(!email||!password) throw new Error('Email and Password are required');
    const user = await UserModel.findByEmail(email); 
    if (!user|| !(await bcrypt.compare(password,user.password))) throw new Error('Invalid credentials');
    const token = jwt.sign({userId: user.id}, process.env.JWT_SECRET, {expiresIn:'1h'});
    return {token, userId: user.id};
};