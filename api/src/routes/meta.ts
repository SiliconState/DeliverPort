import { Hono } from 'hono';
import { prisma } from '../db.js';
import { authMiddleware } from '../middleware.js';

const meta = new Hono();
meta.use('*', authMiddleware);

/**
 * GET /api/meta — list all meta entries
 * Meta is global KV store (workspace settings, prefs).
 * Scoped by prefixing keys with userId in practice.
 */
meta.get('/', async (c) => {
  const records = await prisma.meta.findMany();
  return c.json({ meta: records });
});

/**
 * PUT /api/meta/:key — upsert a meta entry
 */
meta.put('/:key', async (c) => {
  const key = decodeURIComponent(c.req.param('key'));
  const body = await c.req.json();

  const entry = await prisma.meta.upsert({
    where: { key },
    create: { key, value: body.value },
    update: { value: body.value },
  });

  return c.json({ meta: entry });
});

/**
 * POST /api/meta/delete — delete multiple meta keys
 */
meta.post('/delete', async (c) => {
  const body = await c.req.json();
  const keys: string[] = body.keys || [];

  if (keys.length > 0) {
    await prisma.meta.deleteMany({ where: { key: { in: keys } } });
  }

  return c.json({ success: true, deleted: keys.length });
});

export default meta;
