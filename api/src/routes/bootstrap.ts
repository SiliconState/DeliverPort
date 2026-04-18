import { Hono } from 'hono';
import { prisma } from '../db.js';
import { authMiddleware } from '../middleware.js';
import {
  fromUserMetaStorageKey,
  isPrimaryUserMetaStorageKey,
  userMetaPrefixes,
} from '../meta-keys.js';

const bootstrap = new Hono();

bootstrap.use('*', authMiddleware);

const CLIENT_VISIBLE_INVOICE_STATUSES = ['sent', 'paid'];

/**
 * GET /api/bootstrap
 * Returns startup data in one round-trip for the authenticated operator/client.
 */
bootstrap.get('/', async (c) => {
  const auth = c.get('user');
  const { userId } = auth;
  const metaPrefixes = userMetaPrefixes(userId);

  let workspaceOwnerId = userId;
  let clientScopeId: string | null = null;

  if (auth.role === 'client') {
    const actor = await prisma.user.findUnique({
      where: { id: userId },
      select: { client_id: true },
    });

    if (!actor?.client_id) {
      return c.json({ error: 'Client account is not linked to a client workspace' }, 403);
    }

    const linkedClient = await prisma.client.findUnique({
      where: { id: actor.client_id },
      select: { id: true, owner_id: true },
    });

    if (!linkedClient) {
      return c.json({ error: 'Linked client record was not found' }, 404);
    }

    workspaceOwnerId = linkedClient.owner_id;
    clientScopeId = linkedClient.id;
  }

  const [clients, projects, invoices, metaRows] = await Promise.all([
    prisma.client.findMany({
      where: clientScopeId
        ? { owner_id: workspaceOwnerId, id: clientScopeId }
        : { owner_id: workspaceOwnerId },
      orderBy: { created_at: 'desc' },
    }),
    prisma.project.findMany({
      where: clientScopeId
        ? { owner_id: workspaceOwnerId, client_id: clientScopeId }
        : { owner_id: workspaceOwnerId },
      include: { client: { select: { id: true, name: true, company: true } } },
      orderBy: { created_at: 'desc' },
    }),
    prisma.invoice.findMany({
      where: clientScopeId
        ? {
          owner_id: workspaceOwnerId,
          client_id: clientScopeId,
          status: { in: CLIENT_VISIBLE_INVOICE_STATUSES },
        }
        : { owner_id: workspaceOwnerId },
      include: {
        client: { select: { id: true, name: true, company: true } },
        project: { select: { id: true, name: true } },
      },
      orderBy: { issued_at: 'desc' },
    }),
    prisma.meta.findMany({
      where: {
        OR: metaPrefixes.map((prefix) => ({
          key: {
            startsWith: prefix,
          },
        })),
      },
      orderBy: {
        key: 'asc',
      },
    }),
  ]);

  const payoutRuns = auth.role === 'client'
    ? []
    : await prisma.payoutRun.findMany({
      where: { owner_id: workspaceOwnerId },
      orderBy: { created_at: 'desc' },
    });

  const users = auth.role === 'client'
    ? await prisma.user.findMany({
      where: { id: userId },
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
    })
    : await prisma.user.findMany({
      where: {
        OR: [
          { id: userId },
          { client: { owner_id: workspaceOwnerId } },
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
    });

  const mergedMeta = new Map<string, { key: string; value: unknown; primary: boolean }>();
  for (const row of metaRows) {
    const key = fromUserMetaStorageKey(userId, row.key);
    const primary = isPrimaryUserMetaStorageKey(userId, row.key);
    const existing = mergedMeta.get(key);

    if (!existing || (primary && !existing.primary)) {
      mergedMeta.set(key, {
        key,
        value: row.value,
        primary,
      });
    }
  }

  const meta = Array.from(mergedMeta.values())
    .sort((left, right) => left.key.localeCompare(right.key))
    .map((entry) => ({ key: entry.key, value: entry.value }));

  // Keep this response fresh (frontend manages a short-lived session cache explicitly).
  c.header('Cache-Control', 'private, no-store');
  c.header('Vary', 'Authorization, Accept-Encoding');

  return c.json({
    auth: {
      ...auth,
      workspace_owner_id: workspaceOwnerId,
      client_scope_id: clientScopeId,
    },
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
