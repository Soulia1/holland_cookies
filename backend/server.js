import path from 'node:path';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import express from 'express';
import compression from 'compression';
import cookieParser from 'cookie-parser';
import cors from 'cors';
import helmet from 'helmet';
import 'dotenv/config';
import * as db from './db.js';
import menuRoute from './routes/menu.js';
import ordersRoute from './routes/orders.js';
import adminRoute from './routes/admin.js';
import accountRoute from './routes/account.js';
import { validateEnvironment } from './config.js';
import { limit, originGuard, requestContext, logEvent } from './security.js';
import { validateEnvelope, rejectDangerousKeys } from './validation.js';

validateEnvironment();
const here=path.dirname(fileURLToPath(import.meta.url));
const dist=path.join(here,'..','dist');
const dashboardDist=path.join(here,'..','dist-dashboard');
const app=express();
app.disable('x-powered-by');
app.set('query parser','simple');
// CIDRs, never a hop count: directly connected clients cannot spoof an IP.
app.set('trust proxy',(process.env.TRUSTED_PROXY_CIDRS||'').split(',').map(v=>v.trim()).filter(Boolean));
app.use(requestContext);
app.use(compression());
const hashes=[];
for(const directory of [dist,dashboardDist]){
  const file=path.join(directory,'index.html');
  if(fs.existsSync(file))for(const match of fs.readFileSync(file,'utf8').matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)){
    hashes.push("'sha256-"+createHash('sha256').update(match[1]).digest('base64')+"'");
  }
}
app.use(helmet({contentSecurityPolicy:{directives:{
  defaultSrc:["'self'"],scriptSrc:["'self'",...hashes],scriptSrcAttr:["'none'"],
  styleSrc:["'self'","'unsafe-inline'",'https://fonts.googleapis.com'],
  fontSrc:["'self'",'https://fonts.gstatic.com'],imgSrc:["'self'"],
  connectSrc:["'self'"],frameSrc:["'none'"],frameAncestors:["'none'"],objectSrc:["'none'"],baseUri:["'none'"],formAction:["'self'"],
  ...(process.env.NODE_ENV==='production'?{}:{upgradeInsecureRequests:null}),
}},strictTransportSecurity:process.env.NODE_ENV==='production'?{maxAge:31536000}:false,referrerPolicy:{policy:'no-referrer'},crossOriginEmbedderPolicy:false}));
const allowedOrigins=process.env.NODE_ENV==='production'?[]:(process.env.ALLOWED_ORIGINS||'').split(',').filter(Boolean);
app.use(cors({origin:allowedOrigins.length?allowedOrigins:false,credentials:true,methods:['GET','POST','PATCH','DELETE'],allowedHeaders:['Content-Type','X-Requested-With']}));
app.use('/api',(_req,res,next)=>{res.set('Cache-Control','no-store');next();});
app.use('/api',limit('public',60000,300));
app.post('/api/admin/session',limit('login',15*60000,10));
app.post('/api/orders',limit('checkout',10*60000,20));
app.use('/api/orders/track',limit('tracking',15*60000,20));
app.post('/api/admin/promos/validate',limit('coupon',15*60000,20));
app.use(['/api/orders/stats','/api/admin/users'],limit('report',60000,60));
const writeLimit=limit('admin-write',60000,60);
app.use(['/api/admin','/api/menu/admin','/api/orders'],(req,res,next)=>['PATCH','DELETE'].includes(req.method) || (req.method==='POST' && req.originalUrl.startsWith('/api/menu/admin'))?writeLimit(req,res,next):next());
app.use('/api',originGuard);
app.use('/api',(req,res,next)=>{
  if(!['GET','HEAD','POST','PATCH','DELETE','OPTIONS'].includes(req.method))return res.status(405).json({error:'METHOD_NOT_ALLOWED',message:'Method not allowed.'});
  if(req.get('content-encoding') && req.get('content-encoding')!=='identity')return res.status(415).json({error:'UNSUPPORTED_ENCODING',message:'Compressed request bodies are not supported.'});
  if((req.get('content-length') && req.get('content-length')!=='0' || req.get('transfer-encoding')) && !req.is('application/json'))return res.status(415).json({error:'UNSUPPORTED_MEDIA_TYPE',message:'Use application/json.'});
  next();
});
app.use('/api',validateEnvelope);
app.use(express.json({limit:'32kb',strict:true,inflate:false}));
app.use(rejectDangerousKeys);
app.use(cookieParser());
app.get('/api/health',(_req,res)=>res.json({ok:true}));
app.get('/api/ready',(_req,res)=>{try{db.get().prepare('SELECT 1').get();res.json({ok:true});}catch{res.status(503).json({ok:false});}});
app.use('/api/menu',menuRoute);app.use('/api/orders',ordersRoute);app.use('/api/admin',adminRoute);app.use('/api/account',accountRoute);
app.use('/api',(_req,res)=>res.status(404).json({error:'NOT_FOUND',message:'No such endpoint.'}));
const staticOptions={dotfiles:'deny',index:false,setHeaders(res,file){res.set('Cache-Control',/[\/]assets[\/].+-[A-Za-z0-9_-]{8,}\.(js|css)$/.test(file)?'public, max-age=31536000, immutable':'no-cache');}};
app.use('/dashboard',express.static(dashboardDist,staticOptions));app.use(express.static(dist,staticOptions));
app.get(['/dashboard','/dashboard/','/dashboard/orders','/dashboard/orders/:id','/dashboard/menu','/dashboard/users','/dashboard/promos','/dashboard/settings'],(_req,res)=>{res.set('Cache-Control','no-cache');res.sendFile(path.join(dashboardDist,'index.html'));});
// `/menu/:slug` is not decoration: the menu is a page per group, so `/menu/cookies`
// is what every "Menu" link on the site produces, and `/menu/<category>` is the
// older per-category address App.tsx still accepts and redirects. Listing only
// `/menu` served those addresses to nobody — in-app they are pushState, which
// never asks the server, so the 404 appeared only on a refresh, a bookmark, a
// shared link or a crawler. Clicking through the site cannot reveal it, which is
// why the dashboard's parameterised routes above were remembered and this was not.
app.get(['/','/menu','/menu/:slug','/checkout','/account','/track'],(_req,res)=>{res.set('Cache-Control','no-cache');res.sendFile(path.join(dist,'index.html'));});
app.use((_req,res)=>res.status(404).type('text').send('Not found.'));
app.use((error,req,res,_next)=>{
  logEvent('request_error',req,{code:typeof error.code==='string'?error.code.slice(0,64):'INTERNAL'});
  const status=error.type==='entity.too.large'?413:error.type==='entity.parse.failed' || error instanceof URIError?400:error.code?.startsWith('SQLITE')?503:500;
  res.status(status).json({error:status===413?'PAYLOAD_TOO_LARGE':status===400?'INVALID':status===503?'UNAVAILABLE':'SERVER_ERROR',message:status===400?'Invalid request.':status===413?'Request is too large.':'Service temporarily unavailable.'});
});
async function boot(){
  db.get();
  // Seeding is a separate explicit operation; boot never creates production content.
  const server=app.listen(Number(process.env.PORT)||3000,process.env.HOST || '0.0.0.0',()=>console.info(JSON.stringify({event:'started',version:process.env.RELEASE_SHA || 'local'})));
  server.requestTimeout=15000;server.headersTimeout=10000;server.keepAliveTimeout=5000;server.maxRequestsPerSocket=100;
  const stop=()=>{server.close(()=>{db.close();process.exit(0);});setTimeout(()=>process.exit(1),10000).unref();};
  process.once('SIGTERM',stop);process.once('SIGINT',stop);
}
if(process.env.NODE_ENV!=='test')boot().catch(()=>{console.error('Startup failed; check configuration and storage.');process.exit(1);});
export default app;
