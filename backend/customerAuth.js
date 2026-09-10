import * as db from './db.js';
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
export function claimProfile(email) {
  const database = db.get();
  return database.transaction(() => {
    database.prepare(`
      INSERT INTO profiles (email) VALUES (?)
      ON CONFLICT(email) DO UPDATE SET updated_at = datetime('now')
    `).run(email);
    const profile = database.prepare('SELECT * FROM profiles WHERE email = ?').get(email);

    // Only orders that are not already claimed, so re-signing in is cheap and
    // an order can never be moved from one account to another.
    const linked = database.prepare(`
      UPDATE orders SET profile_id = ?
      WHERE LOWER(email) = ? AND profile_id IS NULL
    `).run(profile.id, email);

    // Backfill the profile from the most recent order, so a first sign-in
    // arrives with a name and phone already filled in rather than blank.
    const recent = database.prepare(`
      SELECT first_name, last_name, phone, area, address FROM orders
      WHERE profile_id = ? ORDER BY id DESC LIMIT 1
    `).get(profile.id);
    if (recent) {
      database.prepare(`
        UPDATE profiles SET
          full_name = CASE WHEN full_name = '' THEN @name ELSE full_name END,
          phone = CASE WHEN phone = '' THEN @phone ELSE phone END,
          default_area = CASE WHEN default_area = '' THEN @area ELSE default_area END,
          default_address = CASE WHEN default_address = '' THEN @address ELSE default_address END,
          updated_at = datetime('now')
        WHERE id = @id
      `).run({
        id: profile.id,
        name: `${recent.first_name} ${recent.last_name}`.trim(),
        phone: recent.phone ?? '',
        area: recent.area ?? '',
        address: recent.address ?? '',
      });
    }

    return {
      profile: database.prepare('SELECT * FROM profiles WHERE id = ?').get(profile.id),
      linkedOrders: linked.changes,
    };
  })();
}

export { SESSION_COOKIE };
