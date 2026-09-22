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
import * as db from './firestore.js';
import { isDatastoreOutage } from './firestore.js';
import menuRoute from './routes/menu.js';
import ordersRoute from './routes/orders.js';
import adminRoute from './routes/admin.js';
import imagesRoute from './routes/images.js';
import accountRoute from './routes/account.js';
import { validateEnvironment, adminHostname } from './config.js';
import { limit, originGuard, requestContext, logEvent } from './security.js';
import { validateEnvelope, rejectDangerousKeys } from './validation.js';

validateEnvironment();
const here=path.dirname(fileURLToPath(import.meta.url));
const dist=path.join(here,'..','dist');
const dashboardDist=path.join(here,'..','dist-dashboard');
// The dashboard is served only on this host, at its root; every other host is the shop.
const ADMIN_HOSTNAME=adminHostname();
const isAdminHost=(req)=>req.hostname===ADMIN_HOSTNAME;
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
    // HTML parsers normalise CRLF to LF before checking an inline-script hash.
    // Hashing the raw Windows build therefore produced a different value and
    // blocked this script under our own CSP, while the same build worked on
    // Linux. Hash the text the browser actually executes.
    const script=match[1].replace(/\r\n?/g,'\n');
    hashes.push("'sha256-"+createHash('sha256').update(script).digest('base64')+"'");
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
const publicReadLimit=limit('public',60000,300);
app.use('/api',(req,res,next)=>{
  // Protected routes have purpose-built limits below. Counting their reads
  // against the catalogue budget could lock a signed-in administrator out of
  // the dashboard during a normal editing session, while adding no protection
  // to the public menu. Login, checkout, tracking, reporting and mutations all
  // retain their stricter independent limits.
  // Two unauthenticated reads live under /admin and stay on the public budget:
  // the shop settings the storefront fetches, and the session probe. Each is a
  // Firestore read anyone can trigger, which is what this limiter is for.
  const publicUnderAdmin=req.method==='GET' && /^\/admin\/(?:settings|session)$/.test(req.path);
  if(!publicUnderAdmin && (/^\/(?:admin|orders)(?:\/|$)/.test(req.path) || /^\/menu\/admin(?:\/|$)/.test(req.path)))return next();
  return publicReadLimit(req,res,next);
});
app.post('/api/admin/session',limit('login',15*60000,10));
app.post('/api/orders',limit('checkout',10*60000,20));
app.use('/api/orders/track',limit('tracking',15*60000,20));
app.post('/api/admin/promos/validate',limit('coupon',15*60000,20));
app.use(['/api/orders/stats','/api/admin/users'],limit('report',60000,60));
const writeLimit=limit('admin-write',60000,60);
app.use(['/api/admin','/api/menu/admin','/api/orders'],(req,res,next)=>['PATCH','DELETE'].includes(req.method) || (req.method==='POST' && (req.originalUrl.startsWith('/api/menu/admin') || req.originalUrl.startsWith('/api/admin/images')))?writeLimit(req,res,next):next());
app.use('/api',originGuard);
app.use('/api',(req,res,next)=>{
  if(!['GET','HEAD','POST','PATCH','DELETE','OPTIONS'].includes(req.method))return res.status(405).json({error:'METHOD_NOT_ALLOWED',message:'Method not allowed.'});
  if(req.get('content-encoding') && req.get('content-encoding')!=='identity')return res.status(415).json({error:'UNSUPPORTED_ENCODING',message:'Compressed request bodies are not supported.'});
  if((req.get('content-length') && req.get('content-length')!=='0' || req.get('transfer-encoding')) && !req.is('application/json'))return res.status(415).json({error:'UNSUPPORTED_MEDIA_TYPE',message:'Use application/json.'});
  next();
});
app.use('/api',validateEnvelope);
// A shrunk product photo is a few hundred KiB of base64; every other body stays at 32 KiB.
app.use('/api/admin/images',express.json({limit:'1100kb',strict:true,inflate:false}));
app.use(express.json({limit:'32kb',strict:true,inflate:false}));
app.use(rejectDangerousKeys);
app.use(cookieParser());
app.get('/api/health',(_req,res)=>res.json({ok:true}));
app.get('/api/ready',async(_req,res)=>{
  // A real round trip to Firestore, not just "is the module loaded": the point
  // of a readiness probe is to fail the instance out of the load balancer when
  // the database is unreachable, and a check that cannot fail cannot do that.
  try{await db.get().collection('_health').doc('probe').get();res.json({ok:true});}
  catch{res.status(503).json({ok:false});}
});
app.use('/api',imagesRoute);app.use('/api/menu',menuRoute);app.use('/api/orders',ordersRoute);app.use('/api/admin',adminRoute);app.use('/api/account',accountRoute);
app.use('/api',(_req,res)=>res.status(404).json({error:'NOT_FOUND',message:'No such endpoint.'}));
const staticOptions={dotfiles:'deny',index:false,setHeaders(res,file){res.set('Cache-Control',/[\\/]assets[\\/].+-[A-Za-z0-9_-]{8,}\.(js|css)$/.test(file)?'public, max-age=31536000, immutable':'no-cache');}};
// Old bookmarks: the dashboard used to live under /dashboard on the shop's host.
app.use('/dashboard',(req,res,next)=>{
  if(isAdminHost(req))return next();
  const rest=req.originalUrl.slice('/dashboard'.length);
  // req.protocol reads "http" behind the edge unless its CIDRs are trusted.
  const production=process.env.NODE_ENV==='production';
  const scheme=production?'https':req.protocol;
  const port=production?'':(/:\d+$/.exec(req.get('host')||'')?.[0]||'');
  res.redirect(301,`${scheme}://${ADMIN_HOSTNAME}${port}${rest.startsWith('/')?rest:`/${rest}`}`);
});
// Product placeholders and the logo live in the shop's build; the dashboard shows them too.
app.use('/img',express.static(path.join(dist,'img'),staticOptions));
const serveDashboard=express.static(dashboardDist,staticOptions);const serveShop=express.static(dist,staticOptions);
app.use((req,res,next)=>(isAdminHost(req)?serveDashboard:serveShop)(req,res,next));
app.get(['/','/orders','/orders/:id','/menu','/users','/promos','/settings'],(req,res,next)=>{
  if(!isAdminHost(req))return next();
  res.set('Cache-Control','no-cache');res.sendFile(path.join(dashboardDist,'index.html'));
});
// `/menu/:slug` is not decoration: the menu is a page per group, so `/menu/cookies`
// is what every "Menu" link on the site produces, and `/menu/<category>` is the
// older per-category address App.tsx still accepts and redirects. Listing only
// `/menu` served those addresses to nobody — in-app they are pushState, which
// never asks the server, so the 404 appeared only on a refresh, a bookmark, a
// shared link or a crawler. Clicking through the site cannot reveal it, which is
// why the dashboard's parameterised routes above were remembered and this was not.
app.get(['/','/menu','/menu/:slug','/checkout','/account','/track'],(req,res,next)=>{
  if(isAdminHost(req))return next();
  res.set('Cache-Control','no-cache');res.sendFile(path.join(dist,'index.html'));
});
app.use((_req,res)=>res.status(404).type('text').send('Not found.'));
app.use((error,req,res,_next)=>{
  logEvent('request_error',req,{code:typeof error.code==='string'?error.code.slice(0,64):'INTERNAL'});
  const status=error.type==='entity.too.large'?413:error.type==='entity.parse.failed' || error instanceof URIError?400:isDatastoreOutage(error)?503:500;
  res.status(status).json({error:status===413?'PAYLOAD_TOO_LARGE':status===400?'INVALID':status===503?'UNAVAILABLE':'SERVER_ERROR',message:status===400?'Invalid request.':status===413?'Request is too large.':'Service temporarily unavailable.'});
});
async function boot(){
  db.get();
  console.info(JSON.stringify({event:'datastore',target:db.currentTarget()}));
  // Seeding is a separate explicit operation; boot never creates production content.
  const server=app.listen(Number(process.env.PORT)||3000,process.env.HOST || '0.0.0.0',()=>console.info(JSON.stringify({event:'started',version:process.env.RELEASE_SHA || 'local'})));
  server.requestTimeout=15000;server.headersTimeout=10000;server.keepAliveTimeout=5000;server.maxRequestsPerSocket=100;
  const stop=()=>{server.close(async()=>{await db.close().catch(()=>{});process.exit(0);});setTimeout(()=>process.exit(1),10000).unref();};
  process.once('SIGTERM',stop);process.once('SIGINT',stop);
}
// A boot failure is read by whoever is starting the server, not by a visitor,
// and the process is about to die — so it says what is actually wrong. The old
// message was "Startup failed; check configuration and storage.", which is true
// of every possible cause and useful for none of them: the commonest one by far
// is simply that no datastore is configured, and the message did not say so.
if (process.env.NODE_ENV !== 'test') {
  boot().catch((error) => {
    console.error(`
Holland Cookies could not start.

  ${error.message}
`);
    if (!process.env.FIRESTORE_EMULATOR_HOST && process.env.NODE_ENV !== 'production') {
      console.error(`  This server now uses Cloud Firestore, not a local SQLite file.
  For local development, start the emulator in another terminal:

      npm run emulators

  then point this process at it:

      FIRESTORE_EMULATOR_HOST=127.0.0.1:8080 npm start

  and seed it once with:  npm run seed
`);
    }
    process.exit(1);
  });
}
export default app;
