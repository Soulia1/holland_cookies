import test,{before,after,beforeEach} from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
process.env.NODE_ENV='test';process.env.DATABASE_PATH=':memory:';
process.env.ADMIN_KEY='security-fixture-admin-0123456789abcdefgh';
process.env.JWT_SECRET='security-fixture-session-0123456789abcdefgh';
process.env.BREVO_API_KEY='';process.env.MAIL_TRANSPORT='disabled';process.env.DISABLE_ADMIN_AUTH='false';
const {default:app}=await import('../../backend/server.js');
const db=await import('../../backend/db.js');
const {requestCode,verifyCode}=await import('../../backend/otp.js');
const {createSession}=await import('../../backend/sessionStore.js');
const {validateEnvironment}=await import('../../backend/config.js');
const {sendMail}=await import('../../backend/mailer.js');
let server,base,admin;
const payload=(extra={})=>({idempotencyKey:randomUUID(),items:[{productId:'cookie',qty:2}],firstName:'Fixture',phone:'01000000000',fulfilment:'pickup',...extra});
async function request(route,{method='GET',body,cookie,headers={}}={}){
  const res=await fetch(base+route,{method,headers:{'x-requested-with':'Holland',...(body===undefined?{}:{'content-type':'application/json'}),...(cookie?{cookie}:{}),...headers},body:body===undefined?undefined:typeof body==='string'?body:JSON.stringify(body)});
  const raw=await res.text();let data;try{data=JSON.parse(raw);}catch{data=raw;}
  return {status:res.status,headers:res.headers,data};
}
before(async()=>{
  assert.equal(db.get().name,':memory:');
  db.get().exec("INSERT INTO categories(id,name) VALUES('cookies','Cookies'); INSERT INTO products(id,category_id,name,price) VALUES('cookie','cookies','Cookie',50)");
  server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));base=`http://127.0.0.1:${server.address().port}`;
  const login=await request('/api/admin/session',{method:'POST',body:{key:process.env.ADMIN_KEY}});
  assert.equal(login.status,200);admin=login.headers.get('set-cookie').split(';')[0];
});
beforeEach(()=>{db.get().prepare('DELETE FROM rate_limits').run();});
after(async()=>{await new Promise(r=>server.close(r));db.close();});

test('authorization: every protected function denies anonymous and customer sessions',async()=>{
  db.get().prepare('INSERT INTO profiles(email) VALUES(?)').run('matrix@example.test');
  const customer='holland_customer_session='+createSession('customer',1,3600);
  const routes=[['GET','/api/orders'],['GET','/api/orders/stats'],['GET','/api/orders/HC-1001'],['PATCH','/api/orders/HC-1001/status'],['GET','/api/admin/customers'],['GET','/api/admin/customers/01000000000'],['GET','/api/admin/users'],['GET','/api/admin/promos'],['POST','/api/admin/promos'],['PATCH','/api/admin/promos/TEST'],['DELETE','/api/admin/promos/TEST'],['PATCH','/api/admin/settings'],...['products','categories'].flatMap(kind=>[['GET',`/api/menu/admin/${kind}`],['POST',`/api/menu/admin/${kind}`],['PATCH',`/api/menu/admin/${kind}/cookie`],['DELETE',`/api/menu/admin/${kind}/cookie`]])];
  for(const [method,route] of routes)for(const cookie of [undefined,customer])assert.equal((await request(route,{method,cookie})).status,401,`${method} ${route}`);
  for(const route of ['/api/account/profile','/api/account/orders'])assert.equal((await request(route,{method:route.endsWith('profile')?'PATCH':'GET',cookie:admin})).status,401);
});
test('validation: strict fields, primitives, bounds, duplicate items, tampered financials and card are rejected',async()=>{
  for(const extra of [{role:'admin'},{total:0},{paymentStatus:'paid'},{paymentMethod:'card'},{items:[{productId:'cookie',qty:0}]},{items:[{productId:'cookie',qty:-1}]},{items:[{productId:'cookie',qty:1.5}]},{items:[{productId:'cookie',qty:51}]},{items:[{productId:'cookie',qty:1,price:0}]},{items:[{productId:'cookie',qty:1},{productId:'cookie',qty:1}]},{firstName:' '.repeat(3)},{firstName:{}},{firstName:'x'.repeat(81)},{email:['a@example.test']},{notes:'\ud800'}]){
    assert.equal((await request('/api/orders',{method:'POST',body:payload(extra)})).status,400,JSON.stringify(extra));
  }
});
test('validation: malformed JSON, dangerous keys, compressed bodies, giant input, invalid queries and paths fail safely',async()=>{
  for(const body of ['{', '{"__proto__":{"admin":true}}','[]','null'])assert.equal((await request('/api/orders',{method:'POST',body})).status,400);
  assert.equal((await request('/api/orders',{method:'POST',body:{notes:'x'.repeat(40000)}})).status,413);
  assert.equal((await request('/api/orders',{method:'POST',body:{},headers:{'content-encoding':'gzip'}})).status,415);
  for(const route of ['/api/orders?page=1&page=2','/api/orders?page=1.5','/api/orders?perPage=999','/api/orders?q='+ 'x'.repeat(101),'/api/orders?filter[$ne]=1','/api/orders/track/HC-1?phone=1&phone=2','/api/orders/stats?days=Infinity'])assert.equal((await request(route,{cookie:admin})).status,400,route);
  const sql=await request('/api/orders?'+new URLSearchParams({q:"' OR 1=1 --"}),{cookie:admin});assert.equal(sql.status,200);assert.equal(sql.data.total,0);
  assert.equal((await request('/api/menu/admin/products/..%2Fsecrets',{cookie:admin})).status,400);
});
test('csrf/cors: cross-origin and originless simple writes denied; allowed browser origin works',async()=>{
  assert.equal((await request('/api/admin/settings',{method:'PATCH',cookie:admin,body:{acceptingOrders:true},headers:{origin:'https://attacker.invalid'}})).status,403);
  assert.equal((await request('/api/admin/session',{method:'DELETE',cookie:admin,headers:{'x-requested-with':''}})).status,403);
  assert.equal((await request('/api/admin/settings',{method:'PATCH',cookie:admin,body:{acceptingOrders:true},headers:{origin:base}})).status,200);
  assert.equal((await request('/api/menu',{headers:{origin:'https://attacker.invalid'}})).headers.get('access-control-allow-origin'),null);
});
test('sessions: logout revokes copied token, cookie flags, key headers do not authorize',async()=>{
  const login=await request('/api/admin/session',{method:'POST',body:{key:process.env.ADMIN_KEY}});
  const cookie=login.headers.get('set-cookie').split(';')[0];
  assert.match(login.headers.get('set-cookie'),/HttpOnly/);assert.match(login.headers.get('set-cookie'),/SameSite=Strict/);
  assert.equal((await request('/api/admin/session',{method:'DELETE',cookie})).status,200);
  assert.equal((await request('/api/orders',{cookie})).status,401);
  assert.equal((await request('/api/orders',{headers:{'x-admin-key':process.env.ADMIN_KEY}})).status,401);
});
test('OTP: concurrent correct verifications succeed once; send quota survives consumption',async()=>{
  const email='otp-race@example.test';const issued=await requestCode(email);assert.equal(issued.ok,true);
  const results=await Promise.all(Array.from({length:8},()=>verifyCode(email,issued.code)));
  assert.equal(results.filter(r=>r.ok).length,1);
  assert.equal(db.get().prepare('SELECT sent_day FROM otp_codes WHERE email=?').get(email).sent_day,1);
  assert.equal((await requestCode(email)).code,'COOLDOWN');
});
test('OTP: concurrent issue reserves quota once; expired code and six guesses cannot authenticate',async()=>{
  const email='otp-send@example.test';const results=await Promise.all(Array.from({length:8},()=>requestCode(email)));
  assert.equal(results.filter(r=>r.ok).length,1);
  const issued=results.find(r=>r.ok);for(let i=0;i<5;i++)await verifyCode(email,issued.code==='000000'?'000001':'000000');
  assert.equal((await verifyCode(email,issued.code)).ok,false);
  const expired=await requestCode('expired@example.test');db.get().prepare('UPDATE otp_codes SET expires_at=? WHERE email=?').run(new Date(0).toISOString(),expired.email);
  assert.equal((await verifyCode(expired.email,expired.code)).ok,false);
});
test('BOLA: customer A cannot read B orders or modify identity; logout invalidates customer token',async()=>{
  const ids=['a','b'].map(n=>Number(db.get().prepare('INSERT INTO profiles(email) VALUES(?)').run(`${n}@example.test`).lastInsertRowid));
  const a='holland_customer_session='+createSession('customer',ids[0],3600),b='holland_customer_session='+createSession('customer',ids[1],3600);
  const order=await request('/api/orders',{method:'POST',body:payload()});assert.equal(order.status,201);
  db.get().prepare('UPDATE orders SET profile_id=? WHERE reference=?').run(ids[1],order.data.order.reference);
  assert.equal((await request('/api/account/orders',{cookie:a})).data.orders.length,0);
  assert.equal((await request('/api/account/orders',{cookie:b})).data.orders.length,1);
  assert.equal((await request('/api/account/profile',{method:'PATCH',cookie:a,body:{email:'b@example.test'}})).status,400);
  await request('/api/account/signout',{method:'POST',cookie:a});assert.equal((await request('/api/account/orders',{cookie:a})).status,401);
});
test('business: idempotency binds full request and concurrent checkout cannot spend a limited coupon twice',async()=>{
  const body=payload();const [a,b]=await Promise.all([request('/api/orders',{method:'POST',body}),request('/api/orders',{method:'POST',body})]);
  assert.deepEqual([a.status,b.status].sort(),[200,201]);assert.equal(a.data.order.reference,b.data.order.reference);
  assert.equal((await request('/api/orders',{method:'POST',body:{...body,address:'changed'}})).status,409);
  db.get().prepare("INSERT INTO promos(code,type,value,max_uses) VALUES('ONCE','percent',10,1)").run();
  const results=await Promise.all([request('/api/orders',{method:'POST',body:payload({promoCode:'ONCE'})}),request('/api/orders',{method:'POST',body:payload({promoCode:'ONCE'})})]);
  assert.deepEqual(results.map(r=>r.status).sort(),[201,400]);assert.equal(db.get().prepare("SELECT used_count FROM promos WHERE code='ONCE'").get().used_count,1);
});
test('business: server enforces transitions; payment state immutable; tracking redacts PII and notes',async()=>{
  const created=await request('/api/orders',{method:'POST',body:payload({email:'private@example.test',notes:'Private note'})});const ref=created.data.order.reference;
  assert.equal((await request(`/api/orders/${ref}/status`,{method:'PATCH',cookie:admin,body:{status:'completed'}})).status,409);
  assert.equal((await request(`/api/orders/${ref}/status`,{method:'PATCH',cookie:admin,body:{status:'confirmed',payment_status:'paid'}})).status,400);
  assert.equal((await request(`/api/orders/${ref}/status`,{method:'PATCH',cookie:admin,body:{status:'confirmed',note:'Staff private'}})).status,200);
  const tracked=await request(`/api/orders/track/${ref}?phone=01000000000`);assert.equal(tracked.status,200);
  assert.equal(tracked.data.order.customer.email,'');assert.equal(tracked.data.order.delivery.notes,'');assert.ok(tracked.data.history.every(h=>h.note===''));
  assert.equal((await request(`/api/orders/track/${ref}?phone=01100000000`)).status,404);
  assert.throws(()=>db.get().prepare("UPDATE orders SET payment_status='paid' WHERE reference=?").run(ref));
  assert.throws(()=>db.get().prepare('DELETE FROM audit_events').run());
});
test('admin schemas: merged discount values, image URLs, hidden products and fields validated',async()=>{
  await request('/api/admin/promos',{method:'POST',cookie:admin,body:{code:'MERGE',type:'fixed',value:200}});
  assert.equal((await request('/api/admin/promos/MERGE',{method:'PATCH',cookie:admin,body:{type:'percent'}})).status,400);
  for(const image of ['javascript:alert(1)','data:image/svg+xml,<svg/>','https://127.0.0.1/a.png','/img/../a.png'])assert.equal((await request('/api/menu/admin/products/cookie',{method:'PATCH',cookie:admin,body:{image}})).status,400);
  assert.equal((await request('/api/admin/settings',{method:'PATCH',cookie:admin,body:{role:'admin'}})).status,400);
  db.get().prepare("UPDATE categories SET visible=0 WHERE id='cookies'").run();
  assert.equal((await request('/api/orders',{method:'POST',body:payload()})).status,400);
  db.get().prepare("UPDATE categories SET visible=1 WHERE id='cookies'").run();
});
test('rate limiting: strict login threshold, Retry-After, forged proxy headers cannot bypass',async()=>{
  let last;for(let i=0;i<11;i++)last=await request('/api/admin/session',{method:'POST',body:{key:'wrong'},headers:{'x-forwarded-for':`192.0.2.${i+1}`}});
  assert.equal(last.status,429);assert.ok(Number(last.headers.get('retry-after'))>0);
});
test('headers, methods, removed debug routes and private cache',async()=>{
  const res=await request('/api/account/me');assert.equal(res.headers.get('cache-control'),'no-store');
  const csp=res.headers.get('content-security-policy');assert.match(csp,/frame-ancestors 'none'/);assert.doesNotMatch(csp.match(/script-src [^;]+/)[0],/unsafe-inline|unsafe-eval/);
  assert.equal(res.headers.get('x-content-type-options'),'nosniff');assert.ok(res.headers.get('permissions-policy'));
  for(const route of ['/api/debug','/api/test','/api/payments','/api/webhook','/api/seed'])assert.equal((await request(route)).status,404);
  assert.equal((await request('/api/menu',{method:'PUT'})).status,405);
});
test('exceptional conditions: DB failure is generic and never authenticates; production fails closed',async()=>{
  const original=db.get().prepare;db.get().prepare=()=>{throw Object.assign(new Error('secret SQL /private/path'),{code:'SQLITE_BUSY'});};
  try{const res=await request('/api/orders',{cookie:admin});assert.equal(res.status,503);assert.doesNotMatch(JSON.stringify(res.data),/SQL|secret|private/);}finally{db.get().prepare=original;}
  assert.throws(()=>validateEnvironment({NODE_ENV:'production'}));
  assert.throws(()=>validateEnvironment({NODE_ENV:'production',DISABLE_ADMIN_AUTH:'true',MAIL_TRANSPORT:'console'}));
});
test('email: provider failures and redirects are bounded, no retry and no response PII disclosure',async()=>{
  const realFetch=globalThis.fetch;process.env.BREVO_API_KEY='fixture-key';let calls=0;
  globalThis.fetch=async(url,init)=>{calls++;assert.equal(url,'https://api.brevo.com/v3/smtp/email');assert.equal(init.redirect,'error');assert.ok(init.signal instanceof AbortSignal);return new Response('sensitive provider body',{status:500});};
  try{await assert.rejects(()=>sendMail({to:'fixture@example.test',subject:'fixture',text:'fixture'}),e=>e.code==='MAIL_FAILED' && !e.message.includes('sensitive'));assert.equal(calls,1);}finally{globalThis.fetch=realFetch;process.env.BREVO_API_KEY='';}
});
