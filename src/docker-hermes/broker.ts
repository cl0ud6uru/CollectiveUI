import { mkdirSync, readFileSync, writeFileSync, renameSync, openSync, closeSync, fsyncSync, readdirSync, lstatSync } from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { LocalController, LocalError } from '../local-hermes/controller';
import { runtimeKey, BrokerConfig, RESOURCE_PROTOCOL_BYTES, type RuntimeDriver } from './docker';
import { bindingSchema, ownerId, runtimeOwnerId, phases, profileName, teamAuthorization, teamEnsure, teamScope, teamResourceSelection,
  teamCandidateConfig, teamCandidateScope, teamCandidateStart, type TeamCandidateConfig, type DockerBinding, type DockerStatus, type TeamBinding, type TeamMode, type TeamGrant, type TeamModelPolicy } from './types';
import { beginResourceUpdate, type TeamResourceUpdatePlan } from '../lib/hermes-team/updates';
import { validateTeamResourceSnapshot } from '../lib/hermes-team/resources';
import { codexAction, codexStatus, codexStates, type CodexStatus } from './oauth';
import { profileUpdate, profileTest, testCodes, providerBlocker, type ProfileSettings, type ProfileTestResult } from './settings';
import { networkMode, networkRequest, networkMigration, networkReceipt, connectivity, type NetworkStatus, type NetworkMigration, type Connectivity } from './network';
const key = () => randomUUID().replaceAll('-', '');
const teamOperation = z.object({ teamBotId: ownerId, mode: z.enum(['member', 'admin']), bindingId: z.string().nullable(),
  state: z.enum(['preparing', 'connection_needed', 'revoked', 'needs_attention']),
  interruption: z.literal('runtime-wide').optional() });
const updateReceipt = z.object({ format: z.literal(1), operationId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/), planHash: z.string().regex(/^[a-f0-9]{64}$/), status: z.enum(['applying', 'complete', 'needs-attention']), completedGroups: z.array(z.string().max(256)).max(512), blockedGroup: z.string().max(256).optional() }).strict();
const resourceOperation = z.object({ bindingId: z.string(), planHash: z.string().regex(/^[a-f0-9]{64}$/), status: z.enum(['applying', 'complete', 'needs-attention', 'aborted']), receipt: updateReceipt.optional() });
const teamRevoke = teamScope.extend({ requestId: z.string().regex(/^revoke:[a-f0-9]{64}$/).optional(), digest: z.string().regex(/^[a-f0-9]{64}$/).optional() }).strict().refine(v => !!v.requestId === !!v.digest);
const revokeReceipt = z.object({ actor: ownerId, teamBotId: ownerId, mode: z.enum(['member', 'admin']), digest: z.string().regex(/^[a-f0-9]{64}$/), result: z.object({ stopped: z.boolean(), interruption: z.enum(['none', 'runtime-wide']) }).optional() });
const candidateReceipt = teamCandidateStart.extend({actor:ownerId,digest:z.string().regex(/^[a-f0-9]{64}$/),
  state:z.enum(['starting','ready','needs_attention','stopped']),nativeBindingId:z.string().optional()}).strict();
const storedSchema = z.object({ owner: runtimeOwnerId, generation: z.number().int(), phase: z.enum(phases), error: z.string().nullable(), cleanupRequired: z.boolean().default(false),
  bindings: z.array(bindingSchema), confirmed: z.array(z.string()).default([]), pending: z.record(z.string(), z.object({ profile: profileName, name: z.string() })),
  logins: z.record(z.string(), z.object({ bindingId: z.string(), sessionId: z.string().uuid(), state: z.enum(codexStates), expiresAt: z.number() })).default({}),
  network: networkMode.optional(), onlineMode: z.enum(['internet', 'proxy']).optional(), networkRevision: z.number().int().nonnegative().default(0),
  networks: z.record(z.string(), networkMigration).default({}),
  connections: z.record(z.string(), connectivity).default({}),
  teams: z.record(z.string(), teamOperation).default({}),
  resourceOperations: z.record(z.string(), resourceOperation).default({}),
  revocations: z.record(z.string(), revokeReceipt).default({}),
  candidateReceipts:z.record(z.string(),candidateReceipt).default({}),
  tests: z.record(z.string(), z.object({ bindingId: z.string(), revision: z.string(), checkedAt: z.string(), code: z.enum(testCodes) })).default({}) });
type Stored = z.infer<typeof storedSchema>;
const sConnection = (s: Stored, id: string, revision: string) => s.connections[id]?.revision === revision ? s.connections[id] : null;
const teamOwner = (actor: string, bot: string, mode: TeamMode) => mode === 'admin' ? `team-admin:${bot}` : actor;
const teamKey = (bot: string, mode: TeamMode) => `${mode}:${bot}`;
const teamProfile = (owner: string, bot: string, mode: TeamMode) => `cui-team-${createHash('sha256').update(JSON.stringify([owner, bot, mode])).digest('hex').slice(0, 32)}`;
type Candidate = {actor:string;config:TeamCandidateConfig;binding:TeamBinding;controller:LocalController;grantId:string;
  phase:'prepared'|'starting'|'ready'|'retiring';generation:number;conversationId?:string;nativeBindingId?:string;
  start?:Promise<{started:true;modelAccessAvailable:true;nativeBindingId:string;interruption:'runtime-wide'}>;release:(()=>void)[];timer?:NodeJS.Timeout};

/** Durable control journal is outside every native container. Profiles cannot edit their app binding. */
export class DockerBroker {
  /** Candidate grants exist only in broker memory. Never persist them in readable native profiles or state JSON. */
  private candidateConfigs=new Map<string,Candidate>();
  private candidateOwners=new Map<string,Candidate>();
  private candidateRetires=new Map<string,Promise<{confirmed:true;runtimeWide:true}>>();
  private candidateCurrent(entry:Candidate) {
    const {config,binding}=entry, s=this.state(binding.ownerId);
    if (!this.config.teamCandidateRuntimeEnabled || !['starting','ready'].includes(entry.phase)
      || this.candidateOwners.get(binding.ownerId)!==entry || s?.generation!==entry.generation || s.phase!=='ready'
      || s.cleanupRequired || config.expiresAt<=Date.now()) throw new LocalError(409,'The native Team context ended or was interrupted.');
    const current=this.teamBinding(entry.actor,config.teamBotId,config.mode,entry.grantId);
    if(current.bindingId!==binding.bindingId || current.identity!==binding.identity || current.profile!==binding.profile)
      throw new LocalError(409,'The retained native Team binding changed.');
  }
  prepareTeamCandidate(actor:string,raw:unknown,grantId:string){
    const config=teamCandidateConfig.parse(raw);
    const binding=this.teamBinding(actor,config.teamBotId,config.mode,grantId);
    if(binding.bindingId!==config.bindingId || config.expiresAt<=Date.now() || config.expiresAt>Date.now()+120_000)throw new LocalError(409,'Invalid native Team candidate context.');
    const prior=this.candidateConfigs.get(binding.bindingId);
    if(prior && prior.config.expiresAt>Date.now()) {
      if(prior.actor!==actor || JSON.stringify(prior.config)!==JSON.stringify(config))throw new LocalError(409,'Another native Team context holds this profile.');
      prior.grantId=grantId;return {prepared:true,modelAccessAvailable:false};
    }
    if(prior && prior.phase!=='prepared')throw new LocalError(409,'Retire the prior native Team context before preparing another.');
    if (!this.driver.candidateTransport) throw new LocalError(409, 'The native candidate bootstrap is unavailable.');
    const transport=this.driver.candidateTransport(binding.ownerId,binding.profile,binding.identity,config);
    const dir=path.join(this.config.stateDir,runtimeKey(binding.ownerId),binding.bindingId,'candidate');
    mkdirSync(dir,{recursive:true,mode:0o700});
    const entry={} as Candidate;
    const controller=new LocalController({trust:'single-user-exclusive-profile',source:'/opt/hermes',python:'/opt/hermes/.venv/bin/python',
      profileHome:`/opt/data/profiles/${binding.profile}`,workDir:`/opt/data/profiles/${binding.profile}/workspace`,accountHome:'/opt/data/home',
      stateDir:dir,socketPath:this.config.socketPath,label:'Team Docker Hermes candidate'}, {
        validate:async()=>{this.candidateCurrent(entry);if(!await this.driver.running(binding.ownerId))throw new LocalError(409,'The native Team runtime stopped.');this.candidateCurrent(entry);},
        authorize:()=>this.candidateCurrent(entry),
        admission:{sessionId:()=>`portal-${entry.conversationId}-${config.teamBotId}`,receipt:()=>`portal-${config.runId}`},
        transport:()=>({spawn:()=>{this.candidateCurrent(entry);return transport.spawn();},stop:()=>{entry.phase='retiring';return transport.stop();}}),
      });
    Object.assign(entry,{actor,config,binding,controller,grantId,phase:'prepared',generation:this.state(binding.ownerId)!.generation,release:[]});
    this.candidateConfigs.set(binding.bindingId,entry);
    return {prepared:true,modelAccessAvailable:false};
  }
  /** Protected application IPC only: the caller has verified the durable run/route/actor immediately before dispatch. */
  startTeamCandidate(actor:string,raw:unknown,grantId:string) {
    if(!this.config.teamCandidateRuntimeEnabled)throw new LocalError(409,'Active native Team adapters are disabled.');
    const scope=teamCandidateStart.parse(raw), binding=this.teamBinding(actor,scope.teamBotId,scope.mode,grantId);
    ownerId.parse(`portal-${scope.conversationId}-${scope.teamBotId}`);ownerId.parse(`portal-${scope.runId}`);
    const entry=this.candidateConfigs.get(binding.bindingId);
    if(!entry || entry.actor!==actor || entry.config.runId!==scope.runId || entry.config.contextId!==scope.contextId || scope.bindingId!==binding.bindingId)
      throw new LocalError(403,'This prepared native context belongs to another run or actor.');
    entry.grantId=grantId;
    if(entry.start) {
      if(entry.conversationId!==scope.conversationId)throw new LocalError(409,'This native context belongs to another conversation.');
      this.candidateCurrent(entry);return entry.start;
    }
    const s=this.state(binding.ownerId)!;
    if(s.candidateReceipts[scope.contextId])throw new LocalError(409,'This native context has a retained start receipt. Retire uncertain work; do not replay startup.');
    if(Object.values(s.candidateReceipts).some(r=>r.state!=='stopped'))throw new LocalError(409,'Retire the retained native context before starting another.');
    if(Object.keys(s.candidateReceipts).length>=10000)throw new LocalError(409,'Native Team receipt capacity reached.');
    if(this.candidateOwners.has(binding.ownerId))throw new LocalError(409,'Another native context holds this runtime.');
    entry.phase='starting';entry.conversationId=scope.conversationId;entry.generation=s.generation;
    this.candidateOwners.set(binding.ownerId,entry);
    // Hashes bind the exact reviewed bootstrap without persisting plaintext opaque grants.
    s.candidateReceipts[scope.contextId]={...scope,actor,digest:createHash('sha256').update(JSON.stringify(entry.config)).digest('hex'),state:'starting'};this.save(s);
    entry.start=this.exclusive(binding.ownerId,async()=>{
      let runtimeTouched=false;
      try {
        this.candidateCurrent(entry);
        if(this.jobs.has(binding.ownerId)||this.maintaining.has(binding.ownerId)||this.pendingLogin(binding.ownerId)||this.unsettledNetwork(s))throw new LocalError(409,'Runtime preparation or maintenance must settle before native startup.');
        for(const sibling of s.bindings){const controller=this.controllers.get(sibling.bindingId);if(controller)entry.release.push(controller.holdForSettings());}
        // Current cancellation is runtime-wide. Restart only after every known sibling proves idle.
        runtimeTouched=true;await this.driver.stop(binding.ownerId);this.candidateCurrent(entry);
        for(const sibling of s.bindings){await this.controllers.get(sibling.bindingId)?.stop();this.controllers.delete(sibling.bindingId);}
        if(!this.driver.reopen)throw new LocalError(503,'Retained native runtime restart is unavailable.');
        await this.driver.reopen(binding.ownerId);this.candidateCurrent(entry);
        this.controllers.set(binding.bindingId,entry.controller);
        await entry.controller.start();this.candidateCurrent(entry);
        const pair=entry.controller.pair({runtimeId:entry.controller.runtimeId,ownerId:runtimeKey(binding.ownerId),name:binding.name,exclusive:true});
        entry.nativeBindingId=pair.bindingId;entry.phase='ready';
        s.candidateReceipts[scope.contextId].state='ready';s.candidateReceipts[scope.contextId].nativeBindingId=pair.bindingId;this.save(s);
        entry.timer=setTimeout(()=>{entry.phase='retiring';void this.stop(binding.ownerId).catch(()=>{});},Math.max(1,entry.config.expiresAt-Date.now()));
        return {started:true as const,modelAccessAvailable:true as const,nativeBindingId:pair.bindingId,interruption:'runtime-wide' as const};
      }catch(error){
        if(!runtimeTouched){entry.phase='retiring';entry.release.forEach(fn=>fn());this.candidateOwners.delete(binding.ownerId);this.candidateConfigs.delete(binding.bindingId);s.candidateReceipts[scope.contextId].state='stopped';this.save(s);throw error;}
        entry.phase='retiring';s.candidateReceipts[scope.contextId].state='needs_attention';this.save(s);
        // Cleanup occurs inside this owner queue; calling broker.stop here would deadlock its queue.
        try{await this.driver.stop(binding.ownerId);await entry.controller.stop();s.cleanupRequired=false;s.phase='stopped';}
        catch{s.cleanupRequired=true;s.phase='error';}
        this.controllers.delete(binding.bindingId);entry.release.forEach(fn=>fn());this.candidateOwners.delete(binding.ownerId);
        this.save(s);throw error;
      }
    });
    return entry.start;
  }
  /** Renew actor authority only; this never extends the immutable native context lifetime. */
  renewTeamCandidate(actor:string,raw:unknown,grantId:string) {
    const scope=teamCandidateScope.parse(raw),binding=this.teamBinding(actor,scope.teamBotId,scope.mode,grantId);
    const entry=this.candidateConfigs.get(binding.bindingId);
    if(!entry || entry.phase!=='ready' || entry.actor!==actor || scope.bindingId!==binding.bindingId
      || scope.runId!==entry.config.runId || scope.contextId!==entry.config.contextId)
      throw new LocalError(403,'This native renewal belongs to another context.');
    entry.grantId=grantId;this.candidateCurrent(entry);
    return {renewed:true,expiresAt:entry.config.expiresAt};
  }
  /** Terminal/revoked runs may only retire their exact retained receipt. Completed replay never stops a newer context. */
  async retireTeamCandidate(actor:string,raw:unknown) {
    ownerId.parse(actor);const scope=teamCandidateScope.parse(raw),owner=teamOwner(actor,scope.teamBotId,scope.mode),s=this.state(owner);
    const receipt=s?.candidateReceipts[scope.contextId];
    if(!receipt || receipt.actor!==actor || receipt.bindingId!==scope.bindingId || receipt.runId!==scope.runId || receipt.teamBotId!==scope.teamBotId || receipt.mode!==scope.mode)
      throw new LocalError(403,'This native retirement receipt belongs to another context.');
    if(receipt.state==='stopped')return {confirmed:true,runtimeWide:true};
    const active=this.candidateOwners.get(owner);
    if(active && active.config.contextId!==scope.contextId)throw new LocalError(409,'Another native context owns this runtime.');
    const jobKey=JSON.stringify([owner,scope.contextId]),prior=this.candidateRetires.get(jobKey);
    if(prior)return prior;
    const job=this.stop(owner).then(()=>{receipt.state='stopped';this.save(s!);return {confirmed:true as const,runtimeWide:true as const};});
    this.candidateRetires.set(jobKey,job);
    try{return await job;}finally{this.candidateRetires.delete(jobKey);}
  }
  private states = new Map<string, Stored>();
  private jobs = new Map<string, Promise<void>>();
  private creationJobs = new Set<string>();
  private controllers = new Map<string, LocalController>();
  private queues = new Map<string, Promise<unknown>>();
  private failed = false;
  private leases = new Map<string, { until: number; canCreate: boolean }>();
  private teamGrants = new Map<string, { actor: string; teamBotId: string; mode: TeamMode; modelPolicy: TeamModelPolicy; until: number }>();
  private maintaining = new Set<string>();
  private revokeJobs = new Map<string, Promise<{ stopped: boolean; interruption: 'none' | 'runtime-wide' }>>();
  private resourceMaintaining = new Set<string>();
  authorize(owner: string, canCreate: boolean) {
    ownerId.parse(owner); this.leases.set(owner, { until: Date.now() + 60000, canCreate });
    const s = this.states.get(owner);
    if (!canCreate && s && this.creationJobs.has(owner) && !this.maintaining.has(owner)) void this.stop(owner).catch(() => {});
  }
  owners() { return [...this.states.keys()]; }
  async expireLeases() {
    for(const [owner,entry] of this.candidateOwners) {
      try{this.candidateCurrent(entry);}catch{entry.phase='retiring';await this.stop(owner).catch(()=>{});}
    }
    // One expired Team grant cannot be kept alive by an unrelated personal-runtime lease.
    // Stop is currently container-wide; invalidation fences every sibling before cleanup.
    const expired = new Map<string, { actor: string; teamBotId: string; mode: TeamMode }>();
    for (const [id, grant] of this.teamGrants) if (grant.until <= Date.now()) {
      this.teamGrants.delete(id); expired.set(JSON.stringify([grant.actor, grant.teamBotId, grant.mode]), grant);
    }
    for (const scope of expired.values()) if (![...this.teamGrants.values()].some(g => teamOwner(g.actor, g.teamBotId, g.mode) === teamOwner(scope.actor, scope.teamBotId, scope.mode) && g.teamBotId === scope.teamBotId && g.mode === scope.mode && g.until > Date.now()))
      await this.revokeTeam(scope.actor, { teamBotId: scope.teamBotId, mode: scope.mode }).catch(() => {});
    for (const [owner, s] of this.states) if (s.phase !== 'stopping' && (!['disabled', 'stopped'].includes(s.phase) || this.maintaining.has(owner)) && ((this.leases.get(owner)?.until ?? 0) <= Date.now() || s.cleanupRequired))
      await this.stop(owner).catch(() => {});
    for (const [owner, s] of this.states) {
      const pending = this.pendingLogin(owner);
      if (pending && pending.expiresAt <= Date.now() && s.phase === 'ready') {
        await this.codexMutation(owner, pending.bindingId, { action: 'cancel', sessionId: pending.sessionId }).catch(() => {});
        if (pending.state === 'cancelled') { pending.state = 'expired'; this.save(s); }
      }
    }
  }
  private authorized(owner: string, create = false) {
    if ((this.leases.get(owner)?.until ?? 0) <= Date.now()) throw new LocalError(403, 'Runtime authorization expired. The application worker must renew it.');
    if (create && !this.leases.get(owner)?.canCreate) throw new LocalError(403, 'Bot-creation authorization is required.');
  }
  private teamEnabled() {
    if (!this.config.teamBotsEnabled) throw new LocalError(404, 'Team Bots are disabled.');
  }
  /** Only the protected application IPC caller may issue grants after checking current audience/maintainers. */
  authorizeTeam(actor: string, raw: unknown): TeamGrant {
    this.teamEnabled(); ownerId.parse(actor);
    const input = teamAuthorization.parse(raw), owner = teamOwner(actor, input.teamBotId, input.mode);
    const until = Date.now() + 60000, grantId = randomUUID();
    for (const [id, grant] of this.teamGrants) if (teamOwner(grant.actor, grant.teamBotId, grant.mode) === owner && grant.teamBotId === input.teamBotId && grant.mode === input.mode && grant.modelPolicy !== input.modelPolicy)
      this.teamGrants.delete(id);
    this.teamGrants.set(grantId, { actor, ...input, until });
    const prior = this.leases.get(owner);
    // Team membership permits provisioning its own profile, without granting personal-bot creation.
    this.leases.set(owner, { until, canCreate: !!prior && prior.until > Date.now() && prior.canCreate });
    return { grantId, expiresAt: until };
  }
  private authorizedTeam(actor: string, bot: string, mode: TeamMode, grantId: string) {
    this.teamEnabled(); ownerId.parse(actor); teamScope.parse({ teamBotId: bot, mode });
    const grant = this.teamGrants.get(grantId);
    if (!grant || grant.actor !== actor || grant.teamBotId !== bot || grant.mode !== mode || grant.until <= Date.now())
      throw new LocalError(403, 'Current Team Bot authorization is required. Reopen the bot.');
    return grant;
  }
  teamBinding(actor: string, bot: string, mode: TeamMode, grantId: string): TeamBinding {
    const grant = this.authorizedTeam(actor, bot, mode, grantId);
    const owner = teamOwner(actor, bot, mode), s = this.state(owner);
    const operation = s?.teams[teamKey(bot, mode)];
    const binding = s?.bindings.find(b => b.bindingId === operation?.bindingId && s.confirmed.includes(b.bindingId));
    if (!binding || binding.teamBotId !== bot || binding.purpose !== `team-${mode}` || operation?.state === 'revoked')
      throw new LocalError(409, 'Your Team Bot profile needs preparation.');
    if (binding.modelPolicy !== grant.modelPolicy) throw new LocalError(409, 'Team Bot model policy changed. Prepare this profile again.');
    return binding as TeamBinding;
  }
  async ensureTeam(actor: string, raw: unknown, grantId: string): Promise<TeamBinding> {
    const input = teamEnsure.parse(raw);
    const grant = this.authorizedTeam(actor, input.teamBotId, input.mode, grantId);
    if (!this.driver.createTeam) throw new LocalError(503, 'This runtime cannot safely create blank Team Bot profiles.');
    const owner = teamOwner(actor, input.teamBotId, input.mode);
    if (Object.values(this.state(owner)?.revocations ?? {}).some(receipt => !receipt.result)) throw new LocalError(409, 'A retained Team access revocation must settle before new preparation.');
    this.enableRuntime(owner, false);
    await this.jobs.get(owner);
    return this.exclusive(owner, async () => {
      this.authorizedTeam(actor, input.teamBotId, input.mode, grantId);
      if (this.pendingLogin(owner)) throw new LocalError(409, 'Finish or cancel subscription sign-in first.');
      const s = await this.ready(owner), generation = s.generation, profile = teamProfile(owner, input.teamBotId, input.mode);
      const current = () => {
        this.authorizedTeam(actor, input.teamBotId, input.mode, grantId);
        if (s.generation !== generation || s.phase !== 'ready') throw new LocalError(409, 'Team Bot preparation was interrupted. Retry after cleanup.');
      };
      const operationKey = teamKey(input.teamBotId, input.mode);
      const operation: Stored['teams'][string] = s.teams[operationKey] ?? { teamBotId: input.teamBotId, mode: input.mode, bindingId: null, state: 'preparing' };
      operation.state = 'preparing'; delete operation.interruption; s.teams[operationKey] = operation; this.save(s);
      try {
        let binding = s.bindings.find(b => b.profile === profile);
        if (binding && (binding.teamBotId !== input.teamBotId || binding.purpose !== `team-${input.mode}`))
          throw new LocalError(409, 'Reserved Team Bot profile ownership changed. Operator reconciliation is required.');
        if (!binding) {
          if (s.bindings.length >= this.config.maxProfiles) throw new LocalError(409, 'Profile capacity reached.');
          const native = await this.driver.createTeam!(owner, profile); current();
          if (native.name !== profile || !native.identity || native.identity.length > 100)
            throw new LocalError(409, 'Native Team Bot profile identity could not be confirmed.');
          binding = { bindingId: key(), botId: input.teamBotId, appId: key(), ownerId: owner, runtimeId: runtimeKey(owner),
            profile, identity: native.identity, name: input.name, purpose: `team-${input.mode}`, teamBotId: input.teamBotId, modelPolicy: grant.modelPolicy };
          s.bindings.push(binding); operation.bindingId = binding.bindingId; this.save(s);
        }
        const native = (await this.driver.profiles(owner)).find(p => p.name === profile); current();
        if (!native || native.identity !== binding.identity) throw new LocalError(409, 'Retained Team Bot profile identity changed.');
        binding.name = input.name; binding.modelPolicy = grant.modelPolicy;
        operation.bindingId = binding.bindingId; operation.state = 'connection_needed';
        if (!s.confirmed.includes(binding.bindingId)) s.confirmed.push(binding.bindingId);
        this.save(s);
        // No gateway starts here. Every policy is blocked until its whole native routing surface is verified.
        return binding as TeamBinding;
      } catch (error) {
        if (s.generation === generation) { operation.state = 'needs_attention'; this.save(s); }
        throw error;
      }
    });
  }
  async forTeamRequest(actor: string, bot: string, mode: TeamMode, id: string, grantId: string, scope?:{runId:string;contextId:string}): Promise<Awaited<ReturnType<DockerBroker['forRequest']>>> {
    const binding = this.teamBinding(actor, bot, mode, grantId);
    if (binding.bindingId !== id) throw new LocalError(403, 'This Team Bot profile belongs to another context.');
    const entry=this.candidateConfigs.get(id);
    if(!this.config.teamCandidateRuntimeEnabled || !scope || !entry || entry.actor!==actor || entry.config.runId!==scope.runId || entry.config.contextId!==scope.contextId || entry.phase!=='ready' || !entry.nativeBindingId)
      throw new LocalError(409, 'Model connection needed. Team Bot model routes are not verified for replies, learning and subagents.');
    entry.grantId=grantId;this.candidateCurrent(entry);
    if(!await this.driver.running(binding.ownerId))throw new LocalError(409,'The native Team runtime stopped.');
    this.candidateCurrent(entry);return {controller:entry.controller,nativeBindingId:entry.nativeBindingId};
  }
  /** All sibling controllers must be idle before a runtime-wide stop. No native writes
   * may overlap the volume helper. Interrupted updates can recover while already stopped. */
  private async teamMaintenance<T>(actor: string, bot: string, mode: TeamMode, grantId: string,
    run: (binding: TeamBinding, state: Stored, current: () => void) => Promise<T>, complete: (result: T) => boolean = () => true) {
    const binding = this.teamBinding(actor, bot, mode, grantId), owner = binding.ownerId;
    if (!this.driver.reopen) throw new LocalError(503, 'Stopped-volume Team resource maintenance is unavailable.');
    return this.exclusive(owner, async () => {
      this.teamBinding(actor, bot, mode, grantId); this.authorized(owner);
      const s = this.state(owner)!;
      if (this.jobs.has(owner) || this.maintaining.has(owner) || this.unsettledNetwork(s) || this.pendingLogin(owner)
        || s.cleanupRequired || !['ready', 'stopped'].includes(s.phase)) throw new LocalError(409, 'Reconcile runtime preparation or cleanup before resource maintenance.');
      const wasReady = s.phase === 'ready', release: (() => void)[] = [];
      try {
        for (const profile of s.bindings) {
          const controller = this.controllers.get(profile.bindingId);
          if (controller) release.push(controller.holdForSettings());
        }
      } catch (error) { release.forEach(fn => fn()); throw error; }
      this.maintaining.add(owner); this.resourceMaintaining.add(owner); const generation = ++s.generation;
      const current = () => {
        this.authorizedTeam(actor, bot, mode, grantId);
        if (s.generation !== generation) throw new LocalError(409, 'Resource maintenance was interrupted. Retry the same operation after cleanup.');
      };
      try {
        this.save(s); await this.driver.stop(owner); current();
        for (const profile of s.bindings) { await this.controllers.get(profile.bindingId)?.stop(); this.controllers.delete(profile.bindingId); }
        s.phase = 'stopped'; this.save(s); current();
        const result = await run(binding, s, current); current();
        if (!complete(result)) {
          s.error = 'Team update needs attention. Native work stays stopped until the protected update journal is reconciled.';
          this.save(s); return result;
        }
        if (wasReady) {
          await this.driver.reopen!(owner); current();
          const native = (await this.driver.profiles(owner)).find(p => p.name === binding.profile); current();
          if (!native || native.identity !== binding.identity) throw new LocalError(409, 'Team Bot profile changed during resource maintenance.');
          s.phase = 'ready';
        }
        s.error = null; this.save(s); return result;
      } catch (error) {
        try { await this.driver.stop(owner); s.cleanupRequired = false; } catch { s.cleanupRequired = true; }
        s.phase = s.cleanupRequired ? 'error' : 'stopped';
        s.error = 'Resource maintenance did not settle. Native profiles are retained; retry the same update or reconcile cleanup.';
        this.save(s); throw error;
      } finally { release.forEach(fn => fn()); this.maintaining.delete(owner); this.resourceMaintaining.delete(owner); }
    });
  }
  async captureTeamResources(actor: string, raw: unknown, grantId: string) {
    const input = z.object({ teamBotId: ownerId, mode: z.literal('admin'), selection: teamResourceSelection }).strict().parse(raw);
    this.teamBinding(actor, input.teamBotId, input.mode, grantId);
    if (!this.driver.capturePublishableResources) throw new LocalError(503, 'Stable Team Bot resource capture is unavailable in this runtime.');
    return this.teamMaintenance(actor, input.teamBotId, input.mode, grantId, async binding =>
      validateTeamResourceSnapshot(await this.driver.capturePublishableResources!(binding.ownerId, binding.profile, binding.identity, input.selection)));
  }
  async inventoryTeamResources(actor: string, raw: unknown, grantId: string) {
    const input = z.object({ teamBotId: ownerId, mode: z.literal('admin') }).strict().parse(raw);
    this.teamBinding(actor, input.teamBotId, input.mode, grantId);
    if (!this.driver.inventoryPublishableResources) throw new LocalError(503, 'Publishable resource discovery is unavailable in this runtime.');
    return this.teamMaintenance(actor, input.teamBotId, input.mode, grantId, async binding =>
      teamResourceSelection.parse(await this.driver.inventoryPublishableResources!(binding.ownerId, binding.profile, binding.identity)));
  }
  async inventoryTeamMemberResources(actor: string, raw: unknown, grantId: string) {
    const input = z.object({ teamBotId: ownerId, mode: z.literal('member'), trackedPackageIds: z.array(z.string().max(256)).max(1024) }).strict().parse(raw);
    this.teamBinding(actor, input.teamBotId, input.mode, grantId);
    if (!this.driver.inventoryMemberResources) throw new LocalError(503, 'Member resource inventory is unavailable in this runtime.');
    return this.teamMaintenance(actor, input.teamBotId, input.mode, grantId, async binding =>
      validateTeamResourceSnapshot(await this.driver.inventoryMemberResources!(binding.ownerId, binding.profile, binding.identity, input.trackedPackageIds), { requireCompleteSkills: false }));
  }
  async applyTeamMemberResources(actor: string, raw: unknown, grantId: string) {
    if (Buffer.byteLength(JSON.stringify(raw)) > RESOURCE_PROTOCOL_BYTES) throw new LocalError(413, 'The update exceeds the bounded resource protocol.');
    const input = z.object({ teamBotId: ownerId, mode: z.literal('member'), operationId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/), plan: z.object({ actions: z.array(z.unknown()).max(1536) }).passthrough(), receipt: updateReceipt.optional() }).strict().parse(raw);
    const plan = input.plan as unknown as TeamResourceUpdatePlan;
    try { beginResourceUpdate(input.operationId, plan, input.receipt); } catch { throw new LocalError(400, 'The update plan or receipt is invalid.'); }
    this.teamBinding(actor, input.teamBotId, input.mode, grantId);
    if (!this.driver.applyTeamResourceUpdate) throw new LocalError(503, 'Native Team resource updates are unavailable in this runtime.');
    return this.teamMaintenance(actor, input.teamBotId, input.mode, grantId, async (binding, s, current) => {
      const prior = s.resourceOperations[input.operationId];
      if (prior?.status === 'aborted') throw new LocalError(409, 'This untouched update was cancelled. Use a new operation ID.');
      if (prior && (prior.bindingId !== binding.bindingId || prior.planHash !== plan.planHash)) throw new LocalError(409, 'This operation ID already identifies another immutable update.');
      const operation = prior ?? { bindingId: binding.bindingId, planHash: plan.planHash, status: 'applying' as const };
      s.resourceOperations[input.operationId] = operation; this.save(s); current();
      const result = updateReceipt.parse(await this.driver.applyTeamResourceUpdate!(binding.ownerId, binding.profile, binding.identity, input.operationId, plan, input.receipt));
      try { beginResourceUpdate(input.operationId, plan, result); } catch { throw new LocalError(503, 'Native update completion could not be verified.'); }
      current(); operation.status = result.status; operation.receipt = result; this.save(s); return result;
    }, result => result.status === 'complete');
  }
  async abortTeamMemberResources(actor: string, raw: unknown, grantId: string) {
    if (Buffer.byteLength(JSON.stringify(raw)) > RESOURCE_PROTOCOL_BYTES) throw new LocalError(413, 'The update exceeds the bounded resource protocol.');
    const input = z.object({ teamBotId: ownerId, mode: z.literal('member'), operationId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/), plan: z.object({ actions: z.array(z.unknown()).max(1536) }).passthrough() }).strict().parse(raw);
    const plan = input.plan as unknown as TeamResourceUpdatePlan;
    try { beginResourceUpdate(input.operationId, plan); } catch { throw new LocalError(400, 'The update plan is invalid.'); }
    this.teamBinding(actor, input.teamBotId, input.mode, grantId);
    if (!this.driver.abortTeamResourceUpdate) throw new LocalError(503, 'Untouched update cancellation is unavailable.');
    return this.teamMaintenance(actor, input.teamBotId, input.mode, grantId, async (binding, s, current) => {
      const operation = s.resourceOperations[input.operationId];
      if (operation && (operation.bindingId !== binding.bindingId || operation.planHash !== plan.planHash || operation.status === 'complete')) throw new LocalError(409, 'This update must be recovered rather than cancelled.');
      const result = await this.driver.abortTeamResourceUpdate!(binding.ownerId, binding.profile, binding.identity, input.operationId, plan); current();
      if (result.aborted !== true) throw new LocalError(503, 'Native update cancellation was not confirmed.');
      s.resourceOperations[input.operationId] = { bindingId: binding.bindingId, planHash: plan.planHash, status: 'aborted' }; this.save(s); return result;
    });
  }
  async revokeTeam(actor: string, raw: unknown) {
    this.teamEnabled(); ownerId.parse(actor);
    const input = teamRevoke.parse(raw), owner = teamOwner(actor, input.teamBotId, input.mode);
    if (!input.requestId) return this.revokeTeamScope(actor, input);
    // Admin mode derives a different owner for each bot. Request identity must
    // remain immutable even if a replay tries to change that derived owner.
    for (const retained of this.states.values()) {
      const receipt = retained.revocations[input.requestId];
      if (receipt && (retained.owner !== owner || receipt.actor !== actor || receipt.teamBotId !== input.teamBotId || receipt.mode !== input.mode || receipt.digest !== input.digest))
        throw new LocalError(409, 'Revocation receipt identifies another immutable request.');
    }
    const s = this.state(owner, true)!, prior = s.revocations[input.requestId];
    if (prior && (prior.actor !== actor || prior.teamBotId !== input.teamBotId || prior.mode !== input.mode || prior.digest !== input.digest)) throw new LocalError(409, 'Revocation receipt identifies another immutable request.');
    if (prior?.result) return prior.result;
    const jobKey = `${owner}:${input.requestId}`, pending = this.revokeJobs.get(jobKey); if (pending) return pending;
    if (!prior) {
      s.revocations[input.requestId] = { actor, teamBotId: input.teamBotId, mode: input.mode, digest: input.digest! }; this.save(s);
    }
    const job = this.revokeTeamScope(actor, input).then(result => {
      s.revocations[input.requestId!].result = result; this.save(s); return result;
    });
    this.revokeJobs.set(jobKey, job);
    try { return await job; } finally { this.revokeJobs.delete(jobKey); }
  }
  private async revokeTeamScope(actor: string, scope: { teamBotId: string; mode: TeamMode }) {
    const affected=this.candidateOwners.get(teamOwner(actor,scope.teamBotId,scope.mode));
    if(affected?.actor===actor)affected.phase='retiring';
    for(const [id,value] of this.candidateConfigs)if(value.actor===actor && value.config.teamBotId===scope.teamBotId && value.config.mode===scope.mode)this.candidateConfigs.delete(id);
    const owner = teamOwner(actor, scope.teamBotId, scope.mode);
    const hadGrant = [...this.teamGrants.values()].some(grant => grant.actor === actor && grant.teamBotId === scope.teamBotId && grant.mode === scope.mode);
    for (const [id, grant] of this.teamGrants) if (grant.actor === actor && grant.teamBotId === scope.teamBotId && grant.mode === scope.mode) this.teamGrants.delete(id);
    const s = this.state(owner);
    if (!s) return { stopped: true, interruption: 'none' as const };
    const operation = s.teams[teamKey(scope.teamBotId, scope.mode)];
    if (!operation && !hadGrant) return { stopped: true, interruption: 'none' as const };
    const retainedGrant = [...this.teamGrants.values()].some(grant => teamOwner(grant.actor, grant.teamBotId, grant.mode) === owner && grant.teamBotId === scope.teamBotId && grant.mode === scope.mode && grant.until > Date.now());
    if (retainedGrant) {
      if(affected && affected.actor!==actor)return {stopped:false,interruption:'none' as const};
      const controller = operation?.bindingId ? this.controllers.get(operation.bindingId) : undefined;
      let idle = !controller;
      if (controller) try { const release = controller.holdForSettings(); release(); idle = true; } catch {}
      // Maintainers share one working profile. An idle revoked/expired tab cannot revoke
      // another maintainer's fresh grant. Native admission stays disabled until active work
      // has actor/grant attribution, so future cancellation can identify the affected turn.
      if (idle && affected?.actor!==actor) return { stopped: false, interruption: 'none' as const };
    }
    if (operation) { operation.state = 'revoked'; operation.interruption = 'runtime-wide'; this.save(s); }
    // Pinned Docker transport cannot prove profile-scoped cancellation. Fence sibling grants
    // and stop the entire owned runtime; keep every profile and historical receipt on disk.
    this.leases.delete(owner);
    s.error = 'Team Bot access changed. The runtime must stop, interrupting any sibling profiles.';
    this.save(s); await this.stop(owner);
    s.error = 'Team Bot access changed. The runtime stopped and interrupted sibling profiles; reopen authorized work explicitly.'; this.save(s);
    return { stopped: true, interruption: 'runtime-wide' as const };
  }
  constructor(readonly config: BrokerConfig, readonly driver: RuntimeDriver) {
    // Changing a namespace would otherwise strand a live old container and select new storage.
    // Configuration migration is an explicit stopped-runtime operator task, never automatic adoption.
    const deployment = path.join(config.stateDir, 'deployment.json');
    try {
      const fd = openSync(deployment, 'wx', 0o600);
      try { writeFileSync(fd, JSON.stringify(config)); fsyncSync(fd); } finally { closeSync(fd); }
      const directory = openSync(config.stateDir, 'r'); try { fsyncSync(directory); } finally { closeSync(directory); }
    } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e; }
    const pinned = JSON.parse(readFileSync(deployment, 'utf8'));
    pinned.network ??= 'none'; // legacy deployments predate Standard Internet
    if (lstatSync(deployment).isSymbolicLink() || JSON.stringify(BrokerConfig.parse(pinned)) !== JSON.stringify(config))
      throw new Error('Broker configuration changed. Stop retained runtimes with their original configuration before an operator-planned migration.');
    for (const name of readdirSync(config.stateDir)) {
      if (!/^[a-f0-9]{64}$/.test(name)) continue;
      const dir = path.join(config.stateDir, name);
      if (!lstatSync(dir).isDirectory() || lstatSync(dir).isSymbolicLink()) throw new Error('Unsafe broker state');
      const state = storedSchema.parse(JSON.parse(readFileSync(path.join(dir, 'runtime.json'), 'utf8')));
      if (runtimeKey(state.owner) !== name) throw new Error('Runtime owner mismatch');
      for (const binding of state.bindings) {
        if (binding.ownerId !== state.owner || binding.runtimeId !== name)
          throw new Error('Retained profile binding owner mismatch');
        if (binding.purpose && binding.profile !== teamProfile(state.owner, binding.teamBotId!, binding.purpose === 'team-admin' ? 'admin' : 'member'))
          throw new Error('Retained Team Bot profile binding mismatch');
      }
      for (const [id, operation] of Object.entries(state.teams)) {
        if (id !== teamKey(operation.teamBotId, operation.mode)) throw new Error('Retained Team Bot operation scope mismatch');
        const binding = operation.bindingId ? state.bindings.find(b => b.bindingId === operation.bindingId) : undefined;
        if (operation.bindingId && (!binding || binding.teamBotId !== operation.teamBotId || binding.purpose !== `team-${operation.mode}`))
          throw new Error('Retained Team Bot operation binding mismatch');
      }
      for (const operation of Object.values(state.resourceOperations)) if (!state.bindings.some(binding => binding.bindingId === operation.bindingId && binding.purpose === 'team-member')
        || (operation.receipt && operation.receipt.planHash !== operation.planHash)) throw new Error('Retained resource operation binding mismatch');
      for (const [id, receipt] of Object.entries(state.revocations)) if (!/^revoke:[a-f0-9]{64}$/.test(id)
        || teamOwner(receipt.actor, receipt.teamBotId, receipt.mode) !== state.owner) throw new Error('Retained revocation receipt scope mismatch');
      for(const [id,receipt] of Object.entries(state.candidateReceipts))if(id!==receipt.contextId || teamOwner(receipt.actor,receipt.teamBotId,receipt.mode)!==state.owner
        || !state.bindings.some(b=>b.bindingId===receipt.bindingId && b.teamBotId===receipt.teamBotId && b.purpose===`team-${receipt.mode}`))throw new Error('Retained native candidate receipt scope mismatch');
      if (!['stopped', 'disabled'].includes(state.phase)) {
        for (const login of Object.values(state.logins)) if (login.state === 'pending') login.state = 'interrupted';
        state.phase = 'interrupted'; state.cleanupRequired = true; state.error = 'Broker restarted. Retry to reconcile the retained runtime and profiles; uncertain chat work is not replayed.';
      }
      state.network ??= config.network;
      state.onlineMode ??= state.network === 'proxy' ? 'proxy' : 'internet';
      this.driver.setNetwork?.(state.owner, state.network);
      this.states.set(state.owner, state);
    }
  }
  private state(owner: string, create = false) {
    runtimeOwnerId.parse(owner);
    if (this.failed) throw new LocalError(503, 'Broker storage needs repair and restart.');
    let s = this.states.get(owner);
    if (!s && create) {
      if (this.states.size >= this.config.maxUsers) throw new LocalError(409, 'Personal runtime capacity reached.');
      s = { owner, generation: 0, phase: 'disabled', error: null, cleanupRequired: false, bindings: [], confirmed: [], pending: {}, tests: {}, logins: {}, network: this.config.network, onlineMode: this.config.network === 'proxy' ? 'proxy' : 'internet', networkRevision: 0, networks: {}, connections: {}, teams: {}, resourceOperations: {}, revocations: {}, candidateReceipts:{} };
      const dir = path.join(this.config.stateDir, runtimeKey(owner));
      mkdirSync(dir, { mode: 0o700 }); this.driver.setNetwork?.(owner, s.network!); this.states.set(owner, s); this.save(s);
    }
    return s;
  }
  private save(s: Stored) {
    try {
      const dir = path.join(this.config.stateDir, runtimeKey(s.owner));
      const file = path.join(dir, 'runtime.json'), temp = `${file}.tmp`;
      const fd = openSync(temp, 'w', 0o600);
      try { writeFileSync(fd, JSON.stringify(s)); fsyncSync(fd); } finally { closeSync(fd); }
      renameSync(temp, file);
      const d = openSync(dir, 'r'); try { fsyncSync(d); } finally { closeSync(d); }
    } catch {
      this.failed = true;
      for (const owner of this.states.keys()) void this.driver.stop(owner).catch(() => {});
      throw new LocalError(503, 'Broker metadata could not be persisted. Runtimes are stopping; repair storage without deleting bindings.');
    }
  }
  private exclusive<T>(owner: string, run: () => Promise<T>) {
    const before = this.queues.get(owner) ?? Promise.resolve();
    const task = before.catch(() => {}).then(run); this.queues.set(owner, task);
    void task.finally(() => { if (this.queues.get(owner) === task) this.queues.delete(owner); }).catch(() => {});
    return task;
  }
  async status(owner: string): Promise<DockerStatus> {
    const s = this.state(owner);
    if (!s) return { network: this.config.network, phase: 'disabled', error: null, generation: 0, bindings: [], unlinked: [] };
    const generation = s.generation;
    if (s.phase === 'ready' && !this.maintaining.has(owner) && !await this.driver.running(owner) && s.phase === 'ready' && generation === s.generation && !this.maintaining.has(owner)) {
      s.phase = 'stopped'; s.error = 'Native runtime stopped. Retry to reopen retained profiles.'; this.save(s);
    }
    const unlinked = s.phase === 'ready' && !this.maintaining.has(owner) ? (await this.driver.profiles(owner)).filter(p => p.name !== 'default' &&
      !s.bindings.some(b => (b.profile === p.name || b.identity === p.identity) && s.confirmed.includes(b.bindingId)) && !Object.values(s.pending).some(b => b.profile === p.name)) : [];
    return { network: s.network!, phase: s.phase, error: s.error, generation: s.generation, bindings: s.bindings.filter(b => !b.purpose && s.confirmed.includes(b.bindingId)),
      unlinked: unlinked.filter(p => !/^cui-team-[a-f0-9]{32}$/.test(p.name)) };
  }
  private unsettledNetwork(s: Stored) {
    return Object.values(s.networks).find(m => ['pending', 'applied', 'failed'].includes(m.state));
  }
  async networkStatus(owner: string, inspect = true): Promise<NetworkStatus> {
    const s = this.state(owner), mode = s?.network ?? this.config.network;
    let actual: NetworkStatus['actual'] = 'unknown', running: boolean | null = null;
    try { if (inspect && this.driver.networkStatus) ({ actual, running } = await this.driver.networkStatus(owner)); } catch {}
    const latest = Object.values(s?.networks ?? {}).at(-1);
    const receipt = latest ? networkReceipt.parse(Object.fromEntries(Object.keys(networkReceipt.shape).map(k => [k, latest[k as keyof NetworkMigration]]))) : null;
    return { mode, onlineMode: s?.onlineMode ?? (mode === 'proxy' ? 'proxy' : 'internet'), actual, running, revision: s?.networkRevision ?? 0, changing: this.maintaining.has(owner), receipt,
      error: s?.cleanupRequired || latest?.state === 'failed' ? 'Network recovery needs operator reconciliation. Native data is retained.' : latest?.state === 'rolled_back' ? s?.error ?? null : null };
  }
  /** Reconcile exact retained migration identities BEFORE opening IPC or cleanup completion. */
  async recoverNetworks() {
    const failed = new Set<string>();
    // A failure for one owner must not leave another owner's native processes unsupervised.
    // Stop every identity first; only then attempt restoration/backup removal and journal writes.
    for (const s of this.states.values()) {
      const m = Object.values(s.networks).at(-1);
      try {
        if (m && m.state !== 'rolled_back' && m.snapshotReady && m.originalId) {
          if (!this.driver.stopNetwork) throw new Error('Missing recovery');
          await this.driver.stopNetwork(s.owner, m);
        } else await this.driver.stop(s.owner);
      } catch { failed.add(s.owner); }
    }
    for (const s of this.states.values()) {
      const m = Object.values(s.networks).at(-1);
      try {
        if (failed.has(s.owner)) throw new Error('Stop unconfirmed');
        if (m?.state === 'committed' && m.originalId) {
          if (!this.driver.finishNetwork) throw new Error('Missing recovery');
          await this.driver.finishNetwork(s.owner, m);
        } else if (m && !['committed', 'rolled_back'].includes(m.state)) {
          if (m.snapshotReady && m.originalId) {
            if (!this.driver.rollbackNetwork) throw new Error('Missing recovery');
            await this.driver.rollbackNetwork(s.owner, m);
          }
          this.driver.setNetwork?.(s.owner, m.previous); s.network = m.previous; s.connections = {}; m.state = 'rolled_back';
          s.error = 'An interrupted network change was rolled back. The retained runtime is stopped; review the policy and retry explicitly.';
        }
        s.phase = s.bindings.length ? 'stopped' : 'disabled'; s.cleanupRequired = false; this.save(s);
      } catch {
        failed.add(s.owner);
        if (m && m.state !== 'committed') m.state = 'failed';
        s.phase = 'error'; s.cleanupRequired = true;
        s.error = 'Network recovery or retained-container cleanup needs operator reconciliation. Native storage is retained.';
        try { this.save(s); } catch {} // All other owners have already received their stop attempt.
      }
    }
    if (failed.size) throw new LocalError(503, 'Retained runtime cleanup is unconfirmed for one or more owners. IPC remains closed; native storage is retained.');
  }
  requestNetwork(owner: string, raw: unknown, actor: string) {
    this.authorized(owner); ownerId.parse(actor);
    const input = networkRequest.parse(raw), s = this.state(owner, true)!;
    const prior = s.networks[input.requestId];
    if (prior) {
      if (prior.requested !== input.mode || prior.revision !== input.revision || prior.actor !== actor)
        throw new LocalError(409, 'This network request already has different details.');
      return; // An uncertain HTTP response never creates a second replacement.
    }
    if (s.networkRevision !== input.revision) throw new LocalError(409, 'Network policy changed. Reload before applying it.');
    if (this.queues.has(owner) || this.jobs.has(owner) || this.maintaining.has(owner) || this.pendingLogin(owner) || s.cleanupRequired || this.unsettledNetwork(s))
      throw new LocalError(409, 'Finish current runtime work or sign-in, then retry the network change.');
    if (Object.keys(s.networks).length >= 128) throw new LocalError(409, 'Network receipt capacity reached. Ask the operator to archive settled receipts.');
    if (!this.driver.snapshotNetwork || !this.driver.changeNetwork || !this.driver.rollbackNetwork || !this.driver.finishNetwork || !this.driver.stopNetwork)
      throw new LocalError(503, 'Update the broker before changing network access.');
    const release: (() => void)[] = [];
    try {
      // Synchronous admission fence: every sibling must be idle before acceptance.
      for (const b of s.bindings) { const c = this.controllers.get(b.bindingId); if (c) release.push(c.holdForSettings()); }
    } catch (e) { release.forEach(fn => fn()); throw e; }
    const oldPhase = s.phase, generation = ++s.generation;
    const m: NetworkMigration = { ...input, previous: s.network!, requested: input.mode, state: 'pending', checkedAt: new Date().toISOString(), actor,
      wasRunning: s.phase === 'ready', originalId: null, replacementId: null, snapshotReady: false, profiles: [] };
    // Browser-only confirmation is not a journal field.
    delete (m as NetworkMigration & { mode?: string; confirmRestart?: boolean }).mode;
    delete (m as NetworkMigration & { confirmRestart?: boolean }).confirmRestart;
    s.networks[input.requestId] = m; this.maintaining.add(owner);
    try { this.save(s); } catch (e) { release.forEach(fn => fn()); this.maintaining.delete(owner); throw e; }
    const current = () => { this.authorized(owner); if (s.generation !== generation) throw new LocalError(409, 'Network change cancelled because runtime access changed.'); };
    const task = this.exclusive(owner, async () => {
      try {
        current();
        if (m.previous !== m.requested) {
          const snapshot = await this.driver.snapshotNetwork!(owner, m.requestId); current();
          Object.assign(m, snapshot, { snapshotReady: true });
          const actual = await this.driver.networkStatus?.(owner); current();
          m.wasRunning = actual?.running === true;
          if (snapshot.originalId && s.bindings.some(b => !snapshot.profiles.some(p => p.name === b.profile && p.identity === b.identity)))
            throw new LocalError(409, 'A retained profile binding changed. Reconcile it before changing the network.');
          this.save(s); // Exact original ID and complete roster survive before rename/start.
          if (m.originalId) {
            await this.driver.stop(owner); current();
            for (const b of s.bindings) { await this.controllers.get(b.bindingId)?.stop(); this.controllers.delete(b.bindingId); }
            current(); m.replacementId = await this.driver.changeNetwork!(owner, m, current); current();
            if (!m.wasRunning) { await this.driver.stop(owner); current(); }
          } else this.driver.setNetwork?.(owner, m.requested);
        }
        current(); s.network = m.requested; s.connections = {}; m.state = 'applied'; this.save(s);
        current(); ++s.networkRevision; if (m.requested !== 'none') s.onlineMode = m.requested; m.state = 'committed'; this.save(s); // Commit BEFORE deleting backup.
        if (m.originalId) await this.driver.finishNetwork!(owner, m);
        current();
        s.phase = m.wasRunning ? 'ready' : oldPhase; s.error = null; s.cleanupRequired = false; this.save(s);
      } catch (e) {
        try {
          if (m.state === 'committed') {
            // Durable commit stands; leave the current runtime stopped, retry cleanup on restart.
            if (m.originalId) await this.driver.stopNetwork!(owner, m); else await this.driver.stop(owner); s.phase = 'error'; s.cleanupRequired = true;
            s.error = 'Network policy committed, but retained-container cleanup needs an operator restart. Native data is retained.';
          } else {
            if (m.snapshotReady && m.originalId) await this.driver.rollbackNetwork!(owner, m);
            else { this.driver.setNetwork?.(owner, m.previous); await this.driver.stop(owner); }
            s.network = m.previous; s.connections = {}; m.state = 'rolled_back';
            s.phase = s.bindings.length ? 'stopped' : 'disabled'; s.cleanupRequired = false;
            s.error = e instanceof LocalError ? e.message : 'Network change failed and was rolled back. Review the policy and retry explicitly.';
          }
        } catch { if (m.state !== 'committed') m.state = 'failed'; s.phase = 'error'; s.cleanupRequired = true; s.error = 'Network recovery is unconfirmed. Ask the operator to reconcile retained containers; native data is retained.'; }
        this.save(s);
      } finally { release.forEach(fn => fn()); this.maintaining.delete(owner); }
    });
    this.jobs.set(owner, task);
    void task.finally(() => { this.jobs.delete(owner); }).catch(() => {});
  }
  async settleNetwork(owner: string) { await this.jobs.get(owner); return this.networkStatus(owner); }
  async checkConnectivity(owner: string, id: string, raw: unknown): Promise<Connectivity> {
    const input = z.object({ revision: z.string().regex(/^[a-f0-9]{64}$/) }).strict().parse(raw);
    return this.exclusive(owner, async () => {
      const s = await this.ready(owner), b = this.binding(owner, id), generation = s.generation;
      if (!this.driver.settings || !this.driver.connectivity) throw new LocalError(503, 'Update the bridge before checking provider connectivity.');
      const value = await this.driver.settings(owner, b.profile, b.identity);
      if (value.revision !== input.revision) throw new LocalError(409, 'Saved provider settings changed. Reload before checking.');
      if (!value.provider) throw new LocalError(409, 'Save a supported provider before checking connectivity.');
      const blocker = providerBlocker(value, value.provider);
      if (blocker) throw new LocalError(409, blocker);
      const prior = sConnection(s, id, value.revision);
      if (prior && Date.now() - Date.parse(prior.checkedAt) < 10000) return prior;
      const result: Connectivity = { provider: value.provider, revision: value.revision, checkedAt: new Date().toISOString(), code: 'unavailable' };
      if (s.network === 'none') result.code = 'offline';
      else try { result.code = await this.driver.connectivity(owner, value.provider); } catch {}
      this.authorized(owner);
      if (s.generation !== generation || s.phase !== 'ready') throw new LocalError(409, 'Runtime access changed. Reload before checking again.');
      s.connections[id] = connectivity.parse(result); this.save(s); return result;
    });
  }
  enable(owner: string) {
    ownerId.parse(owner);
    this.enableRuntime(owner, true);
  }
  private enableRuntime(owner: string, personal: boolean) {
    this.authorized(owner, personal);
    const s = this.state(owner, true)!;
    if (this.maintaining.has(owner) || this.unsettledNetwork(s)) throw new LocalError(409, 'Wait for the network change or ask the operator to reconcile it.');
    if (this.jobs.has(owner)) return;
    if (s.phase === 'ready') {
      // Team-only provisioning never enrolls a personal starter. A later personal enable
      // can pair the retained default without interrupting the runtime or changing its volume.
      if (personal && !s.bindings.some(b => b.profile === 'default' && s.confirmed.includes(b.bindingId))) {
        this.creationJobs.add(owner);
        const task = this.exclusive(owner, async () => {
          this.authorized(owner, true); await this.ready(owner);
          const native = (await this.driver.profiles(owner)).find(p => p.name === 'default');
          if (!native) throw new LocalError(409, 'The native default profile is not initialized.');
          await this.bind(s, 'default', native.identity, 'Hermes');
        });
        this.jobs.set(owner, task);
        void task.finally(() => { this.jobs.delete(owner); this.creationJobs.delete(owner); }).catch(() => {});
      }
      return;
    }
    if (s.phase === 'stopping') throw new LocalError(409, 'Wait for cancellation to settle before retrying.');
    const generation = ++s.generation;
    if (personal) this.creationJobs.add(owner);
    s.phase = 'checking_image'; s.cleanupRequired = false; s.error = null; this.save(s);
    const current = () => { this.authorized(owner, personal); if (s.generation !== generation) throw new LocalError(409, 'Provisioning cancelled.'); };
    const task = this.exclusive(owner, async () => {
      try {
        // Cold recovery first proves all prior native processes ended. No automatic turn replay.
        await this.driver.stop(owner); current();
        for (const b of s.bindings) { await this.controllers.get(b.bindingId)?.stop(); this.controllers.delete(b.bindingId); }
        current();
        await this.driver.ensure(owner, phase => { current(); s.phase = phase; this.save(s); }); current();
        // Retained device flows are never resumed after runtime/broker restart.
        for (const b of s.bindings) if (this.driver.codex) {
          const login = Object.values(s.logins).filter(v => v.bindingId === b.bindingId).at(-1);
          await this.driver.codex(owner, b.profile, b.identity, { action: 'recover',
            ...(login && ['pending', 'interrupted'].includes(login.state) ? { sessionId: login.sessionId } : {}) });
        }
        for (const login of Object.values(s.logins)) if (login.state === 'pending') login.state = 'interrupted';
        s.phase = 'pairing'; this.save(s);
        const defaultProfile = (await this.driver.profiles(owner)).find(p => p.name === 'default');
        if (!defaultProfile) throw new LocalError(409, 'The native default profile is not initialized. Inspect this runtime in Hermes.');
        if (personal) await this.bind(s, 'default', defaultProfile.identity, 'Hermes'); current();
        // Persisting the default mapping before ready makes polling/reload pairing deterministic.
        s.phase = 'ready'; s.error = null; this.save(s);
      } catch (e) {
        try { await this.driver.stop(owner); s.cleanupRequired = false; }
        catch { s.cleanupRequired = true; s.phase = 'error'; s.error = 'Native cleanup is unconfirmed. Ask the operator to stop the owned runtime before retrying.'; this.save(s); return; }
        s.phase = s.generation !== generation ? 'stopped' : 'error';
        s.error = s.phase === 'stopped' ? null : e instanceof LocalError ? e.message : 'Native setup failed. Data is retained; inspect the runtime before retrying.';
        this.save(s);
      }
    });
    this.jobs.set(owner, task);
    void task.finally(() => { this.jobs.delete(owner); this.creationJobs.delete(owner); }).catch(() => {});
  }
  requestRevoke(owner: string) {
    // Return promptly: a slow Docker stop must not starve other owners' lease renewal.
    this.leases.delete(owner);
    const s = this.state(owner);
    if (!s || (['disabled', 'stopped'].includes(s.phase) && !this.maintaining.has(owner))) return { stopped: true, failed: false };
    const failed = s.cleanupRequired && s.phase === 'error';
    if (s.phase !== 'stopping') void this.stop(owner).catch(() => {});
    return { stopped: false, failed };
  }
  async revoke(owner: string) {
    // Invalidate before awaiting cleanup, including when Docker cannot confirm stop.
    this.leases.delete(owner);
    await this.stop(owner);
  }
  async stop(owner: string) {
    const s = this.state(owner); if (!s) return;
    const candidate=this.candidateOwners.get(owner);
    if(candidate){candidate.phase='retiring';clearTimeout(candidate.timer);}
    for(const [id,entry] of this.candidateConfigs)if(entry.binding.ownerId===owner)this.candidateConfigs.delete(id);
    for (const [id, grant] of this.teamGrants) if (teamOwner(grant.actor, grant.teamBotId, grant.mode) === owner) this.teamGrants.delete(id);
    for (const login of Object.values(s.logins)) if (login.state === 'pending') login.state = 'interrupted';
    ++s.generation; s.cleanupRequired = true; s.phase = 'stopping'; s.error = null; this.save(s);
    const urgent = this.resourceMaintaining.has(owner) ? this.driver.stop(owner) : null;
    if (urgent) void urgent.catch(() => {});
    await this.exclusive(owner, async () => {
      try { if (urgent) await urgent; await this.driver.stop(owner); }
      catch { s.phase = 'error'; s.error = 'Native cleanup is unconfirmed. Data is retained; operator reconciliation is required.'; this.save(s); throw new LocalError(503, s.error); }
      for (const b of s.bindings) { await this.controllers.get(b.bindingId)?.stop(); this.controllers.delete(b.bindingId); }
      if(candidate){candidate.release.forEach(fn=>fn());this.candidateOwners.delete(owner);}
      for(const receipt of Object.values(s.candidateReceipts))if(receipt.state!=='stopped')receipt.state='stopped';
      s.cleanupRequired = false; s.phase = 'stopped'; this.save(s);
    });
  }
  private async ready(owner: string) {
    this.authorized(owner);
    const s = this.state(owner);
    if (this.maintaining.has(owner)) throw new LocalError(409, 'Runtime maintenance is in progress. Reload after it settles.');
    if(this.candidateOwners.has(owner))throw new LocalError(409,'A native Team context owns this runtime. Finish or stop it before opening a sibling profile.');
    if (!s || s.phase !== 'ready' || !await this.driver.running(owner)) throw new LocalError(409, 'Enable your Hermes runtime first.');
    return s;
  }
  private async bind(s: Stored, profile: string, identity: string, name: string) {
    if (s.bindings.some(b => b.identity === identity && b.profile !== profile)) throw new LocalError(409, 'This native profile identity is already bound under another name. Operator rename reconciliation is required.');
    const existing = s.bindings.find(b => b.profile === profile);
    if (existing) {
      if (existing.identity !== identity) throw new LocalError(409, 'The native profile was replaced or renamed. Its prior bot binding cannot be reassigned.');
      await this.controller(existing);
      if (!s.confirmed.includes(existing.bindingId)) { s.confirmed.push(existing.bindingId); this.save(s); }
      return existing;
    }
    if (s.bindings.length >= this.config.maxProfiles) throw new LocalError(409, 'Profile capacity reached.');
    const b: DockerBinding = { bindingId: key(), botId: key(), appId: key(), ownerId: s.owner, runtimeId: runtimeKey(s.owner), profile, identity, name };
    // Write-ahead app identity; retry after an uncertain handshake reuses these IDs.
    s.bindings.push(b); this.save(s);
    await this.controller(b); s.confirmed.push(b.bindingId); this.save(s); return b;
  }
  async link(owner: string, raw: unknown) {
    const input = z.object({ profile: profileName, identity: z.string().max(100), name: z.string().trim().min(1).max(80) }).strict().parse(raw);
    if (input.profile === 'default') throw new LocalError(400, 'The default profile is paired automatically.');
    if (/^cui-team-[a-f0-9]{32}$/.test(input.profile) && !this.state(owner)?.bindings.some(b => b.profile === input.profile && !b.purpose))
      throw new LocalError(403, 'Team profiles cannot be linked as personal bots.');
    return this.exclusive(owner, async () => {
      this.authorized(owner, true);
      if (this.pendingLogin(owner)) throw new LocalError(409, 'Finish or cancel subscription sign-in first.');
      const s = await this.ready(owner);
      const found = (await this.driver.profiles(owner)).find(p => p.name === input.profile && p.identity === input.identity);
      if (!found) throw new LocalError(409, 'The discovered profile changed. Refresh Unlinked profiles.');
      return this.bind(s, found.name, found.identity, input.name);
    });
  }
  async create(owner: string, raw: unknown) {
    const input = z.object({ requestId: z.string().uuid(), name: z.string().trim().min(1).max(80) }).strict().parse(raw);
    return this.exclusive(owner, async () => {
      this.authorized(owner, true);
      if (this.pendingLogin(owner)) throw new LocalError(409, 'Finish or cancel subscription sign-in first.');
      const s = await this.ready(owner);
      let pending = s.pending[input.requestId];
      if (!pending) {
        if (Object.keys(s.pending).length + s.bindings.filter(b => !b.profile.startsWith('cui-')).length >= this.config.maxProfiles)
          throw new LocalError(409, 'Profile capacity reached.');
        pending = { name: input.name, profile: `cui-${key()}` };
        s.pending[input.requestId] = pending; this.save(s);
      } else if (pending.name !== input.name) throw new LocalError(409, 'This creation request already has another name.');
      const existing = s.bindings.find(b => b.profile === pending.profile);
      if (existing) return this.bind(s, existing.profile, existing.identity, existing.name);
      const native = await this.driver.create(owner, pending.profile);
      return this.bind(s, native.name, native.identity, pending.name);
    });
  }
  binding(owner: string, id: string) {
    const s = this.state(owner);
    const b = s?.bindings.find(b => b.bindingId === id && s.confirmed.includes(b.bindingId));
    if (!b) throw new LocalError(403, 'This native profile does not belong to your runtime.');
    if (b.purpose) throw new LocalError(403, 'Team profiles require current bot authorization.');
    return b;
  }
  async resources(owner: string, id: string) {
    const b = this.binding(owner, id); await this.ready(owner);
    return this.driver.resources(owner, b.profile, b.identity);
  }
  async profileSettings(owner: string, id: string): Promise<ProfileSettings> {
    return this.exclusive(owner, async () => {
    await this.ready(owner); const b = this.binding(owner, id);
    if (this.maintaining.has(owner)) throw new LocalError(409, 'Profile settings are being updated. Reload after they settle.');
    if (!this.driver.settings) throw new LocalError(503, 'This runtime does not support profile settings.');
    const value = await this.driver.settings(owner, b.profile, b.identity);
    const lastTest = Object.values(this.state(owner)!.tests).filter(t => t.bindingId === id && t.revision === value.revision).at(-1);
    return { ...value, connectivity: sConnection(this.state(owner)!, id, value.revision), lastTest: lastTest ? { code: lastTest.code, checkedAt: lastTest.checkedAt, revision: lastTest.revision } : null };
    });
  }
  private async maintain<T>(owner: string, id: string, run: (s: Stored, b: DockerBinding, current: () => void) => Promise<T>, oauth = false) {
    return this.exclusive(owner, async () => {
      if (!oauth && this.pendingLogin(owner)) throw new LocalError(409, 'Finish or cancel subscription sign-in first.');
      const s = await this.ready(owner), b = this.binding(owner, id), generation = ++s.generation;
      this.maintaining.add(owner);
      const release: (() => void)[] = [];
      const current = () => { this.authorized(owner); if (s.generation !== generation || s.phase !== 'ready') throw new LocalError(409, 'Runtime access changed. Reload before continuing.'); };
      try {
        // An already-dispatched request may hold a controller reference. Fence begin() too.
        for (const binding of s.bindings) { const controller = this.controllers.get(binding.bindingId); if (controller) release.push(controller.holdForSettings()); }
        current(); return await run(s, b, current);
      } finally { release.forEach(fn => fn()); this.maintaining.delete(owner); }
    });
  }
  async updateProfile(owner: string, id: string, raw: unknown) {
    const input = profileUpdate.parse(raw);
    return this.maintain(owner, id, async (s, b, current) => {
      if (!this.driver.settings || !this.driver.reopen) throw new LocalError(503, 'This runtime does not support profile settings.');
      const before = await this.driver.settings(owner, b.profile, b.identity); current();
      if (before.revision !== input.revision) throw new LocalError(409, 'Profile settings changed. Reload before saving.');
      const unchanged = input.credential.action === 'keep' && (['provider', 'model', 'maxTurns', 'reasoningEffort'] as const).every(k => input[k] === before[k]);
      if (unchanged) return { ...before, lastTest: null };
      const blocker = providerBlocker(before, input.provider);
      if (blocker) throw new LocalError(409, blocker);
      if (!before.advancedSupported) throw new LocalError(409, 'Native advanced values are outside this editor. Use native maintenance before changing them.');
      try {
        // Stop all native writers before the transaction. Holds above ensure no sibling work is lost.
        await this.driver.stop(owner);
        for (const binding of s.bindings) await this.controllers.get(binding.bindingId)?.stop();
        current(); await this.driver.reopen(owner); current();
        const value = await this.driver.settings(owner, b.profile, b.identity, input); current();
        // Lazy controller startup on the next chat reloads native settings; receipts remain on disk.
        for (const binding of s.bindings) this.controllers.delete(binding.bindingId);
        return { ...value, lastTest: null };
      } catch (e) {
        // A timed-out bridge may still be writing. Stop before permitting any native admission.
        try { await this.driver.stop(owner); s.cleanupRequired = false; }
        catch { s.cleanupRequired = true; }
        s.phase = 'error'; s.error = 'Settings could not be fully applied. Data is retained. Restart your runtime, then reload settings to see the committed values.'; this.save(s);
        throw e;
      }
    });
  }
  async testProfile(owner: string, id: string, raw: unknown): Promise<ProfileTestResult> {
    const input = profileTest.parse(raw);
    return this.maintain(owner, id, async (s, b, current) => {
      const previous = s.tests[input.requestId];
      if (previous) {
        if (previous.bindingId !== id || previous.revision !== input.revision) throw new LocalError(409, 'This test request belongs to another settings revision.');
        return { code: previous.code, revision: previous.revision, checkedAt: previous.checkedAt };
      }
      if (!this.driver.settings || !this.driver.testSettings) throw new LocalError(503, 'This runtime does not support connection tests.');
      const value = await this.driver.settings(owner, b.profile, b.identity); current();
      if (value.revision !== input.revision) throw new LocalError(409, 'Profile settings changed. Reload before testing.');
      if (Object.keys(s.tests).length >= 1000) throw new LocalError(409, 'Connection-test receipt capacity reached. Ask the operator to archive settled receipts.');
      const result = { bindingId: id, revision: input.revision, checkedAt: new Date().toISOString(), code: 'uncertain' as ProfileTestResult['code'] };
      s.tests[input.requestId] = result; this.save(s); // Never replay a possibly charged request after a crash.
      if (s.network === 'none') result.code = 'network_blocked';
      else {
        try { result.code = z.enum(testCodes).parse((await this.driver.testSettings(owner, b.profile, b.identity, input.revision)).code); }
        catch { result.code = 'uncertain'; }
      }
      current(); this.save(s);
      return { code: result.code, revision: result.revision, checkedAt: result.checkedAt };
    });
  }
  private pendingLogin(owner: string) {
    return Object.values(this.state(owner)?.logins ?? {}).find(v => v.state === 'pending');
  }
  async codexState(owner: string, id: string): Promise<CodexStatus> {
    return this.exclusive(owner, async () => {
      await this.ready(owner); const b = this.binding(owner, id);
      if (!this.driver.codex) throw new LocalError(503, 'Native subscription login is unavailable.');
      return codexStatus.parse(await this.driver.codex(owner, b.profile, b.identity, { action: 'read' }));
    });
  }
  async codexMutation(owner: string, id: string, raw: unknown): Promise<CodexStatus> {
    const input = codexAction.parse(raw);
    return this.maintain(owner, id, async (s, b, current) => {
      if (!this.driver.codex || !this.driver.settings || !this.driver.reopen) throw new LocalError(503, 'Native subscription login is unavailable.');
      const pending = this.pendingLogin(owner);
      if (pending && pending.bindingId !== id) throw new LocalError(409, 'Finish sign-in on your other profile first.');
      const latest = Object.values(s.logins).filter(v => v.bindingId === id).at(-1);
      let receipt: Stored['logins'][string] | undefined;
      if (input.action === 'start') {
        receipt = s.logins[input.requestId];
        if (receipt) {
          if (receipt.bindingId !== id) throw new LocalError(409, 'This request belongs to another profile.');
          if (receipt.state !== 'pending') return { state: receipt.state, sessionId: receipt.sessionId };
          return codexStatus.parse(await this.driver.codex(owner, b.profile, b.identity, { action: 'read' }));
        }
        if (pending) throw new LocalError(409, 'Finish or cancel the existing sign-in first.');
        if (s.network === 'none') return { state: 'blocked' };
        if (Object.keys(s.logins).length >= 128) throw new LocalError(409, 'Sign-in receipt capacity reached. Ask the operator to archive settled receipts.');
      } else if (input.action === 'poll' || input.action === 'cancel') {
        receipt = Object.values(s.logins).find(v => v.sessionId === input.sessionId && v.bindingId === id);
        if (!receipt || receipt !== latest) throw new LocalError(409, 'This sign-in is stale. Reload this profile.');
        if (input.action === 'poll' && receipt.state !== 'pending') return { state: receipt.state, sessionId: receipt.sessionId };
        if (input.action === 'cancel' && receipt.state === 'cancelled') return { state: 'cancelled', sessionId: receipt.sessionId };
      } else if (pending) throw new LocalError(409, 'Cancel the pending sign-in first.');
      if (input.action === 'start' || input.action === 'disconnect') {
        const before = await this.driver.settings(owner, b.profile, b.identity); current();
        if (before.revision !== input.revision) throw new LocalError(409, 'Profile settings changed. Reload before signing in.');
        const blocker = providerBlocker(before, 'openai-codex');
        if (blocker) throw new LocalError(409, blocker);
        if (input.action === 'start' && before.provider !== 'openai-codex')
          throw new LocalError(409, 'Save the ChatGPT / Codex provider and reconcile unsupported native routing first.');
      }
      try {
        if (input.action !== 'poll') {
          await this.driver.stop(owner);
          for (const binding of s.bindings) { await this.controllers.get(binding.bindingId)?.stop(); this.controllers.delete(binding.bindingId); }
          current(); await this.driver.reopen(owner); current();
        }
        if (input.action === 'start') {
          receipt = { bindingId: id, sessionId: randomUUID(), state: 'pending', expiresAt: Date.now() + 900000 };
          s.logins[input.requestId] = receipt; this.save(s);
        }
        const result = codexStatus.parse(await this.driver.codex(owner, b.profile, b.identity,
          input.action === 'start' ? { action: 'start', revision: input.revision, sessionId: receipt!.sessionId } : input));
        current();
        if (receipt) {
          if (result.sessionId && result.sessionId !== receipt.sessionId) throw new LocalError(503, 'Native sign-in identity mismatch.');
          receipt.state = result.state;
          if (result.expiresAt) receipt.expiresAt = Math.min(result.expiresAt, receipt.expiresAt);
        }
        if (input.action === 'disconnect' && latest) latest.state = 'cancelled';
        this.save(s);
        return result;
      } catch {
        if (receipt) receipt.state = 'interrupted';
        try { await this.driver.stop(owner); s.cleanupRequired = false; } catch { s.cleanupRequired = true; }
        s.phase = 'error'; s.error = 'Sign-in could not be confirmed. Restart your runtime and reload. An interrupted grant will not be replayed.'; this.save(s);
        throw new LocalError(503, s.error);
      }
    }, true);
  }
  async controller(b: DockerBinding) {
    if (b.purpose) throw new LocalError(409, 'Team Bot native model routing is not verified.');
    const profiles = await this.driver.profiles(b.ownerId);
    if (!profiles.some(p => p.name === b.profile && p.identity === b.identity)) throw new LocalError(409, 'Retained native profile identity changed.');
    let controller = this.controllers.get(b.bindingId);
    if (!controller) {
      const dir = path.join(this.config.stateDir, runtimeKey(b.ownerId), b.bindingId); mkdirSync(dir, { recursive: true, mode: 0o700 });
      controller = new LocalController({ trust: 'single-user-exclusive-profile', source: '/opt/hermes', python: '/opt/hermes/.venv/bin/python',
        profileHome: `/opt/data/${b.profile === 'default' ? '' : `profiles/${b.profile}`}`, workDir: b.profile === 'default' ? '/opt/data/workspace' : `/opt/data/profiles/${b.profile}/workspace`, accountHome: '/opt/data/home',
        stateDir: dir, socketPath: this.config.socketPath, label: 'Personal Docker Hermes' }, {
        validate: async () => { if (!await this.driver.running(b.ownerId)) throw new LocalError(409, 'Your runtime is stopped.'); },
        transport: () => this.driver.transport(b.ownerId, b.profile, b.identity),
      });
      this.controllers.set(b.bindingId, controller);
    }
    await controller.start();
    const paired = controller.pair({ runtimeId: controller.runtimeId, ownerId: b.ownerId, name: b.name, exclusive: true });
    return { controller, nativeBindingId: paired.bindingId };
  }
  forCleanup(owner: string, id: string) {
    this.binding(owner, id);
    const controller = this.controllers.get(id);
    if (!controller) throw new LocalError(409, 'Native replay unavailable after restart. The runtime must be stopped or reconciled.');
    const binding = controller.status().binding;
    if (!binding) throw new LocalError(409, 'Native binding is unavailable.');
    return { controller, nativeBindingId: binding.bindingId };
  }
  async forRequest(owner: string, id: string) {
    return this.exclusive(owner, async () => {
    await this.ready(owner);
    if (this.pendingLogin(owner)) throw new LocalError(409, 'Finish or cancel subscription sign-in first.');
    if (this.maintaining.has(owner)) throw new LocalError(409, 'Profile settings are being updated or tested. Try again after they settle.');
    const value = await this.controller(this.binding(owner, id));
    if (this.maintaining.has(owner)) throw new LocalError(409, 'Profile settings are being updated or tested. Try again after they settle.');
    return value;
    });
  }
  async close() { await Promise.all([...this.states.keys()].map(owner => this.stop(owner))); await this.recoverNetworks(); }
}
