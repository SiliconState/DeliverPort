import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { signToken, type JWTPayload } from '../src/auth.js';

const mocks = vi.hoisted(() => {
  const prisma = {
    meta: {
      findMany: vi.fn(),
      upsert: vi.fn(),
      deleteMany: vi.fn(),
      create: vi.fn(),
    },
    project: {
      findUnique: vi.fn(),
      update: vi.fn(),
      findFirst: vi.fn(),
      create: vi.fn(),
      delete: vi.fn(),
    },
    invoice: {
      findMany: vi.fn(),
      findFirst: vi.fn(),
      update: vi.fn(),
      create: vi.fn(),
      delete: vi.fn(),
    },
    user: {
      findUnique: vi.fn(),
    },
    client: {
      findFirst: vi.fn(),
    },
    $transaction: vi.fn(),
  };

  const auditLog = {
    createInvoiceReminder: vi.fn(),
    latestSentReminderByInvoice: vi.fn(),
    listInvoiceReminders: vi.fn(),
    safeLogAuditEvent: vi.fn(),
    listAuditEvents: vi.fn(),
  };

  return {
    prisma,
    auditLog,
  };
});

vi.mock('../src/db.js', () => ({
  prisma: mocks.prisma,
}));

vi.mock('../src/audit-log.js', () => ({
  createInvoiceReminder: mocks.auditLog.createInvoiceReminder,
  latestSentReminderByInvoice: mocks.auditLog.latestSentReminderByInvoice,
  listInvoiceReminders: mocks.auditLog.listInvoiceReminders,
  safeLogAuditEvent: mocks.auditLog.safeLogAuditEvent,
  listAuditEvents: mocks.auditLog.listAuditEvents,
}));


const [
  { default: metaRoutes },
  { default: projectRoutes },
  { default: invoiceRoutes },
  { default: auditEventRoutes },
] = await Promise.all([
  import('../src/routes/meta.js'),
  import('../src/routes/projects.js'),
  import('../src/routes/invoices.js'),
  import('../src/routes/audit-events.js'),
]);

const app = new Hono();
app.route('/api/meta', metaRoutes);
app.route('/api/projects', projectRoutes);
app.route('/api/invoices', invoiceRoutes);
app.route('/api/audit-events', auditEventRoutes);

function authHeaders(payload: Partial<JWTPayload> = {}): Record<string, string> {
  const token = signToken({
    userId: 'user-1',
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
  vi.useRealTimers();
  vi.unstubAllGlobals();

  mocks.prisma.$transaction.mockImplementation(async (handler: (tx: unknown) => Promise<unknown>) => handler({
    meta: {
      upsert: mocks.prisma.meta.upsert,
      deleteMany: mocks.prisma.meta.deleteMany,
    },
  }));

  mocks.auditLog.latestSentReminderByInvoice.mockImplementation((reminders: Array<{ invoice_id: string; status: string; sent_at: string | null }>) => {
    const latest = new Map<string, string>();

    for (const reminder of reminders || []) {
      if (reminder.status !== 'sent' || !reminder.sent_at) continue;
      const current = latest.get(reminder.invoice_id);
      if (!current || reminder.sent_at > current) {
        latest.set(reminder.invoice_id, reminder.sent_at);
      }
    }

    return latest;
  });

  mocks.auditLog.listAuditEvents.mockResolvedValue([]);
  mocks.prisma.meta.findMany.mockResolvedValue([]);
});

describe('P0/P1 regression tests', () => {
  describe('meta tenancy isolation', () => {
    it('lists only tenant-scoped keys and prefers namespaced records over legacy duplicates', async () => {
      mocks.prisma.meta.findMany.mockResolvedValue([
        { key: 'user-1:theme', value: 'legacy-theme' },
        { key: 'u:user-1:meta:theme', value: 'dark-theme' },
        { key: 'u:user-1:meta:timezone', value: 'UTC' },
      ]);

      const res = await app.request('/api/meta', {
        headers: authHeaders(),
      });

      expect(res.status).toBe(200);
      expect(mocks.prisma.meta.findMany).toHaveBeenCalledWith({
        where: {
          OR: [
            { key: { startsWith: 'u:user-1:meta:' } },
            { key: { startsWith: 'user-1:' } },
          ],
        },
        orderBy: { key: 'asc' },
      });

      const body = await res.json();
      expect(body).toEqual({
        meta: [
          { key: 'theme', value: 'dark-theme' },
          { key: 'timezone', value: 'UTC' },
        ],
      });
    });

    it('writes meta values under tenant namespace and cleans legacy key for same tenant', async () => {
      mocks.prisma.meta.upsert.mockResolvedValue({
        key: 'u:user-1:meta:dashboard',
        value: { layout: 'compact' },
      });
      mocks.prisma.meta.deleteMany.mockResolvedValue({ count: 1 });

      const res = await app.request('/api/meta/dashboard', {
        method: 'PUT',
        headers: {
          ...authHeaders(),
          'content-type': 'application/json',
        },
        body: JSON.stringify({ value: { layout: 'compact' } }),
      });

      expect(res.status).toBe(200);
      expect(mocks.prisma.meta.upsert).toHaveBeenCalledWith({
        where: { key: 'u:user-1:meta:dashboard' },
        create: {
          key: 'u:user-1:meta:dashboard',
          value: { layout: 'compact' },
        },
        update: {
          value: { layout: 'compact' },
        },
      });

      expect(mocks.prisma.meta.deleteMany).toHaveBeenCalledWith({
        where: {
          key: 'user-1:dashboard',
        },
      });

      const body = await res.json();
      expect(body.meta.key).toBe('dashboard');
    });
  });

  describe('deliverable approval auth matrix', () => {
    it('allows owner operator to approve deliverables', async () => {
      mocks.prisma.project.findUnique.mockResolvedValue({
        id: 'proj-1',
        owner_id: 'user-1',
        client_id: 'client-1',
        deliverables: [{ id: 'del-1', title: 'Design spec' }],
      });

      mocks.prisma.project.update.mockImplementation(async ({ data, where }: { data: { deliverables: unknown[] }; where: { id: string } }) => ({
        id: where.id,
        owner_id: 'user-1',
        deliverables: data.deliverables,
      }));

      const res = await app.request('/api/projects/proj-1/deliverables/del-1/approval', {
        method: 'PUT',
        headers: {
          ...authHeaders({ role: 'operator' }),
          'content-type': 'application/json',
        },
        body: JSON.stringify({ decision: 'approved', note: 'Looks good' }),
      });

      expect(res.status).toBe(200);
      expect(mocks.prisma.project.update).toHaveBeenCalledTimes(1);

      const body = await res.json();
      expect(body.deliverable.approval.status).toBe('approved');
      expect(body.deliverable.approval.actor_user_id).toBe('user-1');
    });

    it('rejects operator when project is owned by another tenant', async () => {
      mocks.prisma.project.findUnique.mockResolvedValue({
        id: 'proj-1',
        owner_id: 'someone-else',
        client_id: 'client-1',
        deliverables: [{ id: 'del-1', title: 'Design spec' }],
      });

      const res = await app.request('/api/projects/proj-1/deliverables/del-1/approval', {
        method: 'PUT',
        headers: {
          ...authHeaders({ role: 'operator' }),
          'content-type': 'application/json',
        },
        body: JSON.stringify({ decision: 'approved' }),
      });

      expect(res.status).toBe(403);
      expect(mocks.prisma.project.update).not.toHaveBeenCalled();
    });

    it('allows client actor mapped to project client_id', async () => {
      mocks.prisma.project.findUnique.mockResolvedValue({
        id: 'proj-1',
        owner_id: 'owner-1',
        client_id: 'client-42',
        deliverables: [{ id: 'del-1', title: 'Design spec' }],
      });

      mocks.prisma.user.findUnique.mockResolvedValue({ client_id: 'client-42' });
      mocks.prisma.project.update.mockImplementation(async ({ data, where }: { data: { deliverables: unknown[] }; where: { id: string } }) => ({
        id: where.id,
        owner_id: 'owner-1',
        deliverables: data.deliverables,
      }));

      const res = await app.request('/api/projects/proj-1/deliverables/del-1/approval', {
        method: 'PUT',
        headers: {
          ...authHeaders({ role: 'client', userId: 'client-user-1', email: 'client@example.com' }),
          'content-type': 'application/json',
        },
        body: JSON.stringify({ decision: 'rejected', note: 'Needs revision' }),
      });

      expect(res.status).toBe(200);
      expect(mocks.prisma.user.findUnique).toHaveBeenCalledWith({
        where: { id: 'client-user-1' },
        select: { client_id: true },
      });
      expect(mocks.prisma.project.update).toHaveBeenCalledTimes(1);
    });

    it('rejects client actor whose profile is not linked to project client', async () => {
      mocks.prisma.project.findUnique.mockResolvedValue({
        id: 'proj-1',
        owner_id: 'owner-1',
        client_id: 'client-42',
        deliverables: [{ id: 'del-1', title: 'Design spec' }],
      });

      mocks.prisma.user.findUnique.mockResolvedValue({ client_id: 'client-99' });

      const res = await app.request('/api/projects/proj-1/deliverables/del-1/approval', {
        method: 'PUT',
        headers: {
          ...authHeaders({ role: 'client', userId: 'client-user-1', email: 'client@example.com' }),
          'content-type': 'application/json',
        },
        body: JSON.stringify({ decision: 'approved' }),
      });

      expect(res.status).toBe(403);
      expect(mocks.prisma.project.update).not.toHaveBeenCalled();
    });
  });

  describe('invoice reconcile hit/miss paths', () => {
    it('returns matched=false for automatic reconciliation miss without updating invoice', async () => {
      mocks.prisma.invoice.findFirst.mockResolvedValue({
        id: 'inv-1',
        owner_id: 'user-1',
        status: 'sent',
        chain: 'base',
        token: 'USDC',
        payment_rail: 'USDC (Base)',
        payment_address: '0x1111111111111111111111111111111111111111',
        total: 10,
        tx_hash: null,
      });

      const fetchMock = vi.fn()
        .mockResolvedValueOnce(new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: '0x100' }), { status: 200 }))
        .mockResolvedValueOnce(new Response(JSON.stringify({ jsonrpc: '2.0', id: 2, result: [] }), { status: 200 }));

      vi.stubGlobal('fetch', fetchMock);

      const res = await app.request('/api/invoices/inv-1/reconcile', {
        method: 'POST',
        headers: {
          ...authHeaders(),
          'content-type': 'application/json',
        },
        body: JSON.stringify({}),
      });

      expect(res.status).toBe(200);

      const body = await res.json();
      expect(body.reconciled).toBe(false);
      expect(body.matched).toBe(false);
      expect(body.scan.token).toBe('USDC');
      expect(mocks.prisma.invoice.update).not.toHaveBeenCalled();
    });

    it('marks invoice paid when automatic reconciliation finds matching transfer', async () => {
      mocks.prisma.invoice.findFirst.mockResolvedValue({
        id: 'inv-1',
        owner_id: 'user-1',
        status: 'sent',
        chain: 'base',
        token: 'USDC',
        payment_rail: 'USDC (Base)',
        payment_address: '0x1111111111111111111111111111111111111111',
        total: 10,
        tx_hash: null,
      });

      mocks.prisma.invoice.update.mockImplementation(async ({ data }: { data: { status: string; tx_hash: string; paid_at: Date } }) => ({
        id: 'inv-1',
        owner_id: 'user-1',
        status: data.status,
        tx_hash: data.tx_hash,
        paid_at: data.paid_at,
      }));

      const fetchMock = vi.fn()
        .mockResolvedValueOnce(new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: '0x100' }), { status: 200 }))
        .mockResolvedValueOnce(new Response(JSON.stringify({
          jsonrpc: '2.0',
          id: 2,
          result: [
            {
              blockNumber: '0xf8',
              logIndex: '0x2',
              transactionHash: '0xabc123',
              data: '0x989680',
              topics: [],
            },
          ],
        }), { status: 200 }));

      vi.stubGlobal('fetch', fetchMock);

      const res = await app.request('/api/invoices/inv-1/reconcile', {
        method: 'POST',
        headers: {
          ...authHeaders(),
          'content-type': 'application/json',
        },
        body: JSON.stringify({}),
      });

      expect(res.status).toBe(200);
      expect(mocks.prisma.invoice.update).toHaveBeenCalledTimes(1);

      const body = await res.json();
      expect(body.reconciled).toBe(true);
      expect(body.reconciliation.mode).toBe('rpc_scan');
      expect(body.invoice.tx_hash).toBe('0xabc123');
    });

    it('rejects tx_hash reconciliation when strict verification fails', async () => {
      const txHash = `0x${'a'.repeat(64)}`;

      mocks.prisma.invoice.findFirst.mockResolvedValue({
        id: 'inv-1',
        owner_id: 'user-1',
        status: 'sent',
        chain: 'base',
        token: 'USDC',
        payment_rail: 'USDC (Base)',
        payment_address: '0x1111111111111111111111111111111111111111',
        total: 10,
        tx_hash: null,
      });

      const fetchMock = vi.fn()
        .mockResolvedValueOnce(new Response(JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          result: {
            status: '0x1',
            blockNumber: '0xff',
            transactionHash: txHash,
            logs: [],
          },
        }), { status: 200 }))
        .mockResolvedValueOnce(new Response(JSON.stringify({ jsonrpc: '2.0', id: 2, result: '0x100' }), { status: 200 }));

      vi.stubGlobal('fetch', fetchMock);

      const res = await app.request('/api/invoices/inv-1/reconcile', {
        method: 'POST',
        headers: {
          ...authHeaders(),
          'content-type': 'application/json',
        },
        body: JSON.stringify({ tx_hash: txHash }),
      });

      expect(res.status).toBe(409);
      expect(mocks.prisma.invoice.update).not.toHaveBeenCalled();

      const body = await res.json();
      expect(body.reconciled).toBe(false);
      expect(body.verified).toBe(false);
      expect(body.reason).toBe('transfer_log_not_found');
    });

    it('marks invoice paid for tx_hash when verification succeeds', async () => {
      const txHash = `0x${'b'.repeat(64)}`;

      mocks.prisma.invoice.findFirst.mockResolvedValue({
        id: 'inv-1',
        owner_id: 'user-1',
        status: 'sent',
        chain: 'base',
        token: 'USDC',
        payment_rail: 'USDC (Base)',
        payment_address: '0x1111111111111111111111111111111111111111',
        total: 10,
        tx_hash: null,
      });

      mocks.prisma.invoice.update.mockImplementation(async ({ data }: { data: { status: string; tx_hash: string; paid_at: Date } }) => ({
        id: 'inv-1',
        owner_id: 'user-1',
        status: data.status,
        tx_hash: data.tx_hash,
        paid_at: data.paid_at,
      }));

      const fetchMock = vi.fn()
        .mockResolvedValueOnce(new Response(JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          result: {
            status: '0x1',
            blockNumber: '0xff',
            transactionHash: txHash,
            logs: [
              {
                address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
                topics: [
                  '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55aeb2ff1bca',
                  '0x0000000000000000000000009999999999999999999999999999999999999999',
                  '0x0000000000000000000000001111111111111111111111111111111111111111',
                ],
                data: '0x989680',
                logIndex: '0x1',
                blockNumber: '0xff',
              },
            ],
          },
        }), { status: 200 }))
        .mockResolvedValueOnce(new Response(JSON.stringify({ jsonrpc: '2.0', id: 2, result: '0x100' }), { status: 200 }));

      vi.stubGlobal('fetch', fetchMock);

      const res = await app.request('/api/invoices/inv-1/reconcile', {
        method: 'POST',
        headers: {
          ...authHeaders(),
          'content-type': 'application/json',
        },
        body: JSON.stringify({ tx_hash: txHash }),
      });

      expect(res.status).toBe(200);
      expect(mocks.prisma.invoice.update).toHaveBeenCalledTimes(1);

      const body = await res.json();
      expect(body.reconciled).toBe(true);
      expect(body.reconciliation.mode).toBe('tx_hash_verified');
      expect(body.invoice.tx_hash).toBe(txHash);
    });
  });

  describe('invoice reminder create/list paths', () => {
    it('creates a sent reminder record for a sent invoice', async () => {
      mocks.prisma.invoice.findFirst.mockResolvedValue({
        id: 'inv-1',
        owner_id: 'user-1',
        status: 'sent',
        client: {
          email: 'billing@client.test',
        },
      });

      mocks.auditLog.createInvoiceReminder.mockResolvedValue({
        id: 'rem-1',
        invoice_id: 'inv-1',
        owner_id: 'user-1',
        actor_user_id: 'user-1',
        channel: 'email',
        recipient: 'billing@client.test',
        note: 'Gentle reminder',
        status: 'sent',
        sent_at: '2026-04-18T00:00:00.000Z',
        created_at: '2026-04-18T00:00:00.000Z',
      });

      const res = await app.request('/api/invoices/inv-1/reminders/mark-sent', {
        method: 'POST',
        headers: {
          ...authHeaders(),
          'content-type': 'application/json',
        },
        body: JSON.stringify({ channel: 'email', note: 'Gentle reminder' }),
      });

      expect(res.status).toBe(201);
      expect(mocks.auditLog.createInvoiceReminder).toHaveBeenCalledWith({
        ownerId: 'user-1',
        invoiceId: 'inv-1',
        actorUserId: 'user-1',
        channel: 'email',
        recipient: 'billing@client.test',
        note: 'Gentle reminder',
        status: 'sent',
      });

      const body = await res.json();
      expect(body.reminder.id).toBe('rem-1');
    });

    it('lists reminder candidates for sent invoices with latest reminder timestamp', async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-04-18T12:00:00.000Z'));

      mocks.prisma.invoice.findMany.mockResolvedValue([
        {
          id: 'inv-1',
          owner_id: 'user-1',
          status: 'sent',
          issued_at: new Date('2026-04-01T00:00:00.000Z'),
          due_days: 14,
          client: { id: 'c1', name: 'Client One', company: 'Client Co', email: 'billing@client.test' },
          project: { id: 'p1', name: 'Website' },
        },
      ]);

      mocks.auditLog.listInvoiceReminders.mockResolvedValue([
        {
          id: 'rem-1',
          invoice_id: 'inv-1',
          owner_id: 'user-1',
          actor_user_id: 'user-1',
          channel: 'email',
          recipient: 'billing@client.test',
          note: null,
          status: 'sent',
          sent_at: '2026-04-10T00:00:00.000Z',
          created_at: '2026-04-10T00:00:00.000Z',
        },
      ]);

      const res = await app.request('/api/invoices/reminders', {
        headers: authHeaders(),
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.reminders).toHaveLength(1);
      expect(body.reminders[0]).toMatchObject({
        invoice_id: 'inv-1',
        last_reminded_at: '2026-04-10T00:00:00.000Z',
        due_at: '2026-04-15T00:00:00.000Z',
        is_overdue: true,
      });
    });

    it('lists reminder history for a specific invoice', async () => {
      mocks.prisma.invoice.findFirst.mockResolvedValue({ id: 'inv-1' });
      mocks.auditLog.listInvoiceReminders.mockResolvedValue([
        {
          id: 'rem-2',
          invoice_id: 'inv-1',
          owner_id: 'user-1',
          actor_user_id: 'user-1',
          channel: 'email',
          recipient: 'billing@client.test',
          note: 'Second follow-up',
          status: 'sent',
          sent_at: '2026-04-12T00:00:00.000Z',
          created_at: '2026-04-12T00:00:00.000Z',
        },
      ]);

      const res = await app.request('/api/invoices/inv-1/reminders', {
        headers: authHeaders(),
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toEqual({
        reminders: [
          expect.objectContaining({
            id: 'rem-2',
            invoice_id: 'inv-1',
            note: 'Second follow-up',
          }),
        ],
      });
    });
  });

  describe('audit-events filtering', () => {
    it('rejects non-operator access to audit event timeline', async () => {
      const res = await app.request('/api/audit-events', {
        headers: authHeaders({ role: 'client', userId: 'client-user-1', email: 'client@example.com' }),
      });

      expect(res.status).toBe(403);
    });

    it('validates numeric limit query parameter', async () => {
      const res = await app.request('/api/audit-events?limit=ten', {
        headers: authHeaders(),
      });

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toContain('limit must be a positive integer');
    });

    it('forwards filter params and event_type alias to the audit event source', async () => {
      mocks.auditLog.listAuditEvents.mockResolvedValue([
        {
          id: 'evt-3',
          owner_id: 'user-1',
          actor_id: 'user-1',
          actor_role: 'operator',
          action: 'invoice.reconciled',
          entity_type: 'invoice',
          entity_id: 'inv-1',
          summary: 'Invoice reconciled via RPC',
          details: { source: 'v2' },
          created_at: '2026-04-18T11:30:00.000Z',
        },
        {
          id: 'dup-1',
          owner_id: 'user-1',
          actor_id: 'user-1',
          actor_role: 'operator',
          action: 'invoice.reconciled',
          entity_type: 'invoice',
          entity_id: 'inv-1',
          summary: 'Duplicate from v2',
          details: { source: 'v2' },
          created_at: '2026-04-18T11:00:00.000Z',
        },
      ]);

      const res = await app.request('/api/audit-events?limit=2&entity_type=invoice&entity_id=inv-1&event_type=invoice.reconciled', {
        headers: authHeaders(),
      });

      expect(res.status).toBe(200);
      expect(mocks.auditLog.listAuditEvents).toHaveBeenCalledWith('user-1', {
        limit: 2,
        entityType: 'invoice',
        entityId: 'inv-1',
        action: 'invoice.reconciled',
      });

      const body = await res.json();
      expect(body.events).toHaveLength(2);
      expect(body.events[0].id).toBe('evt-3');
      expect(body.events[1].id).toBe('dup-1');
    });
  });
});
