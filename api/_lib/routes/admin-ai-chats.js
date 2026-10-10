import { adminDb, requireAdmin } from '../firebase-admin.js';
import { methodNotAllowed, clientError } from '../http.js';
const iso=v=>v?.toDate?v.toDate().toISOString():v||null;
export default async function adminAIChats(req,res){
 await requireAdmin(req);
 if(req.method==='GET'){
  const id=typeof req.query?.id==='string'?req.query.id:'';
  if(id){if(!/^[a-zA-Z0-9_-]{12,80}$/.test(id))throw clientError('Conversation not found.',404);const ref=adminDb.collection('aiConversations').doc(id),snap=await ref.get();if(!snap.exists)throw clientError('Conversation not found.',404);const messages=await ref.collection('messages').orderBy('createdAt','asc').limit(200).get();return res.json({conversation:{id:snap.id,...snap.data(),createdAt:iso(snap.data().createdAt),updatedAt:iso(snap.data().updatedAt)},messages:messages.docs.map(d=>({id:d.id,...d.data(),createdAt:iso(d.data().createdAt)}))});}
  const snap=await adminDb.collection('aiConversations').orderBy('updatedAt','desc').limit(100).get();return res.json({conversations:snap.docs.map(d=>({id:d.id,...d.data(),createdAt:iso(d.data().createdAt),updatedAt:iso(d.data().updatedAt)}))});
 }
 if(req.method==='PATCH'){const id=req.body?.id,status=req.body?.status;if(typeof id!=='string'||!['OPEN','NEEDS_SUPPORT','IN_PROGRESS','RESOLVED','CLOSED'].includes(status))throw clientError('Choose a valid conversation status.');const ref=adminDb.collection('aiConversations').doc(id),snap=await ref.get();if(!snap.exists)throw clientError('Conversation not found.',404);await ref.update({status,updatedAt:FieldValue.serverTimestamp(),agentJoined:status==='IN_PROGRESS'});return res.json({ok:true});}
 if(req.method==='POST'){
  const {id,message}=req.body||{};
  if(typeof id!=='string'||!/^[a-zA-Z0-9_-]{12,80}$/.test(id)||typeof message!=='string'||!message.trim()||message.length>4000)throw clientError('Enter a valid reply.');
  const ref=adminDb.collection('aiConversations').doc(id),snap=await ref.get();if(!snap.exists)throw clientError('Conversation not found.',404);
  if(['CLOSED','RESOLVED'].includes(snap.data().status))throw clientError('Reopen this conversation before replying.',409);
  const content=message.trim();
  await ref.collection('messages').add({role:'admin',content,adminId:admin.uid,adminName:admin.displayName||admin.email||'HerStep Support',createdAt:FieldValue.serverTimestamp()});
  await ref.update({status:'IN_PROGRESS',agentJoined:true,assignedAdminId:admin.uid,assignedAdminName:admin.displayName||admin.email||'HerStep Support',lastMessage:content,messageCount:FieldValue.increment(1),updatedAt:FieldValue.serverTimestamp()});
  return res.status(201).json({ok:true});
 }
 return methodNotAllowed(res,['GET','PATCH','POST']);
}