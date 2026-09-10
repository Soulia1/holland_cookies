import { createHash, timingSafeEqual } from 'node:crypto';
import { createSession, readStoredSession, revokeSession, cookieOptions } from './sessionStore.js';
import { logEvent } from './security.js';
import * as db from './db.js';
const SESSION_COOKIE='holland_admin_session';
const TTL=12*60*60;
const digest=value=>createHash('sha256').update(value).digest();
export function matchesMasterKey(supplied){
  const configured=process.env.ADMIN_KEY;
  return typeof supplied==='string' && supplied.length<=200 && !!configured && timingSafeEqual(digest(supplied),digest(configured));
}
export function issueSession(res){
  const token=createSession('admin','admin',TTL);
  res.cookie(SESSION_COOKIE,token,{...cookieOptions(TTL),sameSite:'strict'});return token;
}
export function clearSession(res,req){
  revokeSession(req?.cookies?.[SESSION_COOKIE]);
  res.clearCookie(SESSION_COOKIE,{...cookieOptions(0),sameSite:'strict'});
}
export function readSession(req){
  const session=readStoredSession(req.cookies?.[SESSION_COOKIE],'admin');
  return session?{subject:'admin'}:null;
}
export function requireAdmin(req,res,next){
  const session=readSession(req);
  if(!session){logEvent('authorization_denied',req,{role:'admin'});return res.status(401).json({error:'UNAUTHORIZED',message:'Admin sign-in required.'});}
  req.admin=session;
  if(!['GET','HEAD'].includes(req.method)){
    // Record intent before mutation. Successful status changes also append
    // their own event atomically with status/history.
    const database = db.get();
    database.prepare('INSERT INTO audit_events(actor,action,resource,request_id) VALUES(?,?,?,?)')
      .run('admin',req.method+':attempt',req.route?.path || 'admin',req.requestId || '');
    res.on('finish',()=>logEvent('admin_write',req,{method:req.method,status:res.statusCode}));
  }
  next();
}
export { SESSION_COOKIE };
