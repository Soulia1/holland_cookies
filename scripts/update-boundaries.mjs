import fs from 'node:fs';
for(const name of ['account','admin','menu','orders']){
  const file=`backend/routes/${name}.js`;
  let source=fs.readFileSync(file,'utf8').replaceAll('z.object(', 'z.strictObject(');
  source=source.replace('const router = Router();', 'const router = Router();\nvalidateParams(router);');
  source="import { validateParams, amount, imagePath, identifier, email as emailSchema } from '../validation.js';\n"+source;
  source=source.replaceAll('z.number().nonnegative()', 'amount');
  fs.writeFileSync(file,source);
}
const file='backend/customerAuth.js';
const source=fs.readFileSync(file,'utf8');
const tail=source.slice(source.indexOf('export function claimProfile'));
fs.writeFileSync(file,`import * as db from './db.js';
import { createSession, readStoredSession, revokeSession, cookieOptions } from './sessionStore.js';
const SESSION_COOKIE='holland_customer_session';
const TTL=30*24*60*60;
export function issueCustomerSession(res,{profileId}){
  const token=createSession('customer',profileId,TTL);
  res.cookie(SESSION_COOKIE,token,cookieOptions(TTL));return token;
}
export function clearCustomerSession(res,req){
  revokeSession(req?.cookies?.[SESSION_COOKIE]);
  res.clearCookie(SESSION_COOKIE,cookieOptions(0));
}
export function readCustomer(req){
  const session=readStoredSession(req.cookies?.[SESSION_COOKIE],'customer');
  if(!session)return null;
  const profile=db.get().prepare('SELECT * FROM profiles WHERE id = ?').get(Number(session.subject));
  return profile?{id:profile.id,email:profile.email,fullName:profile.full_name,phone:profile.phone,defaultArea:profile.default_area,defaultAddress:profile.default_address}:null;
}
export function requireCustomer(req,res,next){
  const customer=readCustomer(req);
  if(!customer)return res.status(401).json({error:'UNAUTHORIZED',message:'Sign in to see this.'});
  req.customer=customer;next();
}
${tail}`);
fs.writeFileSync('backend/adminSession.js',`import { createHash, timingSafeEqual } from 'node:crypto';
import { createSession, readStoredSession, revokeSession, cookieOptions } from './sessionStore.js';
import { logEvent } from './security.js';
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
  req.admin=session;next();
}
export { SESSION_COOKIE };
`);
