import { z } from 'zod';

export const identifier = z.string().min(1).max(80).regex(/^[a-z0-9-]+$/);
export const reference = z.string().max(40).regex(/^HC-\d{1,16}$/i);
export const email = z.string().trim().toLowerCase().max(160).email();
export const amount = z.number().finite().min(0).max(1_000_000);
export const imagePath = z.string().max(200).regex(/^(?:|\/img\/(?:[a-zA-Z0-9_-]+\/)*[a-zA-Z0-9_-]+(?:@[12]x)?\.(?:jpg|jpeg|png|webp|avif)|\/api\/images\/[a-f0-9]{32}\.(?:jpg|png|webp))$/);
const integer = (max) => z.string().regex(/^[1-9]\d{0,5}$/).transform(Number).pipe(z.number().int().max(max));
export const pagination = z.strictObject({
  page: integer(10000).optional(), perPage: integer(100).optional(),
  q: z.string().trim().max(100).optional(),
});
const empty = z.strictObject({});
const listPaths = new Set(['/orders', '/admin/customers', '/admin/users', '/admin/promos', '/menu/admin/products', '/menu/admin/categories', '/account/orders']);

// Express query values are deliberately left uncoerced unless a route schema
// accepts them. Duplicate keys/objects never become strings via String(value).
export function validateEnvelope(req, res, next) {
  let schema = empty;
  if (listPaths.has(req.path) || /^\/admin\/customers\/[^/]+$/.test(req.path)) schema = pagination;
  if (req.path === '/orders') schema = pagination.extend({status: z.enum(['ordered','confirmed','baking','in_transit','completed','cancelled']).optional(), fulfilment: z.enum(['delivery','pickup']).optional()});
  if (req.path === '/admin/users') schema = pagination.extend({refresh:z.literal('1').optional()});
  if (req.path === '/orders/stats') schema = z.strictObject({days:integer(365).optional()});
  if (/^\/orders\/track\//.test(req.path)) schema = z.strictObject({phone:z.string().min(6).max(24)});
  if (/^\/menu\/admin\/categories\/[^/]+$/.test(req.path)) schema = z.strictObject({withProducts:z.literal('1').optional()});
  const query = schema.safeParse(req.query);
  if (!query.success) return invalid(res);
  req.validatedQuery = query.data;
  if (req.originalUrl.length > 2048) return res.status(414).json({error:'URI_TOO_LONG',message:'Request URL is too long.'});
  return next();
}

export function validateParams(router) {
  for (const [name,schema] of Object.entries({id:identifier,reference,code:z.string().max(40).regex(/^[A-Za-z0-9_-]+$/),phone:z.string().max(24).regex(/^\+?\d{6,24}$/)})) {
    router.param(name,(req,res,next,value)=>schema.safeParse(value).success?next():invalid(res));
  }
}

export function invalid(res) { return res.status(400).json({error:'INVALID',message:'Check the request fields.'}); }

// Bound nesting even for unexpected input; JSON parsing already has a 32 KiB cap.
export function rejectDangerousKeys(req,res,next) {
  const inspect=(value,depth=0)=> {
    if(depth>8) return false;
    if(value && typeof value==='object') return Object.entries(value).every(([key,entry])=>!['__proto__','prototype','constructor'].includes(key) && inspect(entry,depth+1));
    // eslint-disable-next-line no-control-regex -- refusing control characters is the purpose of this check
    return typeof value !== 'string' || !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\ud800-\udfff]/u.test(value);
  };
  return inspect(req.body)?next():invalid(res);
}
