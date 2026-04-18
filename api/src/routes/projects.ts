import { Hono } from 'hono';
import { randomBytes } from 'crypto';
import { prisma } from '../db.js';
import { authMiddleware } from '../middleware.js';

const projects = new Hono();

projects.use('*', authMiddleware);

/**
 * GET /api/projects
 * List all projects owned by the current user.
 */
projects.get('/', async (c) => {
  const { userId } = c.get('user');

  const records = await prisma.project.findMany({
    where: { owner_id: userId },
    include: { client: { select: { id: true, name: true, company: true } } },
    orderBy: { created_at: 'desc' },
  });

  return c.json({ projects: records });
});

/**
 * POST /api/projects
 * Create a new project.
 */
projects.post('/', async (c) => {
  const { userId } = c.get('user');
  const body = await c.req.json();

  const project = await prisma.project.create({
    data: {
      id: body.id || undefined,
      client_id: body.client_id || null,
      name: body.name,
      description: body.description || '',
      status: body.status || 'active',
      portal_token: body.portal_token || randomBytes(16).toString('hex'),
      deliverables: body.deliverables || [],
      owner_id: userId,
    },
  });

  return c.json({ project }, 201);
});

/**
 * GET /api/projects/:id
 */
projects.get('/:id', async (c) => {
  const { userId } = c.get('user');
  const id = c.req.param('id');

  const project = await prisma.project.findFirst({
    where: { id, owner_id: userId },
    include: {
      client: { select: { id: true, name: true, company: true } },
      invoices: true,
    },
  });

  if (!project) {
    return c.json({ error: 'Project not found' }, 404);
  }

  return c.json({ project });
});

/**
 * PUT /api/projects/:id
 */
projects.put('/:id', async (c) => {
  const { userId } = c.get('user');
  const id = c.req.param('id');
  const body = await c.req.json();

  const existing = await prisma.project.findFirst({
    where: { id, owner_id: userId },
  });

  if (!existing) {
    return c.json({ error: 'Project not found' }, 404);
  }

  const project = await prisma.project.update({
    where: { id },
    data: {
      client_id: body.client_id ?? existing.client_id,
      name: body.name ?? existing.name,
      description: body.description ?? existing.description,
      status: body.status ?? existing.status,
      portal_token: body.portal_token ?? existing.portal_token,
      deliverables: body.deliverables ?? existing.deliverables,
    },
  });

  return c.json({ project });
});

/**
 * DELETE /api/projects/:id
 */
projects.delete('/:id', async (c) => {
  const { userId } = c.get('user');
  const id = c.req.param('id');

  const existing = await prisma.project.findFirst({
    where: { id, owner_id: userId },
  });

  if (!existing) {
    return c.json({ error: 'Project not found' }, 404);
  }

  await prisma.project.delete({ where: { id } });

  return c.json({ success: true });
});

export default projects;
