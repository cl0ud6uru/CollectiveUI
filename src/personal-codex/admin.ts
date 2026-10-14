import { randomUUID, randomBytes } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { lstat, mkdir, open, realpath, rename, unlink } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { z } from 'zod';
import type { SbxPersonalCodexDriver } from './sbx';
import { ownerId } from './contracts';
import {
  AdminTemplateReference, NetworkDestination, SandboxAdminAction, unavailableAdminSnapshot,
  type AdminCheck, type AdminNetwork, type AdminRuntime,
  type AdminValidation, type SandboxAdminResult, type SandboxAdminSnapshot,
} from './admin-contracts';

const MAX_STATE_BYTES = 4 * 1024 * 1024;
const MAX_RULES_PER_OWNER = 256;
const templateRef = AdminTemplateReference;
const ruleSchema = z.object({
  id: z.string().uuid(), cliRuleId: z.string().min(1).max(256), ownerId,
  effect: z.enum(['allow', 'deny']), destination: z.string().min(1).max(253), createdAt: z.string().datetime(),
}).strict();
const templateSchema = z.object({ reference: templateRef, label: z.string().min(1).max(100) }).strict();
const validationSchema = z.object({
  id: z.enum(['sbx', 'desktop', 'containment', 'inference']), result: z.enum(['passed', 'failed', 'pending']),
  reference: z.string().max(300), checkedAt: z.string().datetime().nullable(), checkedBy: z.string().max(256).nullable(),
  template: templateRef, source: z.literal('operator'),
}).strict();
const pendingSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('network-add'), ownerId, effect: z.enum(['allow', 'deny']), destination: z.string().min(1).max(253),
    priorCliRuleIds: z.array(z.string().min(1).max(256)).max(1024), startedAt: z.string().datetime() }).strict(),
  z.object({ kind: z.literal('network-remove'), ownerId, ruleId: z.string().uuid(), cliRuleId: z.string().min(1).max(256), effect: z.enum(['allow', 'deny']), destination: z.string().min(1).max(253), startedAt: z.string().datetime() }).strict(),
  z.object({ kind: z.literal('template-import'), archive: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]*\.tar$/), reference: templateRef, startedAt: z.string().datetime() }).strict(),
]);
const stateSchema = z.object({
  version: z.literal(1), revision: z.number().int().nonnegative(),
  settings: z.object({ cpus: z.number().int().min(1).max(64), memoryMb: z.number().int().min(512).max(65536),
    maxRunning: z.number().int().min(1).max(1000), defaultTemplate: templateRef }).strict(),
  knownOwners: z.array(ownerId).max(1000), admittedOwners: z.array(ownerId).max(1000),
  templates: z.array(templateSchema).max(128), networkRules: z.array(ruleSchema).max(256_000),
  validation: z.array(validationSchema).max(4), pending: pendingSchema.nullable(),
}).strict().superRefine((value, ctx) => {
  if (new Set(value.knownOwners).size !== value.knownOwners.length || new Set(value.admittedOwners).size !== value.admittedOwners.length ||
      value.admittedOwners.some(owner => !value.knownOwners.includes(owner)) ||
      new Set(value.templates.map(template => template.reference)).size !== value.templates.length ||
      !value.templates.some(template => template.reference === value.settings.defaultTemplate) ||
      new Set(value.networkRules.map(rule => rule.id)).size !== value.networkRules.length ||
      value.networkRules.some(rule => !value.knownOwners.includes(rule.ownerId))) {
    ctx.addIssue({ code: 'custom', message: 'inconsistent admin state' });
  }
});
type AdminState = z.infer<typeof stateSchema>;
type RuntimeState = Pick<AdminRuntime, 'credentialState' | 'computer'>;
export type SandboxAdminHooks = {
  runtimeState(owner: string): Promise<RuntimeState>;
  /** Delete removes guest sandbox data; the caller retains the account and its credentials. */
  lifecycle(owner: string, operation: 'provision' | 'start' | 'stop' | 'delete'): Promise<void>;
};

export class SandboxAdminError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message);
    this.name = 'SandboxAdminError';
  }
}
const invalid = () => new SandboxAdminError(400, 'invalid_action', 'The SBX administration request is invalid.');
const conflict = () => new SandboxAdminError(409, 'revision_conflict', 'SBX administration changed. Refresh and retry.');
const unavailable = () => new SandboxAdminError(503, 'admin_unavailable', 'SBX administration is unavailable or needs operator reconciliation.');
const mutationFailed = () => new SandboxAdminError(503, 'mutation_failed', 'The SBX administration request could not be completed.');
type AdminDriver = Omit<SbxPersonalCodexDriver, 'adminNetworkRead'> & {
  adminConfigure(input: { cpus: number; memoryMb: number; defaultTemplate: string; knownOwners: string[]; admittedOwners: string[]; maxRunning: number }): Promise<void>;
  adminHealth(): Promise<{ version: string | null; checks: AdminCheck[] }>;
  adminInventory(): Promise<{ ownerId: string; state: AdminRuntime['state']; cpus: number; memoryMb: number; template: string; activeSessions: number | null }[]>;
  adminTemplates(references: string[]): Promise<{ reference: string; available: boolean | null }[]>;
  adminArchives(): Promise<{ name: string; sizeBytes: number }[]>;
  adminImportTemplate(archive: string, reference: string): Promise<void>;
  adminNetworkRead(owner: string): Promise<{ rules: { effect: 'allow' | 'deny'; destination: string; cliRuleId: string }[]; observed: boolean; note: string; events: AdminNetwork['events']; eventsObserved: boolean }>;
  adminNetworkAdd(owner: string, effect: 'allow' | 'deny', destination: string): Promise<{ cliRuleId: string }>;
  adminNetworkRemove(owner: string, effect: 'allow' | 'deny', destination: string, cliRuleId: string): Promise<void>;
  adminNetworkCheck(owner: string, destination: string): Promise<{ decision: 'allowed' | 'denied' | 'unknown'; detail: string }>;
  adminDiagnose(): Promise<AdminCheck[]>;
};

function safeChecks(checks: AdminCheck[]): AdminCheck[] {
  const safeDetails = new Set([
    'The configured CLI version could not be verified.',
    'A KVM character device is accessible to the broker process; this does not verify a live sandbox boot.',
    'The broker process cannot access a KVM character device at /dev/kvm.',
    'The runtime home and command directory are private and owned by the service account.',
    'The configured runtime home is missing or has unsafe ownership or permissions.',
    'The host setting matches the required sandbox boundary.',
    'The host setting does not match the required sandbox boundary.',
    'The host setting could not be verified.',
    'The daemon status response indicates it is running.',
    'The daemon status response indicates it is stopped.',
    'The daemon status response schema or state is not recognized.',
    'Live desktop and token-isolation proof requires an operator validation run.',
    'The diagnostic report could not be read.',
    'The diagnostic report schema is not recognized.',
    'The diagnostic report contains fields or states this adapter does not recognize.',
  ]);
  const fixedDetail = (detail: string) => {
    if (/^Verified v[\w.-]{1,64}\.$/.test(detail) || /^The report contains \d{1,3} recognized (?:passing|failing) checks\.$/.test(detail)) return detail;
    return safeDetails.has(detail) ? detail : 'Check the sandbox administrator guidance for the next step.';
  };
  return checks.slice(0, 64).map((check, index) => ({
    id: /^[a-z0-9_-]{1,64}$/i.test(check.id) ? check.id : `check-${index + 1}`,
    label: /^[\w -]{1,80}$/.test(check.label) ? check.label : 'Runtime check',
    state: check.state,
    detail: fixedDetail(check.detail),
  }));
}
function blankValidation(template: string): AdminValidation[] {
  return (['sbx', 'desktop', 'containment', 'inference'] as const).map(id => ({
    id, result: 'pending', reference: '', checkedAt: null, checkedBy: null, template, source: 'operator',
  }));
}
function configFor(state: AdminState) {
  return { ...state.settings, knownOwners: state.knownOwners, admittedOwners: state.admittedOwners };
}

/** Durable, serialized SBX administration. Snapshots never expose CLI IDs or host diagnostics. */
export class SandboxAdminController {
  private readonly adminDriver: AdminDriver;
  private state?: AdminState;
  private queue: Promise<unknown> = Promise.resolve();
  private readonly statePath: string;

  constructor(driver: SbxPersonalCodexDriver, private readonly hooks: SandboxAdminHooks) {
    this.adminDriver = driver as AdminDriver;
    this.statePath = join(driver.config.sbxHome, 'collectiveui-admin.json');
  }

  private exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.queue.then(operation, operation);
    this.queue = result.then(() => undefined, () => undefined);
    return result;
  }

  private async ensurePrivateHome() {
    const homePath = resolve(this.adminDriver.config.sbxHome);
    await mkdir(homePath, { recursive: true, mode: 0o700 });
    const home = await lstat(homePath);
    if (!home.isDirectory() || home.isSymbolicLink() || home.uid !== process.getuid?.() || home.mode & 0o077 || await realpath(homePath) !== homePath)
      throw unavailable();
  }

  private async readState(): Promise<AdminState | null> {
    await this.ensurePrivateHome();
    const info = await lstat(this.statePath).catch(error => (error as NodeJS.ErrnoException).code === 'ENOENT' ? null : Promise.reject(error));
    if (!info) return null;
    if (!info.isFile() || info.isSymbolicLink() || info.uid !== process.getuid?.() || info.mode & 0o077 || info.size > MAX_STATE_BYTES)
      throw new Error('SBX admin state needs operator reconciliation.');
    let raw: unknown;
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      handle = await open(this.statePath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
      const opened = await handle.stat();
      if (!opened.isFile() || opened.uid !== process.getuid?.() || opened.mode & 0o077 || opened.size > MAX_STATE_BYTES) throw unavailable();
      raw = JSON.parse(await handle.readFile('utf8'));
    } catch { throw unavailable(); }
    finally { await handle?.close().catch(() => {}); }
    const parsed = stateSchema.safeParse(raw);
    if (!parsed.success) throw unavailable();
    return parsed.data;
  }

  private async writeState(state: AdminState) {
    await this.ensurePrivateHome();
    const parsed = stateSchema.safeParse(state);
    if (!parsed.success) throw unavailable();
    const encoded = JSON.stringify(parsed.data);
    if (Buffer.byteLength(encoded) > MAX_STATE_BYTES) throw unavailable();
    const tempPath = `${this.statePath}.${randomBytes(12).toString('hex')}.tmp`;
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    let renamed = false;
    try {
      handle = await open(tempPath, 'wx', 0o600);
      await handle.writeFile(encoded, 'utf8');
      await handle.sync();
      await handle.close(); handle = undefined;
      await rename(tempPath, this.statePath);
      renamed = true;
      const dir = await open(dirname(this.statePath), 'r');
      await dir.sync(); await dir.close();
      this.state = parsed.data;
    } catch {
      await handle?.close().catch(() => {});
      await unlink(tempPath).catch(() => {});
      if (renamed) {
        try {
          const confirmed = await this.readState();
          if (confirmed && confirmed.revision === parsed.data.revision && JSON.stringify(confirmed) === encoded) {
            this.state = confirmed;
            return;
          }
        } catch { /* report an unreconciled write below */ }
      }
      throw new SandboxAdminError(503, 'state_write_failed', 'SBX administration state could not be saved.');
    }
  }

  private seedState(): AdminState {
    const cfg = this.adminDriver.config;
    const knownOwners = [...new Set(cfg.owners.map(owner => ownerId.parse(owner)))];
    return stateSchema.parse({
      version: 1, revision: 0,
      settings: { cpus: cfg.cpus, memoryMb: cfg.memoryMb, maxRunning: Math.max(1, knownOwners.length), defaultTemplate: cfg.template },
      knownOwners, admittedOwners: knownOwners,
      templates: [{ reference: cfg.template, label: 'Installed template' }], networkRules: [],
      validation: blankValidation(cfg.template), pending: null,
    });
  }

  async initialize(): Promise<void> {
    await this.exclusive(() => this.initializeExclusive());
  }

  private async initializeExclusive() {
    if (this.state && !this.state.pending) return;
    this.state = undefined;
    const persisted = await this.readState();
    const state = persisted
      ? stateSchema.parse({ ...persisted, knownOwners: [...new Set([...persisted.knownOwners, ...this.adminDriver.config.owners.map(owner => ownerId.parse(owner))])] })
      : this.seedState();
    try { await this.adminDriver.adminConfigure(configFor(state)); }
    catch { throw unavailable(); }
    const reconciled = persisted && state.pending ? await this.reconcilePending(state) : state;
    if (persisted && !state.pending && state.revision === persisted.revision && state.knownOwners.length === persisted.knownOwners.length) this.state = reconciled;
    else await this.writeState(persisted ? { ...reconciled, revision: Math.max(persisted.revision, reconciled.revision) + (state.pending ? 0 : 1) } : reconciled);
  }

  private async currentState() {
    if (this.state) {
      const persisted = await this.readState();
      if (!persisted) throw unavailable();
      this.state = persisted;
    }
    if (!this.state || this.state.pending) await this.initializeExclusive();
    if (!this.state) throw unavailable();
    if (this.state.pending) throw unavailable();
    return this.state;
  }

  private async reconcilePending(state: AdminState): Promise<AdminState> {
    const pending = state.pending;
    if (!pending) return state;
    let next: AdminState;
    if (pending.kind === 'network-add') {
      const observed = await this.adminDriver.adminNetworkRead(pending.ownerId);
      if (!observed.observed) throw unavailable();
      const known = new Set([...pending.priorCliRuleIds, ...state.networkRules.filter(rule => rule.ownerId === pending.ownerId).map(rule => rule.cliRuleId)]);
      const candidates = observed.rules.filter(rule => rule.effect === pending.effect && rule.destination === pending.destination && !known.has(rule.cliRuleId));
      // A matching rule after restart may have been added by an operator; before/after diff is not durable ownership.
      if (candidates.length > 0) throw unavailable();
      next = { ...state, pending: null };
    } else if (pending.kind === 'network-remove') {
      const observed = await this.adminDriver.adminNetworkRead(pending.ownerId);
      if (!observed.observed) throw unavailable();
      const remains = observed.rules.some(rule => rule.cliRuleId === pending.cliRuleId && rule.effect === pending.effect && rule.destination === pending.destination);
      next = { ...state, pending: null, networkRules: remains ? state.networkRules : state.networkRules.filter(rule => rule.id !== pending.ruleId) };
    } else {
      const availability = await this.adminDriver.adminTemplates([pending.reference]);
      if (availability.length !== 1 || availability[0].available === null) throw unavailable();
      const templates = availability[0].available && !state.templates.some(item => item.reference === pending.reference)
        ? [...state.templates, { reference: pending.reference, label: 'Imported template' }]
        : state.templates;
      next = { ...state, pending: null, templates };
    }
    return stateSchema.parse({ ...next, revision: state.revision + 1 });
  }

  private async persistMutation(before: AdminState, next: AdminState, configure = false) {
    const updated = stateSchema.parse({ ...next, revision: before.revision + 1, pending: null });
    if (configure) {
      // Configure first; if durable state persistence fails, restore the previous policy.
      try { await this.adminDriver.adminConfigure(configFor(updated)); }
      catch {
        await this.adminDriver.adminConfigure(configFor(before)).catch(() => { this.state = undefined; });
        throw mutationFailed();
      }
      try { await this.writeState(updated); }
      catch {
        await this.adminDriver.adminConfigure(configFor(before)).catch(() => {
          this.state = undefined;
        });
        throw new Error('SBX settings could not be saved; operator reconciliation may be required.');
      }
    } else await this.writeState(updated);
    return updated;
  }

  private optimistic(state: AdminState, revision: number) {
    if (state.revision !== revision) throw conflict();
  }
  private requireKnown(state: AdminState, owner: string) {
    const parsed = ownerId.safeParse(owner);
    if (!parsed.success) throw invalid();
    const normalized = parsed.data;
    if (!state.knownOwners.includes(normalized)) throw new SandboxAdminError(404, 'owner_not_found', 'Owner is not known to SBX administration.');
    return normalized;
  }
  private requireAdmitted(state: AdminState, owner: string) {
    const normalized = this.requireKnown(state, owner);
    if (!state.admittedOwners.includes(normalized)) throw new SandboxAdminError(403, 'owner_not_admitted', 'Owner is not admitted to SBX.');
    return normalized;
  }

  async snapshot(): Promise<SandboxAdminSnapshot> {
    return this.exclusive(async () => {
      const checkedAt = new Date().toISOString();
      let state: AdminState;
      try { state = await this.currentState(); }
      catch { return unavailableAdminSnapshot('SBX administration is unavailable or needs operator reconciliation.', 'sbx'); }
      try {
        const [health, inventory, templates, archives] = await Promise.all([
          this.adminDriver.adminHealth(),
          this.adminDriver.adminInventory(),
          this.adminDriver.adminTemplates(state.templates.map(template => template.reference)),
          this.adminDriver.adminArchives(),
        ]);
        const inventoryMap = new Map(inventory.map(item => [item.ownerId, item]));
        const inUse = new Map<string, number>();
        for (const item of inventory) inUse.set(item.template, (inUse.get(item.template) ?? 0) + (item.state === 'missing' ? 0 : 1));
        const availability = new Map(templates.map(item => [item.reference, item.available]));
        const runtimes = await Promise.all(state.knownOwners.map(async owner => {
          const item = inventoryMap.get(owner);
          let runtime: RuntimeState;
          try { runtime = await this.hooks.runtimeState(owner); }
          catch { runtime = { credentialState: 'operator_unverified', computer: { available: false, paused: false, control: 'unavailable', lastFrameAt: null } }; }
          return {
            ownerId: owner, admitted: state.admittedOwners.includes(owner), state: item?.state ?? 'unavailable',
            cpus: item?.cpus ?? state.settings.cpus, memoryMb: item?.memoryMb ?? state.settings.memoryMb,
            template: item?.template ?? state.settings.defaultTemplate, activeSessions: item?.activeSessions ?? null,
            ...runtime,
          } satisfies AdminRuntime;
        }));
        const result: SandboxAdminSnapshot = {
          available: true, reason: null, checkedAt, backend: 'sbx',
          version: typeof health.version === 'string' && /^[\w.-]{1,64}$/.test(health.version) ? health.version : null,
          checks: safeChecks(health.checks),
          settings: { revision: state.revision, ...state.settings, admittedOwners: [...state.admittedOwners] },
          runtimes,
          templates: state.templates.map(item => ({ ...item, available: availability.get(item.reference) ?? null, inUse: inUse.get(item.reference) ?? 0 })),
          archives: archives.filter(item => /^[A-Za-z0-9][A-Za-z0-9._-]*\.tar$/.test(item.name) && Number.isSafeInteger(item.sizeBytes) && item.sizeBytes >= 0)
            .slice(0, 128).map(item => ({ name: basename(item.name), sizeBytes: item.sizeBytes })),
          validation: state.validation,
          siwcSandboxVerified: this.adminDriver.config.siwcSandboxVerified && state.settings.defaultTemplate === this.adminDriver.config.template,
        };
        return result;
      } catch {
        return { ...unavailableAdminSnapshot('SBX administration is unavailable or needs operator reconciliation.', 'sbx'),
          checkedAt, settings: { revision: state.revision, ...state.settings, admittedOwners: [...state.admittedOwners] },
          templates: state.templates.map(item => ({ ...item, available: null, inUse: 0 })), validation: state.validation };
      }
    });
  }

  async act(actionInput: unknown, actorId: string): Promise<SandboxAdminResult> {
    const actionResult = SandboxAdminAction.safeParse(actionInput);
    const actorResult = ownerId.safeParse(actorId);
    if (!actionResult.success || !actorResult.success) throw invalid();
    const action = actionResult.data;
    const actor = actorResult.data;
    return this.exclusive(async () => {
      const state = await this.currentState();
      switch (action.action) {
        case 'settings': {
          this.optimistic(state, action.revision);
          if (!state.templates.some(item => item.reference === action.defaultTemplate)) throw new SandboxAdminError(400, 'template_not_approved', 'Default template must be in the approved catalog.');
          const availability = await this.adminDriver.adminTemplates([action.defaultTemplate]);
          if (availability.length !== 1 || availability[0].available !== true) throw new SandboxAdminError(409, 'template_unavailable', 'Default template is not available.');
          const changedTemplate = action.defaultTemplate !== state.settings.defaultTemplate;
          const next = { ...state, settings: { cpus: action.cpus, memoryMb: action.memoryMb, maxRunning: action.maxRunning, defaultTemplate: action.defaultTemplate },
            validation: changedTemplate ? blankValidation(action.defaultTemplate) : state.validation };
          await this.persistMutation(state, next, true);
          return { message: 'SBX settings saved for new runtimes.' };
        }
        case 'enrollment': {
          this.optimistic(state, action.revision);
          const parsedOwner = ownerId.safeParse(action.ownerId);
          if (!parsedOwner.success) throw invalid();
          const owner = action.admitted ? parsedOwner.data : this.requireKnown(state, parsedOwner.data);
          if (action.admitted && state.admittedOwners.includes(owner)) return { message: 'Enrollment is unchanged.' };
          if (!action.admitted && !state.admittedOwners.includes(owner)) {
            // A previous stop may have failed after durable revocation. Retrying must still stop it.
            await this.hooks.lifecycle(owner, 'stop');
            return { message: 'Owner remains removed from admission; sandbox stop completed.' };
          }
          const admittedOwners = action.admitted ? [...state.admittedOwners, owner] : state.admittedOwners.filter(item => item !== owner);
          const knownOwners = action.admitted && !state.knownOwners.includes(owner) ? [...state.knownOwners, owner] : state.knownOwners;
          await this.persistMutation(state, { ...state, knownOwners, admittedOwners }, true);
          if (!action.admitted) {
            // Admission is revoked before stopping, so no queued bridge can start during teardown.
            await this.hooks.lifecycle(owner, 'stop');
            return { message: 'Owner removed from admission and sandbox stop completed.' };
          }
          return { message: 'Owner admitted to SBX.' };
        }
        case 'lifecycle': {
          const owner = action.operation === 'provision' || action.operation === 'start'
            ? this.requireAdmitted(state, action.ownerId) : this.requireKnown(state, action.ownerId);
          if (action.operation === 'delete' && action.confirmation !== 'DELETE') throw new SandboxAdminError(400, 'confirmation_required', 'Deleting a sandbox requires DELETE confirmation.');
          await this.hooks.lifecycle(owner, action.operation);
          if (action.operation === 'delete' && state.networkRules.some(rule => rule.ownerId === owner)) {
            await this.persistMutation(state, { ...state, networkRules: state.networkRules.filter(rule => rule.ownerId !== owner) });
          }
          return { message: action.operation === 'delete'
            ? 'Sandbox deleted. Guest files were removed; the owner account and credentials remain.'
            : `Sandbox ${action.operation} request completed.` };
        }
        case 'template-add': {
          this.optimistic(state, action.revision);
          if (state.templates.some(item => item.reference === action.reference)) throw new SandboxAdminError(409, 'template_exists', 'Template is already approved.');
          const availability = await this.adminDriver.adminTemplates([action.reference]);
          if (availability.length !== 1 || availability[0].available !== true) throw new SandboxAdminError(409, 'template_unavailable', 'Template digest is not available in the fixed SBX catalog.');
          await this.persistMutation(state, { ...state, templates: [...state.templates, { reference: action.reference, label: action.label }] });
          return { message: 'Digest-pinned template added to the approved catalog.' };
        }
        case 'template-import': {
          this.optimistic(state, action.revision);
          if (state.templates.some(item => item.reference === action.reference)) throw new SandboxAdminError(409, 'template_exists', 'Template is already approved.');
          const archives = await this.adminDriver.adminArchives();
          if (!archives.some(item => item.name === action.archive)) throw new SandboxAdminError(404, 'archive_not_found', 'Archive is not in the fixed SBX import inbox.');
          const pending = { kind: 'template-import' as const, archive: action.archive, reference: action.reference, startedAt: new Date().toISOString() };
          await this.writeState({ ...state, pending });
          await this.adminDriver.adminImportTemplate(action.archive, action.reference);
          const availability = await this.adminDriver.adminTemplates([action.reference]);
          if (availability.length !== 1 || availability[0].available !== true) throw new SandboxAdminError(409, 'template_unavailable', 'Imported template digest could not be verified.');
          await this.persistMutation(state, { ...state, templates: [...state.templates, { reference: action.reference, label: 'Imported template' }] });
          return { message: 'Digest-pinned template imported from the fixed SBX inbox.' };
        }
        case 'template-remove': {
          this.optimistic(state, action.revision);
          if (action.reference === state.settings.defaultTemplate) throw new SandboxAdminError(409, 'template_in_use', 'The default template cannot be removed.');
          const [item, inventory] = await Promise.all([
            Promise.resolve(state.templates.find(template => template.reference === action.reference)),
            this.adminDriver.adminInventory(),
          ]);
          if (!item) throw new SandboxAdminError(404, 'template_not_found', 'Template is not in the approved catalog.');
          if (inventory.some(runtime => runtime.template === action.reference && runtime.state !== 'missing')) throw new SandboxAdminError(409, 'template_in_use', 'Template is in use by a retained sandbox.');
          await this.persistMutation(state, { ...state, templates: state.templates.filter(template => template.reference !== action.reference) });
          return { message: 'Template removed from the approved catalog.' };
        }
        case 'network-add': {
          const owner = this.requireAdmitted(state, action.ownerId);
          if (state.networkRules.filter(rule => rule.ownerId === owner).length >= MAX_RULES_PER_OWNER) throw new Error('Network rule limit reached.');
          const prior = await this.adminDriver.adminNetworkRead(owner);
          if (!prior.observed || prior.rules.length > 1024) throw unavailable();
          const pending = { kind: 'network-add' as const, ownerId: owner, effect: action.effect, destination: action.destination,
            priorCliRuleIds: prior.rules.map(rule => rule.cliRuleId), startedAt: new Date().toISOString() };
          await this.writeState({ ...state, pending });
          const outcome = await this.adminDriver.adminNetworkAdd(owner, action.effect, action.destination);
          const entry = { id: randomUUID(), cliRuleId: outcome.cliRuleId, ownerId: owner, effect: action.effect, destination: action.destination, createdAt: new Date().toISOString() };
          await this.persistMutation(state, { ...state, networkRules: [...state.networkRules, entry] });
          return { message: 'Network rule applied.', network: await this.networkView(owner, this.state!) };
        }
        case 'network-remove': {
          const owner = this.requireKnown(state, action.ownerId);
          const entry = state.networkRules.find(rule => rule.ownerId === owner && rule.id === action.ruleId);
          if (!entry) throw new SandboxAdminError(404, 'network_rule_not_found', 'Network rule is not app-managed.');
          const pending = { kind: 'network-remove' as const, ownerId: owner, ruleId: entry.id, cliRuleId: entry.cliRuleId,
            effect: entry.effect, destination: entry.destination, startedAt: new Date().toISOString() };
          await this.writeState({ ...state, pending });
          await this.adminDriver.adminNetworkRemove(owner, entry.effect, entry.destination, entry.cliRuleId);
          await this.persistMutation(state, { ...state, networkRules: state.networkRules.filter(rule => rule.id !== entry.id) });
          return { message: 'Network rule removed.', network: await this.networkView(owner, this.state!) };
        }
        case 'network-read': {
          const owner = this.requireKnown(state, action.ownerId);
          return { message: 'Current app-managed network policy.', network: await this.networkView(owner, state) };
        }
        case 'network-check': {
          const owner = this.requireKnown(state, action.ownerId);
          const result = await this.adminDriver.adminNetworkCheck(owner, action.destination);
          const detail = result.decision === 'allowed' ? 'Allowed by the observed SBX policy.'
            : result.decision === 'denied' ? 'Denied by the observed SBX policy.' : 'No definitive policy decision was observed.';
          return { message: 'Network policy checked.', networkCheck: { decision: result.decision, detail, destination: action.destination } };
        }
        case 'diagnose': {
          const checks = safeChecks(await this.adminDriver.adminDiagnose());
          return { message: 'Host diagnostics completed.', diagnostics: { checkedAt: new Date().toISOString(), checks, source: 'host' as const, liveComputerUseVerified: false as const } };
        }
        case 'validation': {
          this.optimistic(state, action.revision);
          const checkedAt = new Date().toISOString();
          const validation: AdminValidation = { id: action.id, result: action.result, reference: action.reference, checkedAt,
            checkedBy: actor, template: state.settings.defaultTemplate, source: 'operator' };
          const validationList = [...state.validation.filter(item => item.id !== action.id), validation];
          await this.persistMutation(state, { ...state, validation: validationList });
          return { message: 'Operator validation attestation recorded for the current template.' };
        }
      }
    }).catch(error => {
      if (error instanceof SandboxAdminError) throw error;
      throw mutationFailed();
    });
  }

  private async networkView(owner: string, state: AdminState): Promise<AdminNetwork> {
    const observed = await this.adminDriver.adminNetworkRead(owner);
    const matching = (rule: AdminState['networkRules'][number]) => observed.rules.some(current =>
      current.cliRuleId === rule.cliRuleId && current.effect === rule.effect && current.destination === rule.destination);
    const owned = state.networkRules.filter(rule => rule.ownerId === owner);
    const rules = owned.filter(matching).map(rule => ({
      id: rule.id, ownerId: owner, effect: rule.effect, destination: rule.destination, createdAt: rule.createdAt,
    }));
    const events = observed.eventsObserved ? observed.events.slice(0, 128).flatMap(event => {
      const destination = NetworkDestination.safeParse(event.destination);
      if (!destination.success || event.at !== null && !Number.isFinite(Date.parse(event.at))) return [];
      return [{ at: event.at, destination: destination.data, decision: event.decision }];
    }) : [];
    const drifted = owned.some(rule => !matching(rule));
    return { ownerId: owner, rules, observed: observed.observed,
      note: !observed.observed ? 'Policy could not be observed.'
        : drifted ? 'Some app-managed rules no longer match the observed SBX policy.'
          : observed.eventsObserved ? 'Policy and recent events were observed; displayed rules are app-managed.'
            : 'Policy was observed, but the recent event log is unavailable.',
      eventsObserved: observed.eventsObserved, events };
  }
}
