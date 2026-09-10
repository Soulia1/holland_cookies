import { createHmac, randomUUID } from 'node:crypto';
import { rateLimit, ipKeyGenerator } from 'express-rate-limit';
import * as db from './db.js';

// Durable counters for the explicitly single-instance SQLite deployment.
// Each namespace is independent. Multi-host deployments require Redis/Postgres.
export class SqliteRateStore {
  localKeys=false;
  constructor(namespace){this.namespace=namespace;this.prefix=`${namespace}:`;this.lastCleanup=0;}
  init(options){this.windowMs=options.windowMs;}
  key(key){return createHmac('sha256',process.env.JWT_SECRET || 'local-limiter').update(`${this.namespace}:${key}`).digest('hex');}
  async increment(key){
    const now=Date.now(), database=db.get();
    if(now-this.lastCleanup>60000){database.prepare('DELETE FROM rate_limits WHERE reset_at <= ?').run(now);this.lastCleanup=now;}
    const row=database.prepare(`INSERT INTO rate_limits (key,hits,reset_at) VALUES (?,1,?)
      ON CONFLICT(key) DO UPDATE SET hits=CASE WHEN reset_at<=? THEN 1 ELSE hits+1 END,
      reset_at=CASE WHEN reset_at<=? THEN excluded.reset_at ELSE reset_at END RETURNING hits,reset_at`)
      .get(this.key(key),now+this.windowMs,now,now);
    return {totalHits:row.hits,resetTime:new Date(row.reset_at)};
  }
  async decrement(key){db.get().prepare('UPDATE rate_limits SET hits=MAX(0,hits-1) WHERE key=?').run(this.key(key));}
  async resetKey(key){db.get().prepare('DELETE FROM rate_limits WHERE key=?').run(this.key(key));}
}
export function limit(namespace,windowMs,max){
  return rateLimit({windowMs,limit:max,store:new SqliteRateStore(namespace),standardHeaders:'draft-8',legacyHeaders:false,
    keyGenerator:req=>ipKeyGenerator(req.ip),
    handler(req,res){logEvent('rate_limited',req,{class:namespace});res.status(429).json({error:'RATE_LIMITED',message:'Too many requests. Try again later.'});}
  });
}
export function logEvent(event,req,extra={}){
  console.info(JSON.stringify({time:new Date().toISOString(),event,requestId:req?.requestId,...extra}));
}
export function requestContext(req,res,next){
  req.requestId=randomUUID();res.set('X-Request-Id',req.requestId);
  res.set('Permissions-Policy','camera=(), microphone=(), geolocation=(), payment=()');
  const start=performance.now();
  res.on('finish',()=>{if(req.originalUrl.startsWith('/api/'))logEvent('request',req,{method:req.method,route:req.route?.path || 'unmatched',status:res.statusCode,durationMs:Math.round(performance.now()-start)});});
  next();
}
export function originGuard(req,res,next){
  if(['GET','HEAD','OPTIONS'].includes(req.method))return next();
  const origin=req.get('origin');
  const expected=process.env.APP_ORIGIN || `${req.protocol}://${req.get('host')}`;
  const permitted=[expected,...(process.env.NODE_ENV==='production'?[]:(process.env.ALLOWED_ORIGINS||'').split(',').filter(Boolean))];
  const validOrigin=origin && permitted.includes(origin);
  // A custom header forces a CORS preflight for browser requests without
  // Origin. Cross-site requests are refused even when they carry the header.
  if((origin && !validOrigin) || req.get('sec-fetch-site')==='cross-site' || (!origin && req.get('x-requested-with')!=='Holland')){
    logEvent('origin_rejected',req);return res.status(403).json({error:'FORBIDDEN',message:'Request origin was not accepted.'});
  }
  next();
}
