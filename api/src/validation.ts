import type { Context } from 'hono';

export type JsonObject = Record<string, unknown>;

export interface ValidationIssue {
  field: string;
  message: string;
}

export interface StringFieldOptions {
  required?: boolean;
  nullable?: boolean;
  trim?: boolean;
  minLength?: number;
  maxLength?: number;
  allowEmpty?: boolean;
  pattern?: RegExp;
  toLowerCase?: boolean;
}

export interface NumberFieldOptions {
  required?: boolean;
  min?: number;
  max?: number;
  integer?: boolean;
  allowString?: boolean;
}

export interface ArrayFieldOptions {
  required?: boolean;
  maxItems?: number;
}

export interface StringArrayFieldOptions extends ArrayFieldOptions {
  itemMaxLength?: number;
  allowEmptyItems?: boolean;
}

export type ParsedBodyResult =
  | { ok: true; body: JsonObject }
  | { ok: false; response: Response };

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function pushIssue(issues: ValidationIssue[], field: string, message: string): void {
  issues.push({ field, message });
}

/**
 * Safely parse a JSON request body and require an object payload.
 */
export async function parseJsonBody(c: Context): Promise<ParsedBodyResult> {
  try {
    const body = await c.req.json();
    if (!isJsonObject(body)) {
      return {
        ok: false,
        response: c.json({ error: 'Request body must be a JSON object' }, 400),
      };
    }

    return { ok: true, body };
  } catch {
    return {
      ok: false,
      response: c.json({ error: 'Invalid JSON body' }, 400),
    };
  }
}

/**
 * Backward-compatible alias.
 */
export const parseJsonObjectBody = parseJsonBody;

/**
 * Build a standard validation error response payload.
 */
export function validationError(c: Context, issues: ValidationIssue[], message = 'Validation failed'): Response {
  return c.json({ error: message, details: issues }, 400);
}

export function readStringField(
  body: JsonObject,
  field: string,
  issues: ValidationIssue[],
  options: StringFieldOptions = {},
): string | null | undefined {
  const {
    required = false,
    nullable = false,
    trim = true,
    minLength,
    maxLength,
    allowEmpty = !required,
    pattern,
    toLowerCase = false,
  } = options;

  const raw = body[field];

  if (raw === undefined) {
    if (required) pushIssue(issues, field, 'is required');
    return undefined;
  }

  if (raw === null) {
    if (nullable) return null;
    pushIssue(issues, field, 'must be a string');
    return undefined;
  }

  if (typeof raw !== 'string') {
    pushIssue(issues, field, 'must be a string');
    return undefined;
  }

  let value = trim ? raw.trim() : raw;
  if (toLowerCase) value = value.toLowerCase();

  let invalid = false;

  if (!allowEmpty && value.length === 0) {
    pushIssue(issues, field, 'cannot be empty');
    invalid = true;
  }

  if (minLength !== undefined && value.length < minLength) {
    pushIssue(issues, field, `must be at least ${minLength} characters`);
    invalid = true;
  }

  if (maxLength !== undefined && value.length > maxLength) {
    pushIssue(issues, field, `must be at most ${maxLength} characters`);
    invalid = true;
  }

  if (pattern && value.length > 0 && !pattern.test(value)) {
    pushIssue(issues, field, 'has an invalid format');
    invalid = true;
  }

  return invalid ? undefined : value;
}

export function readEnumField<T extends string>(
  body: JsonObject,
  field: string,
  allowed: readonly T[],
  issues: ValidationIssue[],
  options: { required?: boolean } = {},
): T | undefined {
  const { required = false } = options;
  const raw = body[field];

  if (raw === undefined) {
    if (required) pushIssue(issues, field, 'is required');
    return undefined;
  }

  if (typeof raw !== 'string' || !allowed.includes(raw as T)) {
    pushIssue(issues, field, `must be one of: ${allowed.join(', ')}`);
    return undefined;
  }

  return raw as T;
}

export function readNumberField(
  body: JsonObject,
  field: string,
  issues: ValidationIssue[],
  options: NumberFieldOptions = {},
): number | undefined {
  const {
    required = false,
    min,
    max,
    integer = false,
    allowString = true,
  } = options;

  const raw = body[field];

  if (raw === undefined) {
    if (required) pushIssue(issues, field, 'is required');
    return undefined;
  }

  let value: number;

  if (typeof raw === 'number') {
    value = raw;
  } else if (allowString && typeof raw === 'string' && raw.trim().length > 0) {
    value = Number(raw.trim());
  } else {
    pushIssue(issues, field, 'must be a number');
    return undefined;
  }

  let invalid = false;

  if (!Number.isFinite(value)) {
    pushIssue(issues, field, 'must be a finite number');
    invalid = true;
  }

  if (integer && !Number.isInteger(value)) {
    pushIssue(issues, field, 'must be an integer');
    invalid = true;
  }

  if (min !== undefined && value < min) {
    pushIssue(issues, field, `must be >= ${min}`);
    invalid = true;
  }

  if (max !== undefined && value > max) {
    pushIssue(issues, field, `must be <= ${max}`);
    invalid = true;
  }

  return invalid ? undefined : value;
}

export function readArrayField(
  body: JsonObject,
  field: string,
  issues: ValidationIssue[],
  options: ArrayFieldOptions = {},
): unknown[] | undefined {
  const { required = false, maxItems } = options;
  const raw = body[field];

  if (raw === undefined) {
    if (required) pushIssue(issues, field, 'is required');
    return undefined;
  }

  if (!Array.isArray(raw)) {
    pushIssue(issues, field, 'must be an array');
    return undefined;
  }

  if (maxItems !== undefined && raw.length > maxItems) {
    pushIssue(issues, field, `must have at most ${maxItems} items`);
    return undefined;
  }

  return raw;
}

export function readStringArrayField(
  body: JsonObject,
  field: string,
  issues: ValidationIssue[],
  options: StringArrayFieldOptions = {},
): string[] | undefined {
  const {
    required = false,
    maxItems,
    itemMaxLength,
    allowEmptyItems = false,
  } = options;

  const raw = body[field];

  if (raw === undefined) {
    if (required) pushIssue(issues, field, 'is required');
    return undefined;
  }

  if (!Array.isArray(raw)) {
    pushIssue(issues, field, 'must be an array of strings');
    return undefined;
  }

  if (maxItems !== undefined && raw.length > maxItems) {
    pushIssue(issues, field, `must have at most ${maxItems} items`);
    return undefined;
  }

  const output: string[] = [];

  for (let i = 0; i < raw.length; i += 1) {
    const item = raw[i];

    if (typeof item !== 'string') {
      pushIssue(issues, `${field}[${i}]`, 'must be a string');
      continue;
    }

    const normalized = item.trim();

    if (!allowEmptyItems && normalized.length === 0) {
      pushIssue(issues, `${field}[${i}]`, 'cannot be empty');
      continue;
    }

    if (itemMaxLength !== undefined && normalized.length > itemMaxLength) {
      pushIssue(issues, `${field}[${i}]`, `must be at most ${itemMaxLength} characters`);
      continue;
    }

    output.push(normalized);
  }

  return output;
}

export function readObjectField(
  body: JsonObject,
  field: string,
  issues: ValidationIssue[],
  options: { required?: boolean } = {},
): JsonObject | undefined {
  const { required = false } = options;
  const raw = body[field];

  if (raw === undefined) {
    if (required) pushIssue(issues, field, 'is required');
    return undefined;
  }

  if (!isJsonObject(raw)) {
    pushIssue(issues, field, 'must be an object');
    return undefined;
  }

  return raw;
}

export function clampInt(value: string | undefined, fallback: number, min: number, max: number): number {
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

// Backward-compatible helper exports.
export function isPlainObject(value: unknown): value is JsonObject {
  return isJsonObject(value);
}

export function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

export function isOptionalString(value: unknown): value is string | null | undefined {
  return value === undefined || value === null || typeof value === 'string';
}

export function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

export function normalizeEmail(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const email = value.trim().toLowerCase();
  return email.length > 0 ? email : null;
}

export function isValidEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

export function toTrimmedString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function toOptionalTrimmedString(value: unknown): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function toFiniteNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

export function toInteger(value: unknown): number | null {
  const parsed = toFiniteNumber(value);
  if (parsed === null || !Number.isInteger(parsed)) return null;
  return parsed;
}

export function toIsoDate(value: unknown): string | null {
  if (typeof value !== 'string' || value.trim() === '') return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString();
}
