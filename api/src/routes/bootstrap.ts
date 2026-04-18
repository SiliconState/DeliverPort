import { Hono } from 'hono';
import { prisma } from '../db.js';
import { authMiddleware } from '../middleware.js';

const bootstrap = new Hono();

bootstrap.use('*', authMiddleware);

/**
 * GET /api/bootstrap
 * Returns all startup data in one round-trip for the authenticated operator.
 * This replaces multiple startup requests from the frontend.
 */
bootstrap.get('/', async (c) => {
  const auth = c.get('user');
  const { userId } = auth;

  const [clients, projects, invoices, payoutRuns, users, meta] = await Promise.all([
    prisma.client.findMany({
      where: { owner_id: userId },
      orderBy: { created_at: 'desc' },
    }),
    prisma.project.findMany({
      where: { owner_id: userId },
      include: { client: { select: { id: true, name: true, company: true } } },
      orderBy: { created_at: 'desc' },
    }),
    prisma.invoice.findMany({
      where: { owner_id: userId },
      include: {
        client: { select: { id: true, name: true, company: true } },
        project: { select: { id: true, name: true } },
      },
      orderBy: { issued_at: 'desc' },
    }),
    prisma.payoutRun.findMany({
      where: { owner_id: userId },
      orderBy: { created_at: 'desc' },
    }),
    prisma.user.findMany({
      where: {
        OR: [
          { id: userId },
          { client: { owner_id: userId } },
        ],
      },
      select: {
        id: true,
        name: true,
        email: true,
        role: true,
        wallet_address: true,
        phone: true,
        auth_status: true,
        client_id: true,
        joined_at: true,
        last_login_at: true,
      },
    }),
    prisma.meta.findMany(),
  ]);

  // Keep this response fresh (frontend manages a short-lived session cache explicitly).
  c.header('Cache-Control', 'private, no-store');
  c.header('Vary', 'Authorization, Accept-Encoding');

  return c.json({
    auth,
    clients,
    projects,
    invoices,
    payout_runs: payoutRuns,
    users,
    meta,
    server_time: new Date().toISOString(),
  });
});

export default bootstrap;
