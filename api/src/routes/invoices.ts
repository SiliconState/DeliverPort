import { Hono, type Context } from 'hono';
import { Prisma } from '@prisma/client';
import { prisma } from '../db.js';
import { authMiddleware } from '../middleware.js';
import {
  isOptionalString,
  parseJsonObjectBody,
  toFiniteNumber,
  toInteger,
  toIsoDate,
  validationError,
  type ValidationIssue,
} from '../validation.js';
import {
  createInvoiceReminder,
  latestSentReminderByInvoice,
  listInvoiceReminders,
  safeLogAuditEvent,
} from '../audit-log.js';

const invoices = new Hono();

invoices.use('*', authMiddleware);

const TRANSFER_EVENT_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55aeb2ff1bca';
const DEFAULT_RECONCILE_LOOKBACK = 120_000;
const DEFAULT_RECONCILE_CONFIRMATIONS = 1;

const BASE_TOKEN_CONFIG = {
  USDC: {
    address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
    decimals: 6,
  },
  USDT: {
    address: '0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2',
    decimals: 6,
  },
} as const;

const REMINDER_CHANNELS = ['email', 'sms', 'whatsapp', 'manual'] as const;
const DEFAULT_REMINDER_CHANNEL = 'email';

type SupportedToken = keyof typeof BASE_TOKEN_CONFIG;

interface JsonRpcError {
  message?: string;
}

interface JsonRpcResponse<T> {
  result?: T;
  error?: JsonRpcError;
}

interface TransferLog {
  blockNumber: string;
  logIndex: string;
  transactionHash: string;
  data: string;
  topics?: string[];
}

function toHex(value: bigint): string {
  return `0x${value.toString(16)}`;
}

function parseHexBigInt(value: string | undefined): bigint | null {
  if (!value || typeof value !== 'string' || !value.startsWith('0x')) {
    return null;
  }

  try {
    return BigInt(value);
  } catch {
    return null;
  }
}

function normalizeAddress(value: string | null): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (!/^0x[a-fA-F0-9]{40}$/.test(trimmed)) return null;
  return trimmed.toLowerCase();
}

function addressTopic(address: string): string {
  return `0x${address.replace(/^0x/, '').toLowerCase().padStart(64, '0')}`;
}

function parseTokenUnits(amount: string, decimals: number): bigint | null {
  const normalized = amount.trim();
  if (!/^\d+(\.\d+)?$/.test(normalized)) return null;

  const [whole, fraction = ''] = normalized.split('.');
  if (fraction.length > decimals) {
    const overflow = fraction.slice(decimals);
    if (/[^0]/.test(overflow)) return null;
  }

  const safeFraction = fraction.slice(0, decimals).padEnd(decimals, '0');
  const encoded = `${whole}${safeFraction}`.replace(/^0+(?=\d)/, '') || '0';

  try {
    return BigInt(encoded);
  } catch {
    return null;
  }
}

function isLaterLog(left: TransferLog, right: TransferLog): boolean {
  const leftBlock = parseHexBigInt(left.blockNumber) ?? 0n;
  const rightBlock = parseHexBigInt(right.blockNumber) ?? 0n;

  if (leftBlock !== rightBlock) {
    return leftBlock > rightBlock;
  }

  const leftIndex = parseHexBigInt(left.logIndex) ?? 0n;
  const rightIndex = parseHexBigInt(right.logIndex) ?? 0n;
  return leftIndex > rightIndex;
}

async function baseRpc<T>(method: string, params: unknown[]): Promise<T> {
  const rpcUrl = process.env.BASE_RPC_URL || 'https://mainnet.base.org';

  const response = await fetch(rpcUrl, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: Date.now(),
      method,
      params,
    }),
  });

  if (!response.ok) {
    throw new Error(`RPC request failed with HTTP ${response.status}`);
  }

  const payload = await response.json() as JsonRpcResponse<T>;

  if (payload.error) {
    throw new Error(payload.error.message || 'RPC returned an error');
  }

  if (payload.result === undefined) {
    throw new Error('RPC response missing result');
  }

  return payload.result;
}

function toPositiveInt(value: unknown): number | null {
  const parsed = toInteger(value);
  if (parsed === null || parsed < 0) return null;
  return parsed;
}

function parseTokenFromInvoice(invoice: { chain: string; token: string }): SupportedToken | null {
  const chain = String(invoice.chain || '').trim().toLowerCase();
  const token = String(invoice.token || '').trim().toUpperCase();

  if (chain !== 'base') return null;
  if (token !== 'USDC' && token !== 'USDT') return null;
  return token as SupportedToken;
}

function parseLookbackFromEnv(): number {
  const parsed = Number.parseInt(process.env.RECONCILE_LOOKBACK_BLOCKS || '', 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_RECONCILE_LOOKBACK;
  return Math.min(Math.max(parsed, 100), 1_500_000);
}

function parseConfirmationsFromEnv(): number {
  const parsed = Number.parseInt(process.env.RECONCILE_MIN_CONFIRMATIONS || '', 10);
  if (!Number.isFinite(parsed) || parsed < 0) return DEFAULT_RECONCILE_CONFIRMATIONS;
  return Math.min(parsed, 200);
}

function resolveInvoiceToken(chain: string, token: string, paymentRail: string): SupportedToken | null {
  const direct = parseTokenFromInvoice({ chain, token });
  if (direct) return direct;

  if (String(chain || '').trim().toLowerCase() !== 'base') return null;

  const rail = String(paymentRail || '').trim().toUpperCase();
  if (rail.includes('USDT')) return 'USDT';
  if (rail.includes('USDC')) return 'USDC';

  return null;
}

async function findMatchingTransfer(params: {
  tokenAddress: string;
  recipientAddress: string;
  expectedUnits: bigint;
  lookbackBlocks: number;
  minConfirmations: number;
}): Promise<{ match: TransferLog | null; latestBlock: bigint; fromBlock: bigint; toBlock: bigint; logsScanned: number }> {
  const latestBlockHex = await baseRpc<string>('eth_blockNumber', []);
  const latestBlock = parseHexBigInt(latestBlockHex);

  if (latestBlock === null) {
    throw new Error('Could not parse latest block number from RPC');
  }

  const confirmations = BigInt(Math.max(0, params.minConfirmations));
  const toBlock = latestBlock > confirmations ? latestBlock - confirmations : 0n;
  const lookback = BigInt(Math.max(1, params.lookbackBlocks));
  const fromBlock = toBlock > lookback ? toBlock - lookback : 0n;

  const logs = await baseRpc<TransferLog[]>('eth_getLogs', [{
    address: params.tokenAddress,
    fromBlock: toHex(fromBlock),
    toBlock: toHex(toBlock),
    topics: [TRANSFER_EVENT_TOPIC, null, addressTopic(params.recipientAddress)],
  }]);

  let match: TransferLog | null = null;

  for (const log of logs) {
    const amount = parseHexBigInt(log.data);
    if (amount === null || amount !== params.expectedUnits) continue;

    if (!match || isLaterLog(log, match)) {
      match = log;
    }
  }

  return {
    match,
    latestBlock,
    fromBlock,
    toBlock,
    logsScanned: logs.length,
  };
}

interface TransactionReceiptLog {
  address?: string;
  topics?: string[];
  data?: string;
  blockNumber?: string;
  logIndex?: string;
  transactionHash?: string;
}

interface TransactionReceipt {
  status?: string;
  blockNumber?: string;
  transactionHash?: string;
  logs?: TransactionReceiptLog[];
}

interface TxHashVerificationResult {
  verified: boolean;
  reason: string;
  txHash: string;
  tokenAddress: string;
  destinationAddress: string;
  expectedAmountUnits: string;
  latestBlock: string | null;
  blockNumber: string | null;
  confirmations: number | null;
  matchedLogIndex: string | null;
}

function parseBooleanInput(value: unknown, field: string): { ok: true; value: boolean } | { ok: false; error: string } {
  if (typeof value === 'boolean') {
    return { ok: true, value };
  }

  return {
    ok: false,
    error: `${field} must be a boolean when provided`,
  };
}

function envFlagEnabled(raw: string | undefined, defaultValue = false): boolean {
  if (!raw) return defaultValue;

  const normalized = raw.trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  return defaultValue;
}

function defaultRequireTxVerification(): boolean {
  return envFlagEnabled(process.env.RECONCILE_REQUIRE_TX_VERIFICATION, true);
}

async function verifyTransferByTxHash(params: {
  txHash: string;
  tokenAddress: string;
  recipientAddress: string;
  expectedUnits: bigint;
  minConfirmations: number;
}): Promise<TxHashVerificationResult> {
  const receipt = await baseRpc<TransactionReceipt | null>('eth_getTransactionReceipt', [params.txHash]);

  if (!receipt) {
    return {
      verified: false,
      reason: 'tx_not_found',
      txHash: params.txHash,
      tokenAddress: params.tokenAddress,
      destinationAddress: params.recipientAddress,
      expectedAmountUnits: params.expectedUnits.toString(),
      latestBlock: null,
      blockNumber: null,
      confirmations: null,
      matchedLogIndex: null,
    };
  }

  const txStatus = parseHexBigInt(receipt.status);
  if (txStatus !== null && txStatus !== 1n) {
    return {
      verified: false,
      reason: 'tx_failed',
      txHash: params.txHash,
      tokenAddress: params.tokenAddress,
      destinationAddress: params.recipientAddress,
      expectedAmountUnits: params.expectedUnits.toString(),
      latestBlock: null,
      blockNumber: receipt.blockNumber || null,
      confirmations: null,
      matchedLogIndex: null,
    };
  }

  const latestBlockHex = await baseRpc<string>('eth_blockNumber', []);
  const latestBlock = parseHexBigInt(latestBlockHex);
  const txBlock = parseHexBigInt(receipt.blockNumber);

  if (latestBlock === null || txBlock === null) {
    return {
      verified: false,
      reason: 'invalid_block_data',
      txHash: params.txHash,
      tokenAddress: params.tokenAddress,
      destinationAddress: params.recipientAddress,
      expectedAmountUnits: params.expectedUnits.toString(),
      latestBlock: latestBlock ? toHex(latestBlock) : null,
      blockNumber: txBlock ? toHex(txBlock) : (receipt.blockNumber || null),
      confirmations: null,
      matchedLogIndex: null,
    };
  }

  const confirmations = Number(latestBlock >= txBlock ? (latestBlock - txBlock + 1n) : 0n);
  if (confirmations < Math.max(0, params.minConfirmations)) {
    return {
      verified: false,
      reason: 'insufficient_confirmations',
      txHash: params.txHash,
      tokenAddress: params.tokenAddress,
      destinationAddress: params.recipientAddress,
      expectedAmountUnits: params.expectedUnits.toString(),
      latestBlock: toHex(latestBlock),
      blockNumber: toHex(txBlock),
      confirmations,
      matchedLogIndex: null,
    };
  }

  const logs = Array.isArray(receipt.logs) ? receipt.logs : [];
  const normalizedTokenAddress = params.tokenAddress.toLowerCase();
  const expectedRecipientTopic = addressTopic(params.recipientAddress);

  const matchedLog = logs.find((log) => {
    if (typeof log.address !== 'string' || log.address.toLowerCase() !== normalizedTokenAddress) return false;

    const topics = Array.isArray(log.topics) ? log.topics : [];
    if (topics.length < 3) return false;
    if (topics[0]?.toLowerCase() !== TRANSFER_EVENT_TOPIC.toLowerCase()) return false;
    if (topics[2]?.toLowerCase() !== expectedRecipientTopic.toLowerCase()) return false;

    const amount = parseHexBigInt(typeof log.data === 'string' ? log.data : undefined);
    return amount !== null && amount === params.expectedUnits;
  });

  if (!matchedLog) {
    return {
      verified: false,
      reason: 'transfer_log_not_found',
      txHash: params.txHash,
      tokenAddress: params.tokenAddress,
      destinationAddress: params.recipientAddress,
      expectedAmountUnits: params.expectedUnits.toString(),
      latestBlock: toHex(latestBlock),
      blockNumber: toHex(txBlock),
      confirmations,
      matchedLogIndex: null,
    };
  }

  return {
    verified: true,
    reason: 'verified',
    txHash: params.txHash,
    tokenAddress: params.tokenAddress,
    destinationAddress: params.recipientAddress,
    expectedAmountUnits: params.expectedUnits.toString(),
    latestBlock: toHex(latestBlock),
    blockNumber: toHex(txBlock),
    confirmations,
    matchedLogIndex: matchedLog.logIndex ?? null,
  };
}

function parseNullableId(value: unknown, field: string, issues: ValidationIssue[]): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== 'string') {
    issues.push({ field, message: `${field} must be a string or null when provided` });
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * GET /api/invoices
 * List all invoices owned by the current user.
 * Optional query params: ?client_id=&project_id=&status=
 */
invoices.get('/', async (c) => {
  const { userId } = c.get('user');
  const clientId = c.req.query('client_id');
  const projectId = c.req.query('project_id');
  const status = c.req.query('status');

  const where: Record<string, unknown> = { owner_id: userId };
  if (clientId) where.client_id = clientId;
  if (projectId) where.project_id = projectId;
  if (status) where.status = status;

  const records = await prisma.invoice.findMany({
    where,
    include: {
      client: { select: { id: true, name: true, company: true } },
      project: { select: { id: true, name: true } },
    },
    orderBy: { issued_at: 'desc' },
  });

  return c.json({ invoices: records });
});

/**
 * GET /api/invoices/reminders
 * Return reminder candidates for sent invoices + latest reminder timestamp.
 */
invoices.get('/reminders', async (c) => {
  const { userId } = c.get('user');

  const [sentInvoices, reminderHistory] = await Promise.all([
    prisma.invoice.findMany({
      where: {
        owner_id: userId,
        status: 'sent',
      },
      include: {
        client: { select: { id: true, name: true, company: true, email: true } },
        project: { select: { id: true, name: true } },
      },
      orderBy: { issued_at: 'asc' },
    }),
    listInvoiceReminders(userId),
  ]);

  const latestReminderByInvoice = latestSentReminderByInvoice(reminderHistory);
  const now = Date.now();

  const reminders = sentInvoices.map((invoice) => {
    const dueAt = new Date(invoice.issued_at.getTime() + Math.max(0, invoice.due_days) * 24 * 3600 * 1000);
    const dueAtIso = dueAt.toISOString();
    const isOverdue = dueAt.getTime() < now;

    return {
      id: `candidate:${invoice.id}`,
      invoice_id: invoice.id,
      due_at: dueAtIso,
      is_overdue: isOverdue,
      last_reminded_at: latestReminderByInvoice.get(invoice.id) ?? null,
      reason: isOverdue ? 'Overdue reminder candidate' : 'Due reminder candidate',
      invoice,
    };
  });

  return c.json({ reminders });
});

const markInvoiceReminderSent = async (c: Context) => {
  const { userId, role } = c.get('user');
  const id = c.req.param('id');

  const parsed = await parseJsonObjectBody(c);
  if (!parsed.ok) return parsed.response;

  const body = parsed.body;
  const channel = typeof body.channel === 'string' && body.channel.trim()
    ? body.channel.trim().toLowerCase()
    : DEFAULT_REMINDER_CHANNEL;

  if (!REMINDER_CHANNELS.includes(channel as (typeof REMINDER_CHANNELS)[number])) {
    return c.json({ error: `channel must be one of: ${REMINDER_CHANNELS.join(', ')}` }, 400);
  }

  if (!isOptionalString(body.note)) {
    return c.json({ error: 'note must be a string when provided' }, 400);
  }

  if (!isOptionalString(body.recipient)) {
    return c.json({ error: 'recipient must be a string when provided' }, 400);
  }

  const invoice = await prisma.invoice.findFirst({
    where: { id, owner_id: userId },
    include: {
      client: {
        select: {
          email: true,
        },
      },
    },
  });

  if (!invoice) {
    return c.json({ error: 'Invoice not found' }, 404);
  }

  if (invoice.status !== 'sent') {
    return c.json({ error: 'Reminders can only be created for sent invoices' }, 400);
  }

  const reminder = await createInvoiceReminder({
    ownerId: userId,
    invoiceId: invoice.id,
    actorUserId: userId,
    channel,
    recipient: typeof body.recipient === 'string'
      ? body.recipient.trim() || null
      : (invoice.client?.email ?? null),
    note: typeof body.note === 'string' ? body.note.trim() || null : null,
    status: 'sent',
  });

  await safeLogAuditEvent({
    ownerId: userId,
    actorId: userId,
    actorRole: role,
    action: 'invoice.reminder.sent',
    entityType: 'invoice',
    entityId: invoice.id,
    summary: 'Invoice reminder logged',
    details: {
      reminder_id: reminder.id,
      channel,
      recipient: reminder.recipient,
    },
  });

  return c.json({ reminder }, 201);
};

/**
 * POST /api/invoices/:id/reminders/mark-sent
 * Mark/log that a reminder was sent for a sent invoice.
 */
invoices.post('/:id/reminders/mark-sent', markInvoiceReminderSent);

/**
 * POST /api/invoices/:id/remind
 * Legacy alias for mark-sent reminder endpoint.
 */
invoices.post('/:id/remind', markInvoiceReminderSent);

/**
 * GET /api/invoices/:id/reminders
 * List reminder history for one invoice.
 */
invoices.get('/:id/reminders', async (c) => {
  const { userId } = c.get('user');
  const id = c.req.param('id');

  const invoice = await prisma.invoice.findFirst({ where: { id, owner_id: userId }, select: { id: true } });
  if (!invoice) {
    return c.json({ error: 'Invoice not found' }, 404);
  }

  const reminders = await listInvoiceReminders(userId, id);
  return c.json({ reminders });
});

/**
 * POST /api/invoices/:id/reconcile
 * Reconcile a sent Base invoice by verified tx hash or automatic on-chain transfer scan.
 */
invoices.post('/:id/reconcile', async (c) => {
  const { userId, role } = c.get('user');
  const id = c.req.param('id');

  const parsed = await parseJsonObjectBody(c);
  if (!parsed.ok) return parsed.response;

  const body = parsed.body;

  if (!isOptionalString(body.tx_hash) && !isOptionalString(body.external_ref)) {
    return c.json({ error: 'tx_hash/external_ref must be a string when provided' }, 400);
  }

  const txHashInput = typeof body.tx_hash === 'string'
    ? body.tx_hash.trim()
    : (typeof body.external_ref === 'string' ? body.external_ref.trim() : '');

  if (txHashInput && txHashInput.length > 255) {
    return c.json({ error: 'tx_hash is too long' }, 400);
  }

  if (body.require_verification !== undefined) {
    const parsedBoolean = parseBooleanInput(body.require_verification, 'require_verification');
    if (!parsedBoolean.ok) {
      return c.json({ error: parsedBoolean.error }, 400);
    }
  }

  if (body.allow_unverified_tx_hash !== undefined) {
    const parsedBoolean = parseBooleanInput(body.allow_unverified_tx_hash, 'allow_unverified_tx_hash');
    if (!parsedBoolean.ok) {
      return c.json({ error: parsedBoolean.error }, 400);
    }
  }

  const requireVerification = body.require_verification === undefined
    ? defaultRequireTxVerification()
    : Boolean(body.require_verification);

  const allowUnverifiedTxHash = body.allow_unverified_tx_hash === true;

  const lookbackBlocksInput = body.lookback_blocks === undefined ? null : toInteger(body.lookback_blocks);
  if (body.lookback_blocks !== undefined && (lookbackBlocksInput === null || lookbackBlocksInput < 1_000 || lookbackBlocksInput > 500_000)) {
    return c.json({ error: 'lookback_blocks must be an integer between 1000 and 500000 when provided' }, 400);
  }

  const minConfirmationsInput = body.min_confirmations === undefined ? null : toInteger(body.min_confirmations);
  if (body.min_confirmations !== undefined && (minConfirmationsInput === null || minConfirmationsInput < 0 || minConfirmationsInput > 200)) {
    return c.json({ error: 'min_confirmations must be an integer between 0 and 200 when provided' }, 400);
  }

  if (body.paid_at !== undefined && body.paid_at !== null && typeof body.paid_at !== 'string') {
    return c.json({ error: 'paid_at must be an ISO date string when provided' }, 400);
  }

  const paidAtIso = body.paid_at ? toIsoDate(body.paid_at) : null;
  if (body.paid_at && !paidAtIso) {
    return c.json({ error: 'paid_at must be a valid date string' }, 400);
  }

  const existing = await prisma.invoice.findFirst({
    where: { id, owner_id: userId },
  });

  if (!existing) {
    return c.json({ error: 'Invoice not found' }, 404);
  }

  if (existing.status === 'paid') {
    return c.json({ invoice: existing, reconciled: false, message: 'Invoice is already paid' });
  }

  if (existing.status !== 'sent') {
    return c.json({ error: 'Only sent invoices can be reconciled' }, 400);
  }

  const minConfirmations = minConfirmationsInput ?? parseConfirmationsFromEnv();
  const txHashPattern = /^0x[a-fA-F0-9]{64}$/;
  let reconciledTxHash = txHashInput || existing.tx_hash;
  let reconciliation: Record<string, unknown> | null = null;

  if (reconciledTxHash && !txHashPattern.test(reconciledTxHash)) {
    if (txHashInput) {
      return c.json({ error: 'tx_hash must be a 0x-prefixed 32-byte hex string' }, 400);
    }
    reconciledTxHash = '';
  }

  if (reconciledTxHash) {
    const token = resolveInvoiceToken(existing.chain, existing.token, existing.payment_rail);
    const destinationAddress = normalizeAddress(existing.payment_address);

    if (!token || !destinationAddress) {
      if (requireVerification && !allowUnverifiedTxHash) {
        return c.json({
          error: 'tx_hash verification requires Base USDC/USDT invoices with a valid EVM payment_address',
          reconciled: false,
          verified: false,
          reason: 'unsupported_invoice_for_verification',
        }, 400);
      }

      reconciliation = {
        mode: 'manual_tx_hash_unverified',
        tx_hash: reconciledTxHash,
        verification: {
          verified: false,
          reason: 'unsupported_invoice_for_verification',
        },
      };
    } else {
      const expectedUnits = parseTokenUnits(existing.total.toString(), BASE_TOKEN_CONFIG[token].decimals);
      if (expectedUnits === null || expectedUnits <= 0n) {
        return c.json({ error: 'Invoice total could not be converted to token units for reconciliation' }, 400);
      }

      let verification: TxHashVerificationResult;
      try {
        verification = await verifyTransferByTxHash({
          txHash: reconciledTxHash,
          tokenAddress: BASE_TOKEN_CONFIG[token].address,
          recipientAddress: destinationAddress,
          expectedUnits,
          minConfirmations,
        });
      } catch (err) {
        return c.json({
          error: 'Failed to verify tx_hash via Base RPC',
          detail: err instanceof Error ? err.message : 'Unknown RPC error',
        }, 502);
      }

      if (!verification.verified) {
        await safeLogAuditEvent({
          ownerId: userId,
          actorId: userId,
          actorRole: role,
          action: 'invoice.reconcile.tx_unverified',
          entityType: 'invoice',
          entityId: id,
          summary: 'tx_hash provided but verification did not pass',
          details: {
            tx_hash: reconciledTxHash,
            require_verification: requireVerification,
            allow_unverified_tx_hash: allowUnverifiedTxHash,
            verification,
          },
        });

        if (requireVerification && !allowUnverifiedTxHash) {
          return c.json({
            invoice: existing,
            reconciled: false,
            verified: false,
            reason: verification.reason,
            message: 'tx_hash verification failed; invoice was not marked paid',
            verification,
          }, 409);
        }

        reconciliation = {
          mode: 'manual_tx_hash_unverified',
          tx_hash: reconciledTxHash,
          verification,
        };
      } else {
        reconciliation = {
          mode: 'tx_hash_verified',
          tx_hash: reconciledTxHash,
          verification,
        };
      }
    }
  }

  if (!reconciledTxHash) {
    const token = resolveInvoiceToken(existing.chain, existing.token, existing.payment_rail);
    if (!token) {
      return c.json({
        error: 'Automatic reconciliation currently supports only Base USDC/USDT invoices. Provide tx_hash for manual reconciliation.',
      }, 400);
    }

    const destinationAddress = normalizeAddress(existing.payment_address);
    if (!destinationAddress) {
      return c.json({ error: 'Invoice payment_address must be a valid EVM address for automatic reconciliation' }, 400);
    }

    const expectedUnits = parseTokenUnits(existing.total.toString(), BASE_TOKEN_CONFIG[token].decimals);
    if (expectedUnits === null || expectedUnits <= 0n) {
      return c.json({ error: 'Invoice total could not be converted to token units for reconciliation' }, 400);
    }

    const lookbackBlocks = lookbackBlocksInput ?? parseLookbackFromEnv();

    let transferResult: {
      match: TransferLog | null;
      latestBlock: bigint;
      fromBlock: bigint;
      toBlock: bigint;
      logsScanned: number;
    };

    try {
      transferResult = await findMatchingTransfer({
        tokenAddress: BASE_TOKEN_CONFIG[token].address,
        recipientAddress: destinationAddress,
        expectedUnits,
        lookbackBlocks,
        minConfirmations,
      });
    } catch (err) {
      return c.json({
        error: 'Failed to reconcile invoice via Base RPC',
        detail: err instanceof Error ? err.message : 'Unknown RPC error',
      }, 502);
    }

    if (!transferResult.match) {
      await safeLogAuditEvent({
        ownerId: userId,
        actorId: userId,
        actorRole: role,
        action: 'invoice.reconcile.checked',
        entityType: 'invoice',
        entityId: id,
        summary: 'Automatic reconciliation check found no matching transfer',
        details: {
          token,
          token_address: BASE_TOKEN_CONFIG[token].address,
          destination_address: destinationAddress,
          expected_amount_units: expectedUnits.toString(),
          lookback_blocks: lookbackBlocks,
          min_confirmations: minConfirmations,
          from_block: toHex(transferResult.fromBlock),
          to_block: toHex(transferResult.toBlock),
          latest_block: toHex(transferResult.latestBlock),
          logs_scanned: transferResult.logsScanned,
        },
      });

      return c.json({
        invoice: existing,
        reconciled: false,
        matched: false,
        message: 'No matching on-chain transfer found in the configured lookback window',
        scan: {
          token,
          token_address: BASE_TOKEN_CONFIG[token].address,
          destination_address: destinationAddress,
          expected_amount_units: expectedUnits.toString(),
          lookback_blocks: lookbackBlocks,
          min_confirmations: minConfirmations,
          from_block: toHex(transferResult.fromBlock),
          to_block: toHex(transferResult.toBlock),
          latest_block: toHex(transferResult.latestBlock),
          logs_scanned: transferResult.logsScanned,
        },
      });
    }

    reconciledTxHash = transferResult.match.transactionHash;

    reconciliation = {
      mode: 'rpc_scan',
      token,
      token_address: BASE_TOKEN_CONFIG[token].address,
      destination_address: destinationAddress,
      expected_amount_units: expectedUnits.toString(),
      tx_hash: reconciledTxHash,
      log_block_number: transferResult.match.blockNumber,
      from_block: toHex(transferResult.fromBlock),
      to_block: toHex(transferResult.toBlock),
      latest_block: toHex(transferResult.latestBlock),
      logs_scanned: transferResult.logsScanned,
      lookback_blocks: lookbackBlocks,
      min_confirmations: minConfirmations,
    };
  }

  const invoice = await prisma.invoice.update({
    where: { id },
    data: {
      status: 'paid',
      tx_hash: reconciledTxHash || null,
      paid_at: paidAtIso ? new Date(paidAtIso) : new Date(),
    },
  });

  await safeLogAuditEvent({
    ownerId: userId,
    actorId: userId,
    actorRole: role,
    action: 'invoice.reconciled',
    entityType: 'invoice',
    entityId: id,
    summary: 'Invoice reconciled and marked as paid',
    details: {
      tx_hash: reconciledTxHash,
      require_verification: requireVerification,
      allow_unverified_tx_hash: allowUnverifiedTxHash,
      reconciliation: reconciliation ?? { mode: 'manual_tx_hash' },
    },
  });

  return c.json({
    invoice,
    reconciled: true,
    reconciliation: reconciliation ?? { mode: 'manual_tx_hash', tx_hash: reconciledTxHash },
  });
});

/**
 * POST /api/invoices
 * Create a new invoice.
 */
invoices.post('/', async (c) => {
  const { userId, role } = c.get('user');
  const parsed = await parseJsonObjectBody(c);
  if (!parsed.ok) return parsed.response;

  const body = parsed.body;
  const issues: ValidationIssue[] = [];

  const clientIdInput = parseNullableId(body.client_id, 'client_id', issues);
  const projectIdInput = parseNullableId(body.project_id, 'project_id', issues);

  for (const field of ['id', 'status', 'currency', 'payment_rail', 'payment_address', 'chain', 'token', 'tx_hash', 'notes'] as const) {
    if (!isOptionalString(body[field])) {
      issues.push({ field, message: `${field} must be a string when provided` });
    }
  }

  if (body.line_items !== undefined && !Array.isArray(body.line_items)) {
    issues.push({ field: 'line_items', message: 'line_items must be an array when provided' });
  }

  const total = body.total === undefined ? null : toFiniteNumber(body.total);
  if (body.total !== undefined && total === null) {
    issues.push({ field: 'total', message: 'total must be a finite number when provided' });
  }

  const dueDays = body.due_days === undefined ? null : toInteger(body.due_days);
  if (body.due_days !== undefined && (dueDays === null || dueDays < 0 || dueDays > 3650)) {
    issues.push({ field: 'due_days', message: 'due_days must be an integer between 0 and 3650' });
  }

  if (issues.length > 0) {
    return validationError(c, issues);
  }

  let clientId = clientIdInput ?? null;
  if (clientId) {
    const client = await prisma.client.findFirst({ where: { id: clientId, owner_id: userId } });
    if (!client) {
      return c.json({ error: 'client_id is not owned by the current user' }, 400);
    }
  }

  let projectId = projectIdInput ?? null;
  if (projectId) {
    const project = await prisma.project.findFirst({
      where: { id: projectId, owner_id: userId },
      select: { id: true, client_id: true },
    });

    if (!project) {
      return c.json({ error: 'project_id is not owned by the current user' }, 400);
    }

    if (!clientId && project.client_id) {
      clientId = project.client_id;
    }

    if (clientId && project.client_id && clientId !== project.client_id) {
      return c.json({ error: 'client_id does not match project_id client' }, 400);
    }
  }

  const invoice = await prisma.invoice.create({
    data: {
      id: typeof body.id === 'string' && body.id.trim() ? body.id.trim() : undefined,
      client_id: clientId,
      project_id: projectId,
      status: typeof body.status === 'string' && body.status.trim() ? body.status.trim() : 'draft',
      line_items: ((body.line_items as unknown[]) ?? []) as Prisma.InputJsonValue,
      total: total ?? 0,
      currency: typeof body.currency === 'string' && body.currency.trim() ? body.currency.trim() : 'USD',
      payment_rail: typeof body.payment_rail === 'string' && body.payment_rail.trim()
        ? body.payment_rail.trim()
        : 'USDC (Base)',
      payment_address: typeof body.payment_address === 'string' ? body.payment_address.trim() || null : null,
      chain: typeof body.chain === 'string' && body.chain.trim() ? body.chain.trim() : 'base',
      token: typeof body.token === 'string' && body.token.trim() ? body.token.trim() : 'USDC',
      tx_hash: typeof body.tx_hash === 'string' ? body.tx_hash.trim() || null : null,
      due_days: dueDays ?? 14,
      notes: typeof body.notes === 'string' ? body.notes : '',
      owner_id: userId,
    },
  });

  await safeLogAuditEvent({
    ownerId: userId,
    actorId: userId,
    actorRole: role,
    action: 'invoice.create',
    entityType: 'invoice',
    entityId: invoice.id,
    summary: 'Invoice created',
  });

  return c.json({ invoice }, 201);
});

/**
 * GET /api/invoices/:id
 */
invoices.get('/:id', async (c) => {
  const { userId } = c.get('user');
  const id = c.req.param('id');

  const invoice = await prisma.invoice.findFirst({
    where: { id, owner_id: userId },
    include: {
      client: { select: { id: true, name: true, company: true, email: true } },
      project: { select: { id: true, name: true } },
    },
  });

  if (!invoice) {
    return c.json({ error: 'Invoice not found' }, 404);
  }

  return c.json({ invoice });
});

/**
 * PUT /api/invoices/:id
 */
invoices.put('/:id', async (c) => {
  const { userId, role } = c.get('user');
  const id = c.req.param('id');
  const parsed = await parseJsonObjectBody(c);
  if (!parsed.ok) return parsed.response;

  const body = parsed.body;
  const issues: ValidationIssue[] = [];

  const clientIdInput = parseNullableId(body.client_id, 'client_id', issues);
  const projectIdInput = parseNullableId(body.project_id, 'project_id', issues);

  for (const field of ['currency', 'payment_rail', 'payment_address', 'chain', 'token', 'tx_hash', 'notes'] as const) {
    if (!isOptionalString(body[field])) {
      issues.push({ field, message: `${field} must be a string when provided` });
    }
  }

  if (body.line_items !== undefined && !Array.isArray(body.line_items)) {
    issues.push({ field: 'line_items', message: 'line_items must be an array when provided' });
  }

  const total = body.total === undefined ? null : toFiniteNumber(body.total);
  if (body.total !== undefined && total === null) {
    issues.push({ field: 'total', message: 'total must be a finite number when provided' });
  }

  const dueDays = body.due_days === undefined ? null : toInteger(body.due_days);
  if (body.due_days !== undefined && (dueDays === null || dueDays < 0 || dueDays > 3650)) {
    issues.push({ field: 'due_days', message: 'due_days must be an integer between 0 and 3650' });
  }

  if (issues.length > 0) {
    return validationError(c, issues);
  }

  const existing = await prisma.invoice.findFirst({
    where: { id, owner_id: userId },
  });

  if (!existing) {
    return c.json({ error: 'Invoice not found' }, 404);
  }

  let clientId = clientIdInput === undefined ? existing.client_id : clientIdInput;
  let projectId = projectIdInput === undefined ? existing.project_id : projectIdInput;

  if (projectId) {
    const project = await prisma.project.findFirst({
      where: { id: projectId, owner_id: userId },
      select: { id: true, client_id: true },
    });

    if (!project) {
      return c.json({ error: 'project_id is not owned by the current user' }, 400);
    }

    if (!clientId && project.client_id) {
      clientId = project.client_id;
    }

    if (clientId && project.client_id && clientId !== project.client_id) {
      return c.json({ error: 'client_id does not match project_id client' }, 400);
    }
  }

  if (clientId) {
    const client = await prisma.client.findFirst({ where: { id: clientId, owner_id: userId } });
    if (!client) {
      return c.json({ error: 'client_id is not owned by the current user' }, 400);
    }
  }

  const invoice = await prisma.invoice.update({
    where: { id },
    data: {
      client_id: clientId,
      project_id: projectId,
      line_items: body.line_items !== undefined
        ? (body.line_items as Prisma.InputJsonValue)
        : (existing.line_items as unknown as Prisma.InputJsonValue),
      total: total ?? existing.total,
      currency: typeof body.currency === 'string' && body.currency.trim() ? body.currency.trim() : existing.currency,
      payment_rail: typeof body.payment_rail === 'string' && body.payment_rail.trim()
        ? body.payment_rail.trim()
        : existing.payment_rail,
      payment_address: body.payment_address === null
        ? null
        : (typeof body.payment_address === 'string' ? body.payment_address.trim() || null : existing.payment_address),
      chain: typeof body.chain === 'string' && body.chain.trim() ? body.chain.trim() : existing.chain,
      token: typeof body.token === 'string' && body.token.trim() ? body.token.trim() : existing.token,
      tx_hash: body.tx_hash === null
        ? null
        : (typeof body.tx_hash === 'string' ? body.tx_hash.trim() || null : existing.tx_hash),
      due_days: dueDays ?? existing.due_days,
      notes: typeof body.notes === 'string' ? body.notes : existing.notes,
    },
  });

  await safeLogAuditEvent({
    ownerId: userId,
    actorId: userId,
    actorRole: role,
    action: 'invoice.update',
    entityType: 'invoice',
    entityId: invoice.id,
    summary: 'Invoice updated',
  });

  return c.json({ invoice });
});

/**
 * PUT /api/invoices/:id/status
 * Change invoice status: draft → sent → paid
 */
invoices.put('/:id/status', async (c) => {
  const { userId, role } = c.get('user');
  const id = c.req.param('id');

  const parsed = await parseJsonObjectBody(c);
  if (!parsed.ok) return parsed.response;

  const body = parsed.body;
  const status = typeof body.status === 'string' ? body.status.trim() : '';
  const txHash = typeof body.tx_hash === 'string'
    ? body.tx_hash.trim()
    : (typeof body.external_ref === 'string' ? body.external_ref.trim() : null);

  if (!status) {
    return c.json({ error: 'status is required' }, 400);
  }

  if (body.tx_hash !== undefined && body.tx_hash !== null && typeof body.tx_hash !== 'string') {
    return c.json({ error: 'tx_hash must be a string when provided' }, 400);
  }

  const existing = await prisma.invoice.findFirst({
    where: { id, owner_id: userId },
  });

  if (!existing) {
    return c.json({ error: 'Invoice not found' }, 404);
  }

  // Validate status transitions
  const validTransitions: Record<string, string[]> = {
    draft: ['sent', 'cancelled'],
    sent: ['paid', 'cancelled', 'draft'],
    paid: [],
    cancelled: ['draft'],
  };

  const allowed = validTransitions[existing.status] || [];
  if (!allowed.includes(status)) {
    return c.json({
      error: `Cannot transition from '${existing.status}' to '${status}'`,
    }, 400);
  }

  const updateData: Record<string, unknown> = { status };
  if (status === 'paid') {
    updateData.paid_at = new Date();
    if (txHash) updateData.tx_hash = txHash;
  }

  const invoice = await prisma.invoice.update({
    where: { id },
    data: updateData,
  });

  await safeLogAuditEvent({
    ownerId: userId,
    actorId: userId,
    actorRole: role,
    action: 'invoice.status.update',
    entityType: 'invoice',
    entityId: id,
    summary: 'Invoice status changed',
    details: {
      from: existing.status,
      to: status,
      tx_hash: txHash,
    },
  });

  return c.json({ invoice });
});

/**
 * DELETE /api/invoices/:id
 */
invoices.delete('/:id', async (c) => {
  const { userId, role } = c.get('user');
  const id = c.req.param('id');

  const existing = await prisma.invoice.findFirst({
    where: { id, owner_id: userId },
  });

  if (!existing) {
    return c.json({ error: 'Invoice not found' }, 404);
  }

  if (existing.status === 'paid') {
    return c.json({ error: 'Cannot delete a paid invoice' }, 400);
  }

  await prisma.invoice.delete({ where: { id } });

  await safeLogAuditEvent({
    ownerId: userId,
    actorId: userId,
    actorRole: role,
    action: 'invoice.delete',
    entityType: 'invoice',
    entityId: id,
    summary: 'Invoice deleted',
  });

  return c.json({ success: true });
});

export default invoices;
