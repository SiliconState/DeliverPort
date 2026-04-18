import { Hono, type Context } from 'hono';
import { randomBytes } from 'crypto';
import type { Prisma } from '@prisma/client';
import { prisma } from '../db.js';
import { authMiddleware } from '../middleware.js';
import {
  parseJsonBody,
  readArrayField,
  readEnumField,
  readStringField,
  validationError,
  type JsonObject,
  type ValidationIssue,
} from '../validation.js';
import { safeLogAuditEvent } from '../audit-log.js';

const projects = new Hono();

projects.use('*', authMiddleware);

const PROJECT_STATUSES = ['active', 'delivery', 'archived', 'paused', 'completed'] as const;
const DELIVERABLE_APPROVAL_DECISIONS = ['approved', 'rejected'] as const;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asInputJson(value: unknown): Prisma.InputJsonValue {
  return value as Prisma.InputJsonValue;
}

function hasBodyField(body: JsonObject, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(body, key);
}

function cloneDeliverables(value: unknown): unknown[] {
  if (!Array.isArray(value)) return [];

  return value.map((item) => {
    if (isPlainObject(item)) {
      return { ...item };
    }
    return item;
  });
}

function deliverableIdentity(item: unknown, index: number): string {
  if (!isPlainObject(item)) return String(index);

  const candidate = item.id ?? item.deliverable_id ?? item.deliverableId;
  if (typeof candidate === 'string' && candidate.trim().length > 0) {
    return candidate.trim();
  }

  return `del_${index + 1}`;
}

function resolveDeliverableIndex(deliverables: unknown[], deliverableRef: string): number {
  const numericIndex = Number.parseInt(deliverableRef, 10);
  if (Number.isInteger(numericIndex) && numericIndex >= 0 && numericIndex < deliverables.length) {
    return numericIndex;
  }

  const normalizedRef = deliverableRef.trim();
  if (normalizedRef.length === 0) return -1;

  return deliverables.findIndex((item, index) => {
    const identity = deliverableIdentity(item, index);
    return identity === normalizedRef;
  });
}

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
  const auth = c.get('user');
  const { userId } = auth;
  const parsed = await parseJsonBody(c);
  if (!parsed.ok) return parsed.response;

  const body = parsed.body;
  const issues: ValidationIssue[] = [];

  const id = readStringField(body, 'id', issues, {
    maxLength: 128,
  });

  const clientId = readStringField(body, 'client_id', issues, {
    nullable: true,
    maxLength: 128,
  });

  const name = readStringField(body, 'name', issues, {
    required: true,
    minLength: 1,
    maxLength: 200,
  });

  const description = readStringField(body, 'description', issues, {
    nullable: true,
    maxLength: 5000,
  });

  const status = readEnumField(body, 'status', PROJECT_STATUSES, issues);

  const portalToken = readStringField(body, 'portal_token', issues, {
    nullable: true,
    maxLength: 128,
  });

  const deliverables = readArrayField(body, 'deliverables', issues, {
    maxItems: 500,
  });

  if (issues.length > 0) {
    return validationError(c, issues);
  }

  if (clientId) {
    const client = await prisma.client.findFirst({
      where: {
        id: clientId,
        owner_id: userId,
      },
      select: { id: true },
    });

    if (!client) {
      return c.json({ error: 'client_id must refer to one of your clients' }, 400);
    }
  }

  const project = await prisma.project.create({
    data: {
      id: id && id.length > 0 ? id : undefined,
      client_id: clientId ?? null,
      name: name as string,
      description: description ?? '',
      status: status ?? 'active',
      portal_token: portalToken && portalToken.length > 0 ? portalToken : randomBytes(16).toString('hex'),
      deliverables: asInputJson(deliverables ?? []),
      owner_id: userId,
    },
  });

  await safeLogAuditEvent({
    ownerId: userId,
    actorId: userId,
    actorRole: auth.role,
    action: 'project.created',
    entityType: 'project',
    entityId: project.id,
    summary: 'Project created',
    details: {
      project_name: project.name,
      client_id: project.client_id,
    },
  });

  return c.json({ project }, 201);
});

/**
 * PUT/POST /api/projects/:id/deliverables/:deliverable/approval
 * Client or owner-operator can approve/reject one deliverable.
 */
const handleDeliverableApproval = async (c: Context) => {
  const auth = c.get('user');
  const projectId = c.req.param('id');
  const deliverableRef = decodeURIComponent(c.req.param('deliverable') || c.req.param('deliverableId') || '');
  if (!deliverableRef) {
    return c.json({ error: 'deliverable reference is required' }, 400);
  }

  const parsed = await parseJsonBody(c);
  if (!parsed.ok) return parsed.response;

  const body = parsed.body;
  const issues: ValidationIssue[] = [];

  const decision = readEnumField(body, 'decision', DELIVERABLE_APPROVAL_DECISIONS, issues, {
    required: true,
  });

  const note = readStringField(body, 'note', issues, {
    nullable: true,
    maxLength: 2000,
  });

  if (issues.length > 0) {
    return validationError(c, issues);
  }

  const project = await prisma.project.findUnique({
    where: { id: projectId },
    select: {
      id: true,
      owner_id: true,
      client_id: true,
      deliverables: true,
    },
  });

  if (!project) {
    return c.json({ error: 'Project not found' }, 404);
  }

  let authorized = false;

  if (auth.role === 'operator') {
    authorized = project.owner_id === auth.userId;
  } else if (auth.role === 'client') {
    const actorProfile = await prisma.user.findUnique({
      where: { id: auth.userId },
      select: { client_id: true },
    });

    authorized = Boolean(actorProfile?.client_id && project.client_id && actorProfile.client_id === project.client_id);
  }

  if (!authorized) {
    return c.json({ error: 'Not authorized to approve deliverables for this project' }, 403);
  }

  const deliverables = cloneDeliverables(project.deliverables);
  const deliverableIndex = resolveDeliverableIndex(deliverables, deliverableRef);

  if (deliverableIndex < 0) {
    return c.json({ error: 'Deliverable not found' }, 404);
  }

  const existingDeliverable = deliverables[deliverableIndex];
  const deliverableObject: Record<string, unknown> = isPlainObject(existingDeliverable)
    ? { ...existingDeliverable }
    : { value: existingDeliverable };

  const approvedAt = new Date().toISOString();

  deliverableObject.approval = {
    status: decision,
    note: note ?? '',
    at: approvedAt,
    actor_user_id: auth.userId,
    actor_role: auth.role,
  };
  deliverableObject.approval_status = decision;
  deliverableObject.approval_note = note ?? '';
  deliverableObject.approved_at = approvedAt;
  deliverableObject.approved_by_user_id = auth.userId;
  deliverableObject.client_approval_status = decision;

  deliverables[deliverableIndex] = deliverableObject;

  const updated = await prisma.project.update({
    where: { id: project.id },
    data: {
      deliverables: asInputJson(deliverables),
    },
    select: {
      id: true,
      deliverables: true,
      owner_id: true,
    },
  });

  await safeLogAuditEvent({
    ownerId: updated.owner_id,
    actorId: auth.userId,
    actorRole: auth.role,
    action: 'project.deliverable.approval',
    entityType: 'project',
    entityId: project.id,
    summary: `Deliverable ${deliverableRef} ${decision}`,
    details: {
      deliverable_ref: deliverableRef,
      deliverable_index: deliverableIndex,
      decision,
      note: note ?? '',
    },
  });

  const updatedDeliverables = cloneDeliverables(updated.deliverables);

  return c.json({
    project_id: updated.id,
    deliverable_index: deliverableIndex,
    deliverable: updatedDeliverables[deliverableIndex] ?? null,
    deliverables: updatedDeliverables,
  });
};

projects.put('/:id/deliverables/:deliverable/approval', handleDeliverableApproval);
projects.post('/:id/deliverables/:deliverable/approval', handleDeliverableApproval);

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
  const auth = c.get('user');
  const { userId } = auth;
  const id = c.req.param('id');
  const parsed = await parseJsonBody(c);
  if (!parsed.ok) return parsed.response;

  const body = parsed.body;
  const issues: ValidationIssue[] = [];

  const hasClientId = hasBodyField(body, 'client_id');
  const hasName = hasBodyField(body, 'name');
  const hasDescription = hasBodyField(body, 'description');
  const hasStatus = hasBodyField(body, 'status');
  const hasPortalToken = hasBodyField(body, 'portal_token');
  const hasDeliverables = hasBodyField(body, 'deliverables');

  const clientId = readStringField(body, 'client_id', issues, {
    nullable: true,
    maxLength: 128,
  });

  const name = readStringField(body, 'name', issues, {
    minLength: 1,
    maxLength: 200,
  });

  const description = readStringField(body, 'description', issues, {
    nullable: true,
    maxLength: 5000,
  });

  const status = readEnumField(body, 'status', PROJECT_STATUSES, issues);

  const portalToken = readStringField(body, 'portal_token', issues, {
    nullable: true,
    maxLength: 128,
  });

  const deliverables = readArrayField(body, 'deliverables', issues, {
    maxItems: 500,
  });

  if (issues.length > 0) {
    return validationError(c, issues);
  }

  const existing = await prisma.project.findFirst({
    where: { id, owner_id: userId },
  });

  if (!existing) {
    return c.json({ error: 'Project not found' }, 404);
  }

  if (hasClientId && clientId) {
    const client = await prisma.client.findFirst({
      where: {
        id: clientId,
        owner_id: userId,
      },
      select: { id: true },
    });

    if (!client) {
      return c.json({ error: 'client_id must refer to one of your clients' }, 400);
    }
  }

  const updateData: Prisma.ProjectUncheckedUpdateInput = {};

  if (hasClientId) updateData.client_id = clientId ?? null;
  if (hasName) updateData.name = name ?? existing.name;
  if (hasDescription) updateData.description = description ?? '';
  if (hasStatus) updateData.status = status ?? existing.status;
  if (hasPortalToken) updateData.portal_token = portalToken ?? null;
  if (hasDeliverables) updateData.deliverables = asInputJson(deliverables ?? []);

  const project = await prisma.project.update({
    where: { id },
    data: updateData,
  });

  await safeLogAuditEvent({
    ownerId: userId,
    actorId: userId,
    actorRole: auth.role,
    action: 'project.updated',
    entityType: 'project',
    entityId: project.id,
    summary: 'Project updated',
  });

  return c.json({ project });
});

/**
 * DELETE /api/projects/:id
 */
projects.delete('/:id', async (c) => {
  const auth = c.get('user');
  const { userId } = auth;
  const id = c.req.param('id');

  const existing = await prisma.project.findFirst({
    where: { id, owner_id: userId },
  });

  if (!existing) {
    return c.json({ error: 'Project not found' }, 404);
  }

  await prisma.project.delete({ where: { id } });

  await safeLogAuditEvent({
    ownerId: userId,
    actorId: userId,
    actorRole: auth.role,
    action: 'project.deleted',
    entityType: 'project',
    entityId: id,
    summary: 'Project deleted',
  });

  return c.json({ success: true });
});

export default projects;
