import fs from 'node:fs';
fs.writeFileSync('backend/otp.js',`import { randomBytes, randomInt, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import * as db from './db.js';
const scryptAsync=promisify(scrypt);
const CODE_TTL_MS=600000,RESEND_COOLDOWN_MS=60000,MAX_ATTEMPTS=5,MAX_PER_EMAIL_HOUR=3,MAX_PER_EMAIL_DAY=5;
let active=0;
export const normalizeEmail=value=>typeof value==='string'?value.trim().toLowerCase():'';
export const isEmail=value=>typeof value==='string' && value.length<=160 && /^[^\\s@]+@[^\\s@]+\\.[^\\s@]{2,}$/.test(value);
const wrong=()=>({ok:false,code:'INVALID_CODE',message:'That code is not right.'});
const busy=()=>({ok:false,code:'BUSY',message:'Try again shortly.',retryAfter:5});
async function derive(email,code,salt){
  return (await scryptAsync('otp:'+email+':'+code,Buffer.from(salt,'hex'),32,{N:32768,r:8,p:1,maxmem:64*1024*1024})).toString('hex');
}
export async function requestCode(rawEmail){
  const email=normalizeEmail(rawEmail);
  if(!isEmail(email))return {ok:false,code:'INVALID_EMAIL',message:'That email does not look right.'};
  if(active>=4)return busy();
  const database=db.get(), now=Date.now(), iso=new Date(now).toISOString();
  const salt=randomBytes(16).toString('hex');
  const reservation=database.transaction(()=>{
    const old=database.prepare('SELECT * FROM otp_codes WHERE email=?').get(email);
    if(old && now-Date.parse(old.last_sent_at)<RESEND_COOLDOWN_MS)return {ok:false,code:'COOLDOWN',message:'Try again shortly.',retryAfter:60};
    const hour=old && now-Date.parse(old.hour_start)<3600000?old.sent_hour:0;
    const day=old && now-Date.parse(old.day_start)<86400000?old.sent_day:0;
    if(hour>=MAX_PER_EMAIL_HOUR || day>=MAX_PER_EMAIL_DAY)return {ok:false,code:'RATE_LIMITED',message:'Try again later.',retryAfter:3600};
    database.prepare(`INSERT INTO otp_codes(email,code_hash,code_salt,expires_at,attempts,last_sent_at,sent_hour,hour_start,sent_day,day_start)
      VALUES(?,'',?,?,0,?,?,?,?,?) ON CONFLICT(email) DO UPDATE SET code_hash='',code_salt=excluded.code_salt,
      expires_at=excluded.expires_at,attempts=0,last_sent_at=excluded.last_sent_at,sent_hour=excluded.sent_hour,
      hour_start=excluded.hour_start,sent_day=excluded.sent_day,day_start=excluded.day_start`)
      .run(email,salt,new Date(now+CODE_TTL_MS).toISOString(),iso,hour+1,hour?old.hour_start:iso,day+1,day?old.day_start:iso);
    return {ok:true};
  }).immediate();
  if(!reservation.ok)return reservation;
  active++;
  try{
    const code=String(randomInt(0,1000000)).padStart(6,'0');
    const hash=await derive(email,code,salt);
    const changed=database.prepare('UPDATE otp_codes SET code_hash=? WHERE email=? AND code_salt=?').run(hash,email,salt);
    if(!changed.changes)return busy();
    return {ok:true,email,code,expiresInMs:CODE_TTL_MS};
  }finally{active--;}
}
export async function verifyCode(rawEmail,rawCode){
  const email=normalizeEmail(rawEmail);
  if(!isEmail(email) || typeof rawCode!=='string' || !/^\\d{6}$/.test(rawCode))return wrong();
  if(active>=4)return busy();
  const database=db.get();
  // Reserving an attempt is one atomic write BEFORE async KDF work. The same
  // row is retained after success/expiry so login cannot reset send quotas.
  const record=database.prepare(`UPDATE otp_codes SET attempts=attempts+1
    WHERE email=? AND attempts<? AND expires_at>? AND code_hash<>''
    RETURNING code_hash,code_salt`).get(email,MAX_ATTEMPTS,new Date().toISOString());
  if(!record)return wrong();
  active++;
  try{
    const result=Buffer.from(await derive(email,rawCode,record.code_salt),'hex');
    const expected=Buffer.from(record.code_hash,'hex');
    if(result.length!==expected.length || !timingSafeEqual(result,expected))return wrong();
    const consumed=database.prepare(`UPDATE otp_codes SET code_hash='',expires_at=? WHERE email=? AND code_salt=? AND code_hash=? AND expires_at>?`)
      .run(new Date(0).toISOString(),email,record.code_salt,record.code_hash,new Date().toISOString());
    return consumed.changes?{ok:true,email}:wrong();
  }finally{active--;}
}
export const OTP_LIMITS={CODE_TTL_MS,RESEND_COOLDOWN_MS,MAX_ATTEMPTS,MAX_PER_EMAIL_HOUR,MAX_PER_EMAIL_DAY};
`);
