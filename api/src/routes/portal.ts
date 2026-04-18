import { Hono } from 'hono';
import { prisma } from '../db.js';

const portal = new Hono();

/**
 * GET /api/portal/:token
 * Public endpoint — returns project details, deliverables, and invoices
 * for a shared portal link. No authentication required.
 */
portal.get('/:token', async (c) => {
  const token = c.req.param('token');

  const project = await prisma.project.findUnique({
    where: { portal_token: token },
    include: {
      client: {
        select: {
          id: true,
          name: true,
          company: true,
          email: true,
        },
      },
      invoices: {
        select: {
          id: true,
          status: true,
          line_items: true,
          total: true,
          currency: true,
          payment_rail: true,
          payment_address: true,
          chain: true,
          token: true,
          due_days: true,
          notes: true,
          issued_at: true,
          paid_at: true,
        },
        orderBy: { issued_at: 'desc' },
      },
    },
  });

  if (!project) {
    return c.json({ error: 'Portal not found' }, 404);
  }

  // Return a safe subset — no owner_id, no internal IDs
  return c.json({
    project: {
      name: project.name,
      description: project.description,
      status: project.status,
      deliverables: project.deliverables,
      created_at: project.created_at,
      client: project.client,
    },
    invoices: project.invoices,
  });
});

export default portal;
