import { adminDb } from '../firebase-admin.js';
import { methodNotAllowed } from '../http.js';

function serialize(value) { if (value?.toDate) return value.toDate().toISOString(); if (Array.isArray(value)) return value.map(serialize); if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k,v]) => [k,serialize(v)])); return value; }
function docData(doc) { return serialize({ id: doc.id, ...doc.data() }); }
export async function listProducts(req, res) { if (req.method !== 'GET') return methodNotAllowed(res, 'GET'); let query=adminDb.collection('products').where('status','==','ACTIVE'); const category=Array.isArray(req.query.category)?req.query.category[0]:req.query.category; if(typeof category==='string'&&category) query=query.where('categoryId','==',category); const snapshot=await query.orderBy('createdAt','desc').get(); return res.status(200).json(snapshot.docs.map(docData)); }
export async function productDetail(req,res) { if(req.method!=='GET') return methodNotAllowed(res,'GET'); const id=Array.isArray(req.query.id)?req.query.id[0]:req.query.id; const product=await adminDb.collection('products').doc(id).get(); if(!product.exists||product.data().status!=='ACTIVE') return res.status(404).json({error:'Product not found.'}); return res.status(200).json(docData(product)); }
export async function listCategories(req,res) { if(req.method!=='GET') return methodNotAllowed(res,'GET'); const snapshot=await adminDb.collection('categories').orderBy('name').get(); return res.status(200).json(snapshot.docs.map(docData)); }
