import 'server-only';
import { eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { db, type Tx } from '@/db';
import { auditLog, users } from '@/db/schema';
import { loadPrincipal, type Principal } from '@/lib/auth/groups';
import { HttpError } from '@/lib/authz';
import { requireAdmin } from '@/lib/session';
import { assertNoCodexWork, lockPersonalOwner } from '@/personal-codex/accounts';
import { personalSocket } from '@/personal-codex/control';
import { SandboxAdminAction, unavailableAdminSnapshot, type SandboxAdminAction as SandboxAdminActionType,
  type SandboxAdminPageData, type SandboxAdminResult, type SandboxAdminSnapshot } from '@/personal-codex/admin-contracts';
import { LOCAL_ORIGIN, socketFetch } from '@/lib/local-hermes/client';

const ownerId = z.string().min(1).max(256).regex(/^[a-zA-Z0-9_-]+$/);
const CheckSchema = z.object({ id: z.string().max(64), label: z.string().max(100), state: z.enum(['passed', 'failed', 'unknown']), detail: z.string().max(256) }).strict();
const TemplateSchema = z.object({ reference: z.string().max(512), label: z.string().max(100), available: z.boolean().nullable(), inUse: z.number().int().nonnegative() }).strict();
const ValidationSchema = z.object({ id: z.enum(['sbx', 'desktop', 'containment', 'inference']), result: z.enum(['passed', 'failed', 'pending']), reference: z.string().max(300),
  checkedAt: z.string().datetime().nullable(), checkedBy: z.string().max(256).nullable(), template: z.string().max(512), source: z.literal('operator') }).strict();
const RuntimeSchema = z.object({ ownerId, admitted: z.boolean(), state: z.enum(['running', 'stopped', 'missing', 'unavailable']), cpus: z.number().int().min(1).max(64),
  memoryMb: z.number().int().min(512).max(65536), template: z.string().max(512), activeSessions: z.number().int().nonnegative().nullable(),
  credentialState: z.enum(['synchronized', 'sync_required', 'operator_unverified']),
  computer: z.object({ available: z.boolean(), paused: z.boolean(), control: z.enum(['agent', 'human', 'paused', 'unavailable']), lastFrameAt: z.string().datetime().nullable() }).strict() }).strict();
const SnapshotSchema = z.object({ available: z.boolean(), reason: z.string().max(256).nullable(), checkedAt: z.string().datetime(), backend: z.enum(['sbx', 'docker', 'unconfigured']),
  version: z.string().max(80).nullable(), checks: z.array(CheckSchema).max(64),
  settings: z.object({ revision: z.number().int().nonnegative(), cpus: z.number().int().min(1).max(64), memoryMb: z.number().int().min(512).max(65536),
    maxRunning: z.number().int().min(1).max(1000), defaultTemplate: z.string().max(512), admittedOwners: z.array(ownerId).max(1000) }).strict(),
  runtimes: z.array(RuntimeSchema).max(1000), templates: z.array(TemplateSchema).max(128),
  archives: z.array(z.object({ name: z.string().max(128), sizeBytes: z.number().int().nonnegative() }).strict()).max(1000),
  validation: z.array(ValidationSchema).max(4), siwcSandboxVerified: z.boolean() }).strict();
const RuleSchema = z.object({ id: z.string().uuid(), ownerId, effect: z.enum(['allow', 'deny']), destination: z.string().max(253), createdAt: z.string().datetime() }).strict();
const NetworkSchema = z.object({ ownerId, rules: z.array(RuleSchema).max(256), observed: z.boolean(), eventsObserved: z.boolean(), note: z.string().max(256),
  events: z.array(z.object({ at: z.string().datetime().nullable(), destination: z.string().max(253), decision: z.enum(['allowed', 'denied', 'unknown']) }).strict()).max(128) }).strict();
const ResultSchema = z.object({ message: z.string().min(1).max(256), network: NetworkSchema.optional(),
  networkCheck: z.object({ destination: z.string().max(253), decision: z.enum(['allowed', 'denied', 'unknown']), detail: z.string().max(256) }).strict().optional(),
  diagnostics: z.object({ checkedAt: z.string().datetime(), checks: z.array(CheckSchema).max(64), source: z.literal('host'), liveComputerUseVerified: z.literal(false) }).strict().optional() }).strict();
const ErrorCode = z.enum(['invalid_action', 'invalid_request', 'revision_conflict', 'admin_unavailable', 'admin_operation_failed', 'mutation_failed', 'state_write_failed',
  'owner_not_found', 'owner_not_admitted', 'template_not_approved', 'template_unavailable', 'template_exists', 'template_in_use',
  'confirmation_required', 'archive_not_found', 'template_not_found', 'network_rule_not_found']);
const ERROR_MESSAGES: Record<z.infer<typeof ErrorCode>, string> = {
  invalid_action: 'The SBX administration request is invalid.',
  invalid_request: 'The SBX administration request is invalid.',
  revision_conflict: 'SBX administration changed. Refresh and retry.',
  admin_unavailable: 'SBX administration is unavailable or needs operator reconciliation.',
  admin_operation_failed: 'The SBX administration request could not be completed.',
  mutation_failed: 'The SBX administration request could not be completed.',
  state_write_failed: 'SBX administration state could not be saved.',
  owner_not_found: 'This owner is not configured for SBX administration.',
  owner_not_admitted: 'Admit this owner before using SBX runtime controls.',
  template_not_approved: 'Approve this template before using it for a runtime.',
  template_unavailable: 'The pinned template is unavailable in the host catalog.',
  template_exists: 'This pinned template is already approved.',
  template_in_use: 'This template is still used by a retained runtime.',
  confirmation_required: 'Confirm sandbox deletion by typing DELETE.',
  archive_not_found: 'Choose an archive from the current host inbox.',
  template_not_found: 'This template is not in the approved catalog.',
  network_rule_not_found: 'This network rule is no longer available.',
};
const ACTION_TIMEOUT_MS = 90_000;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;

async function boundedJson(response: Response) {
  const declared = Number(response.headers.get('content-length') ?? 0);
  if (declared > MAX_RESPONSE_BYTES) throw new Error('response too large');
  if (!response.body) throw new Error('missing response body');
  const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_RESPONSE_BYTES) { await reader.cancel(); throw new Error('response too large'); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
}

async function brokerRequest<T>(path: '/admin/snapshot', schema: typeof SnapshotSchema): Promise<T>;
async function brokerRequest<T>(path: '/admin/action', schema: typeof ResultSchema, body: unknown): Promise<T>;
async function brokerRequest<T>(path: '/admin/snapshot' | '/admin/action', schema: typeof SnapshotSchema | typeof ResultSchema, body?: unknown): Promise<T> {
  try {
    const response = await socketFetch(personalSocket())(`${LOCAL_ORIGIN}${path}`, { method: body === undefined ? 'GET' : 'POST',
      headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(ACTION_TIMEOUT_MS) });
    const value = await boundedJson(response);
    if (!response.ok) {
      const err = z.object({ code: ErrorCode }).passthrough().safeParse(value);
      const code = err.success ? err.data.code : 'admin_unavailable';
      throw new HttpError(response.status, ERROR_MESSAGES[code]);
    }
    const parsed = schema.safeParse(value);
    if (!parsed.success) throw new Error('invalid broker response');
    return parsed.data as T;
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(503, 'The SBX broker is unavailable. Refresh to check its current state before retrying.');
  }
}

async function freshAdmin(p: Principal, tx: Tx) {
  const fresh = await loadPrincipal(p.user.id, tx);
  if (!fresh?.isAdmin || fresh.user.disabled || fresh.user.sessionVersion !== p.user.sessionVersion)
    throw new HttpError(403, 'Admin access changed. Sign in again before retrying.');
}

function ownerOf(action: SandboxAdminActionType): string | null {
  return 'ownerId' in action ? action.ownerId : null;
}
function auditSummary(action: SandboxAdminActionType): Record<string, unknown> {
  switch (action.action) {
    case 'settings': return { action: action.action, revision: action.revision, cpus: action.cpus, memoryMb: action.memoryMb, maxRunning: action.maxRunning, defaultTemplate: action.defaultTemplate };
    case 'enrollment': return { action: action.action, revision: action.revision, ownerId: action.ownerId, admitted: action.admitted };
    case 'lifecycle': return { action: action.action, ownerId: action.ownerId, operation: action.operation };
    case 'template-add': return { action: action.action, revision: action.revision, reference: action.reference, label: action.label };
    case 'template-remove': return { action: action.action, revision: action.revision, reference: action.reference };
    case 'template-import': return { action: action.action, revision: action.revision, reference: action.reference, archive: action.archive };
    case 'network-add': return { action: action.action, ownerId: action.ownerId, effect: action.effect, destination: action.destination };
    case 'network-remove': return { action: action.action, ownerId: action.ownerId, ruleId: action.ruleId };
    case 'network-check': return { action: action.action, ownerId: action.ownerId, destination: action.destination };
    case 'network-read': return { action: action.action, ownerId: action.ownerId };
    case 'diagnose': return { action: action.action };
    case 'validation': return { action: action.action, revision: action.revision, id: action.id, result: action.result, referencePresent: !!action.reference };
  }
}
const requestAudit = async (p: Principal, action: SandboxAdminActionType) => db.transaction(async tx => {
  const target = ownerOf(action);
  if (target) {
    await lockPersonalOwner(target, tx);
  } else {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext('personal-codex-sbx-admin'))`);
  }
  await freshAdmin(p, tx);
  const [row] = await tx.insert(auditLog).values({ actorId: p.user.id, action: 'personal_codex.sbx.admin', target,
    details: { status: 'requested', request: auditSummary(action) } }).returning({ id: auditLog.id });
  return row.id as string;
});

async function dispatch(p: Principal, action: SandboxAdminActionType, auditId: string) {
  const target = ownerOf(action);
  return db.transaction(async tx => {
    let owner: Awaited<ReturnType<typeof lockPersonalOwner>> | undefined;
    if (target) {
      owner = await lockPersonalOwner(target, tx);
      const mustBeEnabled = action.action === 'enrollment' ? action.admitted : action.action === 'lifecycle' && ['provision', 'start'].includes(action.operation);
      if (mustBeEnabled && owner.disabled) throw new HttpError(403, 'Disabled users cannot be admitted or started.');
      if ((action.action === 'enrollment' && !action.admitted) || (action.action === 'lifecycle' && ['provision', 'start', 'delete'].includes(action.operation)))
        await assertNoCodexWork(target, tx);
    } else {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext('personal-codex-sbx-admin'))`);
    }
    // Recheck admin after all lock waits and directly before the protected broker dispatch.
    await freshAdmin(p, tx);
    const result = await brokerRequest<SandboxAdminResult>('/admin/action', ResultSchema, { actorId: p.user.id, request: action });
    await tx.update(auditLog).set({ details: { status: 'completed', request: auditSummary(action), result: 'accepted' } }).where(eq(auditLog.id, auditId));
    return result;
  });
}

async function setAuditFailure(auditId: string, action: SandboxAdminActionType, error: unknown) {
  const failure = error instanceof HttpError ? error.status === 403 ? 'authorization_changed' : error.status === 404 ? 'owner_unavailable' : error.status === 409 ? 'conflict' : error.status === 400 ? 'invalid' : 'unavailable' : 'unavailable';
  await db.update(auditLog).set({ details: { status: 'failed', request: auditSummary(action), failure } }).where(eq(auditLog.id, auditId)).catch(() => {});
}

export async function readDockerSandboxes(): Promise<SandboxAdminPageData> {
  const principal = await requireAdmin();
  let snapshot: SandboxAdminSnapshot;
  try { snapshot = await brokerRequest<SandboxAdminSnapshot>('/admin/snapshot', SnapshotSchema); }
  catch (error) {
    const reason = error instanceof HttpError ? error.message : 'The SBX broker is unavailable.';
    snapshot = unavailableAdminSnapshot(reason, process.env.PERSONAL_CODEX_SOCKET ? 'sbx' : 'unconfigured');
  }
  const people = await db.select({ id: users.id, name: users.name, email: users.email, upn: users.upn, disabled: users.disabled })
    .from(users).orderBy(users.name).limit(1000);
  const fresh = await loadPrincipal(principal.user.id);
  if (!fresh?.isAdmin || fresh.user.disabled || fresh.user.sessionVersion !== principal.user.sessionVersion)
    throw new HttpError(403, 'Admin access changed. Sign in again before retrying.');
  return { ...snapshot, people: people.map(person => ({ id: person.id, name: person.name, email: person.email ?? person.upn ?? '', disabled: !!person.disabled })) };
}

export async function performDockerSandboxAction(input: unknown): Promise<{ result: SandboxAdminResult; data: SandboxAdminPageData }> {
  const p = await requireAdmin();
  const parsedAction = SandboxAdminAction.safeParse(input);
  if (!parsedAction.success) throw new HttpError(400, 'The SBX administration request is invalid.');
  const action = parsedAction.data;
  if (action.action === 'lifecycle' && action.operation === 'delete' && action.confirmation !== 'DELETE')
    throw new HttpError(400, 'Confirm sandbox deletion by typing DELETE.');
  const auditId = await requestAudit(p, action);
  let result: SandboxAdminResult;
  try { result = await dispatch(p, action, auditId); }
  catch (error) { await setAuditFailure(auditId, action, error); throw error instanceof HttpError ? error : new HttpError(503, 'The SBX administration request could not be completed.'); }
  return { result, data: await readDockerSandboxes() };
}
