/**
 * Product photos: uploaded by an admin, served to anyone.
 *
 * Stored in Firestore as bytes (`productImages/{hash}`) rather than in a bucket:
 * no bucket to provision, no second credential, and the emulator the tests use
 * already covers it. The dashboard shrinks a photo before it leaves the browser,
 * so a document's 1 MiB ceiling is never reached; MAX_IMAGE_BYTES holds that on
 * the server whatever a caller sends.
 *
 * Served from `/api/images/<hash>.<ext>` on this origin, so `img-src 'self'`
 * needs no widening. The name is the content hash, so a URL's bytes can never
 * change underneath it, which is what makes the year-long immutable cache safe.
 */

import { createHash } from 'node:crypto';
import { Router } from 'express';
import { z } from 'zod';
import { requireAdmin } from '../adminSession.js';
import { collections, FieldValue } from '../firestore.js';

export const MAX_IMAGE_BYTES = 750 * 1024;

const CONTENT_TYPES = { jpg: 'image/jpeg', png: 'image/png', webp: 'image/webp' };
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** What the bytes are, by their header. An SVG, or anything else, is refused. */
export function sniff(bytes) {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'jpg';
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(PNG_SIGNATURE)) return 'png';
  if (bytes.length >= 12 && bytes.toString('latin1', 0, 4) === 'RIFF'
    && bytes.toString('latin1', 8, 12) === 'WEBP') return 'webp';
  return null;
}

const uploadBody = z.strictObject({
  data: z.string().min(1)
    .max(Math.ceil(MAX_IMAGE_BYTES / 3) * 4 + 4)
    .regex(/^[A-Za-z0-9+/]+={0,2}$/),
});

const router = Router();

router.post('/admin/images', requireAdmin, async (req, res, next) => {
  try {
    const parsed = uploadBody.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'INVALID', message: 'That photo could not be read, or is too large.' });
    }
    const bytes = Buffer.from(parsed.data.data, 'base64');
    if (bytes.length > MAX_IMAGE_BYTES) {
      return res.status(400).json({ error: 'INVALID', message: 'That photo is too large.' });
    }
    const ext = sniff(bytes);
    if (!ext) return res.status(400).json({ error: 'INVALID', message: 'Upload a JPEG, PNG or WebP photo.' });

    const id = createHash('sha256').update(bytes).digest('hex').slice(0, 32);
    const ref = collections.productImages().doc(id);
    // Same bytes, same id: uploading a photo twice stores it once.
    if (!(await ref.get()).exists) {
      await ref.set({ ext, bytes, size: bytes.length, createdAt: FieldValue.serverTimestamp() });
    }
    return res.status(201).json({ path: `/api/images/${id}.${ext}` });
  } catch (error) { return next(error); }
});

const NAME = /^([a-f0-9]{32})\.(jpg|png|webp)$/;
const cache = new Map();
const CACHE_LIMIT = 64;

router.get('/images/:name', async (req, res, next) => {
  try {
    const match = NAME.exec(req.params.name);
    const notFound = () => res.status(404).json({ error: 'NOT_FOUND', message: 'No such image.' });
    if (!match) return notFound();
    const [, id, ext] = match;

    let entry = cache.get(id);
    if (!entry) {
      const snapshot = await collections.productImages().doc(id).get();
      if (!snapshot.exists) return notFound();
      const doc = snapshot.data();
      entry = { ext: doc.ext, bytes: Buffer.from(doc.bytes) };
      cache.set(id, entry);
      if (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value);
    }
    if (entry.ext !== ext) return notFound();

    res.set('Cache-Control', 'public, max-age=31536000, immutable');
    return res.type(CONTENT_TYPES[ext]).send(entry.bytes);
  } catch (error) { return next(error); }
});

export default router;
