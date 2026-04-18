import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { signToken, type JWTPayload } from '../src/auth.js';

const mocks = vi.hoisted(() => {
  const prisma = {
    client: {
      findMany: vi.fn(),
      findUnique: vi.fn(),
    },
    project: {
      findMany: vi.fn(),
      findUnique: vi.fn(),
    },
    invoice: {
      findMany: vi.fn(),
    },
    payoutRun: {
      findMany: vi.fn(),
    },
    user: {
      findUnique: vi.fn(),
      findMany: vi.fn(),
    },
    meta: {
      findMany: vi.fn(),
    },
  };

  return { prisma };
});

vi.mock('../src/db.js', () => ({
  prisma: mocks.prisma,
}));

const [{ default: bootstrapRoutes }, { default: portalRoutes }] = await Promise.all([
  import('../src/routes/bootstrap.js'),
  import('../src/routes/portal.js'),
]);

const app = new Hono();
app.route('/api/bootstrap', bootstrapRoutes);
app.route('/api/portal', portalRoutes);

function authHeaders(payload: Partial<JWTPayload> = {}): Record<string, string> {
  const token = signToken({
    userId: 'operator-1',
    email: 'operator@example.com',
    role: 'operator',
    ...payload,
  });

  return {
    Authorization: `Bearer ${token}`,
  };
}

beforeEach(() => {
  process.env.JWT_SECRET = 'test-secret';
  vi.clearAllMocks();

  mocks.prisma.client.findMany.mockResolvedValue([]);
  mocks.prisma.client.findUnique.mockResolvedValue(null);
  mocks.prisma.project.findMany.mockResolvedValue([]);
  mocks.prisma.project.findUnique.mockResolvedValue(null);
  mocks.prisma.invoice.findMany.mockResolvedValue([]);
  mocks.prisma.payoutRun.findMany.mockResolvedValue([]);
  mocks.prisma.user.findUnique.mockResolvedValue(null);
  mocks.prisma.user.findMany.mockResolvedValue([]);
  mocks.prisma.meta.findMany.mockResolvedValue([]);
});

describe('bootstrap + portal integration regressions', () => {
  it('scopes bootstrap for client users to their linked client workspace data', async () => {
    mocks.prisma.user.findUnique.mockResolvedValue({ client_id: 'client-7' });
    mocks.prisma.client.findUnique.mockResolvedValue({ id: 'client-7', owner_id: 'operator-9' });

    mocks.prisma.client.findMany.mockResolvedValue([
      { id: 'client-7', owner_id: 'operator-9', name: 'Sam Chen', company: 'Apex Studios' },
    ]);
    mocks.prisma.project.findMany.mockResolvedValue([
      { id: 'proj-1', owner_id: 'operator-9', client_id: 'client-7', name: 'Brand Refresh', deliverables: [] },
    ]);
    mocks.prisma.invoice.findMany.mockResolvedValue([
      {
        id: 'inv-1',
        owner_id: 'operator-9',
        client_id: 'client-7',
        project_id: 'proj-1',
        status: 'sent',
        total: 750,
      },
    ]);
    mocks.prisma.user.findMany.mockResolvedValue([
      {
        id: 'client-user-1',
        role: 'client',
        client_id: 'client-7',
        email: 'sam@apexstudios.io',
      },
    ]);

    const res = await app.request('/api/bootstrap', {
      headers: authHeaders({ userId: 'client-user-1', role: 'client' }),
    });

    expect(res.status).toBe(200);
    expect(mocks.prisma.client.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { owner_id: 'operator-9', id: 'client-7' },
    }));
    expect(mocks.prisma.project.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { owner_id: 'operator-9', client_id: 'client-7' },
    }));
    expect(mocks.prisma.invoice.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: {
        owner_id: 'operator-9',
        client_id: 'client-7',
        status: { in: ['sent', 'paid'] },
      },
    }));
    expect(mocks.prisma.payoutRun.findMany).not.toHaveBeenCalled();
    expect(mocks.prisma.user.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 'client-user-1' },
    }));

    const body = await res.json();
    expect(body.auth.userId).toBe('client-user-1');
    expect(body.auth.workspace_owner_id).toBe('operator-9');
    expect(body.auth.client_scope_id).toBe('client-7');
    expect(body.payout_runs).toEqual([]);
  });

  it('returns portal response fields required by the share page contract', async () => {
    mocks.prisma.project.findUnique.mockResolvedValue({
      id: 'proj-7',
      client_id: 'client-9',
      portal_token: 'portal-abc',
      name: 'Demo Portal',
      description: 'Shared project',
      status: 'active',
      deliverables: [{ id: 'd1', name: 'Homepage', status: 'delivered' }],
      created_at: '2026-04-18T00:00:00.000Z',
      client: {
        id: 'client-9',
        name: 'Sam Chen',
        company: 'Apex Studios',
        email: 'sam@apexstudios.io',
      },
      invoices: [
        {
          id: 'inv-44',
          client_id: null,
          project_id: null,
          status: 'sent',
          line_items: [{ description: 'Design sprint', amount: 750 }],
          total: 750,
          currency: 'USD',
          payment_rail: 'USDC (Base)',
          payment_address: '0xabc',
          chain: 'Base',
          token: 'USDC',
          due_days: 14,
          notes: null,
          issued_at: '2026-04-18T00:00:00.000Z',
          paid_at: null,
        },
      ],
    });

    const res = await app.request('/api/portal/portal-abc');
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.project.id).toBe('proj-7');
    expect(body.project.client_id).toBe('client-9');
    expect(body.project.portal_token).toBe('portal-abc');
    expect(body.project.owner_id).toBeUndefined();

    expect(body.client).toEqual(expect.objectContaining({ id: 'client-9' }));
    expect(body.invoices).toHaveLength(1);
    expect(body.invoices[0]).toEqual(expect.objectContaining({
      id: 'inv-44',
      project_id: 'proj-7',
      client_id: 'client-9',
      payment_address: '0xabc',
    }));
  });
});
