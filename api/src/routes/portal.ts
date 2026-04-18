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
          client_id: true,
          project_id: true,
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

  // Return a safe subset — no owner_id or other internal tenancy fields.
  const safeProject = {
    id: project.id,
    client_id: project.client_id,
    portal_token: project.portal_token,
    name: project.name,
    description: project.description,
    status: project.status,
    deliverables: project.deliverables,
    created_at: project.created_at,
    client: project.client,
  };

  const safeInvoices = project.invoices.map((invoice) => ({
    ...invoice,
    project_id: invoice.project_id || project.id,
    client_id: invoice.client_id || project.client_id,
  }));

  return c.json({
    project: safeProject,
    // Kept for backward compatibility with older frontend portal parsing.
    client: project.client,
    invoices: safeInvoices,
  });
});

export default portal;
