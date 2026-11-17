/**
 * Encounters (Combat documents) for the manage-combat tool.
 *
 * Every change goes through the core Combat/Combatant document methods (create,
 * rollInitiative/rollAll/rollNPC, setInitiative, startCombat, nextTurn, previousTurn,
 * nextRound, previousRound, delete) rather than writing round/turn/initiative fields
 * directly, because game systems override exactly those methods: DSA5 resets defense
 * counts on a round change, skips minion groups and defeated combatants in its own
 * nextTurn, and deals burning damage at the round start from an updateCombat hook.
 * The confirmation dialog of Combat#endCombat is skipped by calling delete(), which is
 * what that dialog's "yes" does.
 */

import { ERROR_MESSAGES } from './constants.js';
import { permissionManager } from './permissions.js';
import {
  dsa5AdvanceWarnings,
  dsa5CombatExtras,
  dsa5CombatantExtras,
  dsa5EndBlocker,
  dsa5ForgetInitiativeDie,
  dsa5Snapshot,
  isDsa5,
} from './dsa5-encounter.js';

export type CombatAction =
  | 'state'
  | 'create'
  | 'add'
  | 'start'
  | 'initiative'
  | 'next-turn'
  | 'previous-turn'
  | 'next-round'
  | 'previous-round'
  | 'update-combatant'
  | 'remove-combatant'
  | 'activate'
  | 'end';

export type InitiativeMode = 'all' | 'npcs' | 'missing';
export type MessageMode = 'public' | 'gm' | 'blind' | 'self';

export interface ManageCombatRequest {
  action: CombatAction;
  combat?: string;
  scene?: string;
  name?: string;
  tokens?: string[];
  tokenSet?: 'all' | 'hostile-and-friendly';
  rollInitiative?: InitiativeMode | 'none';
  begin?: boolean;
  mode?: InitiativeMode;
  combatants?: string[];
  set?: Array<{ combatant: string; value: number }>;
  messageMode?: MessageMode;
  defeated?: boolean;
  hidden?: boolean;
}

interface SnapshotEntry {
  name: string;
  values: Record<string, { label: string; value: unknown }>;
}

const READ_ACTIONS: CombatAction[] = ['state'];

const DISPOSITIONS: Record<number, string> = {
  [-2]: 'secret',
  [-1]: 'hostile',
  0: 'neutral',
  1: 'friendly',
};

// Hooks that fire while a system reacts to a turn change (damage, effects, chat cards).
const SETTLE_HOOKS = [
  'updateActor',
  'createActiveEffect',
  'updateActiveEffect',
  'deleteActiveEffect',
  'createChatMessage',
  'updateCombatant',
  'updateToken',
  'createItem',
  'updateItem',
  'deleteItem',
];

const lower = (s: unknown) => String(s ?? '').toLowerCase();

// Initiative carries tie-breaking decimals (DSA5 adds 1d99 * 0.00001); drop float noise.
const ini = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? Math.round(value * 1e5) / 1e5 : null;

export class CombatManager {
  /** How long the world must stay quiet before a change counts as finished. */
  settleQuietMs = 300;
  /** Upper bound for waiting on system hooks after a change. */
  settleMaxMs = 8000;
  /**
   * After a round change, how long to wait for the first reaction. DSA5 starts its
   * round-start damage from an updateCombat hook it does not await, and the first chat
   * card (dice rendering, templates) took more than a second in testing.
   */
  roundSettleMs = 2000;

  async handle(request: ManageCombatRequest): Promise<any> {
    const action = request.action;
    if (!READ_ACTIONS.includes(action)) {
      const check = permissionManager.checkWritePermission('manageCombat');
      if (!check.allowed) {
        throw new Error(`${ERROR_MESSAGES.ACCESS_DENIED}: ${check.reason}`);
      }
    }

    switch (action) {
      case 'state':
        return { success: true, ...this.buildState(this.resolveCombat(request)) };
      case 'create':
        return this.create(request);
      case 'add':
        return this.add(request);
      case 'start':
        return this.start(request);
      case 'initiative':
        return this.initiative(request);
      case 'next-turn':
      case 'previous-turn':
      case 'next-round':
      case 'previous-round':
        return this.advance(request, action);
      case 'update-combatant':
        return this.updateCombatants(request);
      case 'remove-combatant':
        return this.removeCombatants(request);
      case 'activate':
        return this.activate(request);
      case 'end':
        return this.end(request);
      default:
        throw new Error(`Unknown action: ${String(action)}`);
    }
  }

  // ── lookups ─────────────────────────────────────────────────────────────

  resolveScene(ref?: string): any {
    const scenes = game.scenes as any;
    if (ref) {
      const scene = scenes.get(ref) ?? scenes.find((s: any) => lower(s.name) === lower(ref));
      if (!scene) throw new Error(`Scene not found: ${ref}`);
      return scene;
    }
    const scene = scenes.current ?? (globalThis as any).canvas?.scene;
    if (!scene) throw new Error('No active scene. Activate a scene or pass "scene".');
    return scene;
  }

  private combatsOnScene(scene: any): any[] {
    return [...((game as any).combats ?? [])].filter((c: any) => c.scene?.id === scene.id);
  }

  /**
   * The encounter named by id or name, else the active one on the scene, else the
   * only one there.
   */
  resolveCombat(request: { combat?: string; scene?: string }): any {
    const combats = (game as any).combats;
    if (request.combat) {
      const byId = combats?.get(request.combat);
      if (byId) return byId;
      const byName = [...(combats ?? [])].filter(
        (c: any) => lower(c.name) === lower(request.combat)
      );
      if (byName.length === 1) return byName[0];
      if (byName.length > 1) {
        throw new Error(
          `Several encounters are named "${request.combat}": ${byName.map((c: any) => c.id).join(', ')}. Pass the id.`
        );
      }
      throw new Error(`Encounter not found: ${request.combat}`);
    }
    const scene = this.resolveScene(request.scene);
    const onScene = this.combatsOnScene(scene);
    if (!onScene.length) {
      throw new Error(`No encounter on scene "${scene.name}". Create one with action "create".`);
    }
    const active = onScene.find((c: any) => c.active);
    if (active) return active;
    if (onScene.length === 1) return onScene[0];
    throw new Error(
      `Scene "${scene.name}" has several encounters and none is active: ${onScene
        .map((c: any) => `${c.id}${c.name ? ` (${c.name})` : ''}`)
        .join(', ')}. Pass "combat".`
    );
  }

  /**
   * Combatants by combatant id, token id, actor id or name. A name shared by several
   * combatants is reported instead of picking one.
   */
  resolveCombatants(
    combat: any,
    refs: string[]
  ): { found: any[]; errors: Array<{ ref: string; reason: string }> } {
    const all = [...combat.combatants];
    const found: any[] = [];
    const errors: Array<{ ref: string; reason: string }> = [];
    for (const ref of refs) {
      let matches = all.filter((c: any) => c.id === ref || c.tokenId === ref);
      if (!matches.length) matches = all.filter((c: any) => c.actorId === ref);
      if (!matches.length) {
        matches = all.filter(
          (c: any) => lower(c.name) === lower(ref) || lower(c.token?.name) === lower(ref)
        );
      }
      if (!matches.length) {
        errors.push({ ref, reason: 'not a combatant in this encounter' });
      } else if (matches.length > 1) {
        errors.push({
          ref,
          reason: `matches several combatants, pass a combatant or token id: ${matches
            .map((c: any) => `${c.name} (${c.id}, token ${c.tokenId})`)
            .join(', ')}`,
        });
      } else if (!found.includes(matches[0])) {
        found.push(matches[0]);
      }
    }
    return { found, errors };
  }

  // ── state ───────────────────────────────────────────────────────────────

  describeCombatant(combat: any, combatant: any, index: number): any {
    const disposition = combatant.token?.disposition;
    const entry: any = {
      index,
      id: combatant.id,
      name: combatant.name,
      tokenId: combatant.tokenId ?? null,
      actorId: combatant.actorId ?? null,
      initiative: ini(combatant.initiative),
      isCurrent: combat.started && combat.turn === index,
      defeated: !!combatant.isDefeated,
      hidden: !!combatant.hidden,
      disposition: disposition == null ? null : (DISPOSITIONS[disposition] ?? String(disposition)),
      isNPC: !!combatant.isNPC,
    };
    if (combatant.group) entry.group = combatant.group.name ?? combatant.group.id;
    if (isDsa5()) entry.dsa5 = dsa5CombatantExtras(combatant);
    return entry;
  }

  buildState(combat: any): any {
    const turns: any[] = combat.turns ?? [];
    const current = combat.started ? combat.combatant : null;
    const scene = combat.scene;
    const state: any = {
      encounter: {
        id: combat.id,
        name: combat.name || null,
        scene: scene ? { id: scene.id, name: scene.name } : null,
        active: !!combat.active,
        // The encounter shown in the bridge tab's tracker (game.combat there).
        viewed: (game as any).combats?.viewed?.id === combat.id,
        started: !!combat.started,
        round: combat.round,
        turn: combat.started ? combat.turn : null,
        current: current
          ? { combatantId: current.id, name: current.name, tokenId: current.tokenId ?? null }
          : null,
      },
      combatants: turns.map((c, i) => this.describeCombatant(combat, c, i)),
      otherEncounters: scene
        ? this.combatsOnScene(scene)
            .filter((c: any) => c.id !== combat.id)
            .map((c: any) => ({
              id: c.id,
              name: c.name || null,
              active: !!c.active,
              started: !!c.started,
              round: c.round,
              combatants: c.combatants.size,
            }))
        : [],
    };
    if (isDsa5()) state.encounter.dsa5 = dsa5CombatExtras(combat);
    return state;
  }

  // ── helpers for reporting what a change did ─────────────────────────────

  /**
   * Wait until the hooks a system runs after a change have gone quiet: at least
   * `firstWaitMs`, and then until no hook fired for `settleQuietMs`.
   */
  settle(firstWaitMs = this.settleQuietMs): Promise<void> {
    const hooks = Hooks as any;
    return new Promise(resolve => {
      const ids: Array<[string, number]> = [];
      const start = Date.now();
      let timer: ReturnType<typeof setTimeout> | undefined;
      const done = () => {
        if (timer) clearTimeout(timer);
        clearTimeout(cap);
        for (const [hook, id] of ids) hooks.off?.(hook, id);
        resolve();
      };
      const arm = (ms: number) => {
        if (timer) clearTimeout(timer);
        timer = setTimeout(check, ms);
      };
      const check = () => {
        const left = firstWaitMs - (Date.now() - start);
        if (left > 0) arm(left);
        else done();
      };
      for (const hook of SETTLE_HOOKS) {
        ids.push([hook, hooks.on(hook, () => arm(this.settleQuietMs))]);
      }
      const cap = setTimeout(done, this.settleMaxMs);
      arm(firstWaitMs);
    });
  }

  private messageIds(): Set<string> {
    return new Set([...((game as any).messages ?? [])].map((m: any) => m.id));
  }

  private newMessages(before: Set<string>): any[] {
    return [...((game as any).messages ?? [])].filter((m: any) => !before.has(m.id));
  }

  private messageText(message: any): string {
    const text = String(message.content ?? '')
      .replace(/<[^>]*>/g, ' ')
      .replace(/&nbsp;/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    const flavor = String(message.flavor ?? '')
      .replace(/<[^>]*>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    const full = [flavor, text].filter(Boolean).join(': ');
    return full.length > 240 ? `${full.slice(0, 237)}...` : full;
  }

  snapshot(combat: any): Map<string, SnapshotEntry> {
    const map = new Map<string, SnapshotEntry>();
    for (const combatant of combat.combatants) {
      const values: SnapshotEntry['values'] = {
        defeated: { label: 'defeated', value: !!combatant.isDefeated },
      };
      for (const effect of combatant.actor?.effects ?? []) {
        if (effect.disabled) continue;
        const level = effect.system?.condition?.value;
        values[`effect:${effect.id}`] = {
          label: `effect "${effect.name}"`,
          value: level == null ? 'active' : `level ${level}`,
        };
      }
      if (isDsa5()) Object.assign(values, dsa5Snapshot(combatant));
      map.set(combatant.id, { name: combatant.name, values });
    }
    return map;
  }

  diff(before: Map<string, SnapshotEntry>, after: Map<string, SnapshotEntry>): any[] {
    const report: any[] = [];
    for (const [id, old] of before) {
      const now = after.get(id);
      const changes: any[] = [];
      const keys = new Set([...Object.keys(old.values), ...Object.keys(now?.values ?? {})]);
      for (const key of keys) {
        const a = old.values[key];
        const b = now?.values[key];
        const isEffect = key.startsWith('effect:');
        const from = a ? a.value : isEffect ? 'none' : null;
        const to = b ? b.value : isEffect ? 'none' : null;
        if (JSON.stringify(from) !== JSON.stringify(to)) {
          changes.push({ what: (a ?? b).label, from, to });
        }
      }
      if (changes.length) report.push({ combatant: old.name, combatantId: id, changes });
    }
    return report;
  }

  /**
   * Runs a change and reports what the system did to the combatants meanwhile (starting
   * an encounter is a round change too: DSA5 deals burning damage at every round start).
   */
  private async tracked(combat: any, change: () => Promise<unknown>): Promise<any> {
    const before = this.snapshot(combat);
    const messagesBefore = this.messageIds();
    const roundBefore = combat.round;
    await change();
    await this.settle(combat.round !== roundBefore ? this.roundSettleMs : this.settleQuietMs);
    const changes = this.diff(before, this.snapshot(combat));
    const messages = this.newMessages(messagesBefore).map(m => this.messageText(m));
    return { changes, ...(messages.length ? { chatMessages: messages } : {}) };
  }

  // ── actions ─────────────────────────────────────────────────────────────

  private resolveTokens(
    scene: any,
    refs: string[] | undefined,
    tokenSet: ManageCombatRequest['tokenSet']
  ): { tokens: any[]; results: any[] } {
    const sceneTokens = [...scene.tokens];
    const tokens: any[] = [];
    const results: any[] = [];
    const push = (token: any, ref: string) => {
      if (tokens.includes(token)) return;
      tokens.push(token);
      results.push({ ref, tokenId: token.id, name: token.name });
    };
    if (tokenSet) {
      for (const token of sceneTokens) {
        if (tokenSet === 'hostile-and-friendly') {
          // Leave out neutral and secret bystanders unless a player owns them.
          const relevant =
            token.disposition === -1 || token.disposition === 1 || !!token.actor?.hasPlayerOwner;
          if (!relevant) continue;
        }
        push(token, tokenSet);
      }
    }
    for (const ref of refs ?? []) {
      const byId = sceneTokens.find((t: any) => t.id === ref);
      // A name may stand for several tokens (two "Grauwolf" tokens); all of them join.
      const matches = byId ? [byId] : sceneTokens.filter((t: any) => lower(t.name) === lower(ref));
      if (!matches.length) {
        results.push({
          ref,
          status: 'skipped',
          reason: `no token "${ref}" on scene "${scene.name}"`,
        });
        continue;
      }
      for (const token of matches) push(token, ref);
    }
    return { tokens, results };
  }

  /** Adds tokens to an encounter, refusing each token that is already in it. */
  private async addTokens(combat: any, scene: any, request: ManageCombatRequest): Promise<any[]> {
    const { tokens, results } = this.resolveTokens(scene, request.tokens, request.tokenSet);
    const toCreate: any[] = [];
    for (const token of tokens) {
      const result = results.find(r => r.tokenId === token.id && !r.status);
      if (combat.combatants.some((c: any) => c.tokenId === token.id)) {
        Object.assign(result, {
          status: 'skipped',
          reason: 'already a combatant in this encounter',
        });
        continue;
      }
      const elsewhere = this.combatsOnScene(scene).find(
        (c: any) => c.id !== combat.id && c.combatants.some((x: any) => x.tokenId === token.id)
      );
      if (elsewhere) {
        result.note = `also a combatant in encounter ${elsewhere.id}${elsewhere.name ? ` (${elsewhere.name})` : ''}`;
      }
      toCreate.push({
        tokenId: token.id,
        sceneId: scene.id,
        actorId: token.actorId,
        hidden: token.hidden,
      });
    }
    if (toCreate.length) {
      const created: any[] = (await combat.createEmbeddedDocuments('Combatant', toCreate)) ?? [];
      for (const data of toCreate) {
        const result = results.find(r => r.tokenId === data.tokenId && !r.status);
        const combatant = created.find((c: any) => c.tokenId === data.tokenId);
        if (combatant) Object.assign(result, { status: 'added', combatantId: combatant.id });
        else Object.assign(result, { status: 'skipped', reason: 'refused by the game system' });
      }
    }
    return results;
  }

  private async create(request: ManageCombatRequest): Promise<any> {
    if (!request.tokens?.length && !request.tokenSet) {
      throw new Error('Pass "tokens" (token ids or names) and/or "tokenSet".');
    }
    const scene = this.resolveScene(request.scene);
    const preview = this.resolveTokens(scene, request.tokens, request.tokenSet);
    if (!preview.tokens.length) {
      return {
        success: false,
        error: 'None of the given tokens is on the scene, so no encounter was created.',
        tokens: preview.results,
      };
    }
    const CombatCls = (CONFIG as any).Combat.documentClass;
    const data: any = { scene: scene.id };
    if (request.name) data.name = request.name;
    const combat = await CombatCls.create(data);
    // Like the tracker's "create encounter" button: create, then activate. Activating as an
    // update (not active: true on create) is what makes every client's tracker switch to
    // it, and game.combat is the encounter DSA5 counts defenses in.
    await combat.activate();
    return this.populate(combat, scene, request, 'created');
  }

  private async add(request: ManageCombatRequest): Promise<any> {
    if (!request.tokens?.length && !request.tokenSet) {
      throw new Error('Pass "tokens" (token ids or names) and/or "tokenSet".');
    }
    const combat = this.resolveCombat(request);
    const scene = combat.scene ?? this.resolveScene(request.scene);
    return this.populate(combat, scene, request, 'updated');
  }

  private async populate(
    combat: any,
    scene: any,
    request: ManageCombatRequest,
    verb: string
  ): Promise<any> {
    const tokens = await this.addTokens(combat, scene, request);
    const result: any = { success: true, message: `Encounter ${verb}`, tokens };
    if (request.rollInitiative && request.rollInitiative !== 'none') {
      result.initiative = await this.rollAndReport(combat, {
        mode: request.rollInitiative,
        ...(request.messageMode ? { messageMode: request.messageMode } : {}),
      });
    }
    if (request.begin && !combat.started) {
      if (!combat.combatants.size) {
        result.warnings = ['The encounter has no combatants, so it was not started.'];
      } else {
        Object.assign(result, await this.tracked(combat, () => combat.startCombat()));
      }
    }
    return { ...result, ...this.buildState(combat) };
  }

  private async start(request: ManageCombatRequest): Promise<any> {
    const combat = this.resolveCombat(request);
    if (combat.started)
      throw new Error(`The encounter is already running (round ${combat.round}).`);
    if (!combat.combatants.size) throw new Error('The encounter has no combatants.');
    const missing = combat.combatants
      .filter((c: any) => c.initiative == null)
      .map((c: any) => c.name);
    const report = await this.tracked(combat, () => combat.startCombat());
    return {
      success: true,
      message: 'Encounter started',
      ...report,
      ...(missing.length
        ? {
            warnings: [
              `No initiative yet for: ${missing.join(', ')}. They act last until it is set.`,
            ],
          }
        : {}),
      ...this.buildState(combat),
    };
  }

  private rollOptions(messageMode?: MessageMode): any {
    if (!messageMode) return {};
    const generation = Number((game as any).release?.generation) || 14;
    if (generation >= 14) return { messageMode };
    // Foundry 13 takes a roll mode through the message options instead.
    const rollMode = { public: 'publicroll', gm: 'gmroll', blind: 'blindroll', self: 'selfroll' }[
      messageMode
    ];
    return { messageOptions: { rollMode } };
  }

  /** Rolls through the system's own formula and reports value and dice per combatant. */
  private async rollAndReport(
    combat: any,
    opts: { mode?: InitiativeMode; ids?: string[]; messageMode?: MessageMode }
  ): Promise<any> {
    const before = new Map<string, unknown>(
      combat.combatants.map((c: any) => [c.id, c.initiative])
    );
    const messagesBefore = this.messageIds();
    const options = this.rollOptions(opts.messageMode);
    if (opts.ids || opts.mode === 'all') {
      const ids: string[] = opts.ids ?? combat.combatants.map((c: any) => c.id);
      if (isDsa5()) {
        await dsa5ForgetInitiativeDie(ids.map(id => combat.combatants.get(id)).filter(Boolean));
      }
      await combat.rollInitiative(ids, options);
    } else if (opts.mode === 'npcs') await combat.rollNPC(options);
    else await combat.rollAll(options);
    await this.settle();

    const rollMessages = this.newMessages(messagesBefore).filter(
      (m: any) => m.getFlag?.('core', 'initiativeRoll') ?? m.flags?.core?.initiativeRoll
    );
    const rolled: any[] = [];
    for (const combatant of combat.combatants) {
      if (before.get(combatant.id) === combatant.initiative) continue;
      const message = rollMessages.find(
        (m: any) => m.speaker?.token === combatant.tokenId && combatant.tokenId
      );
      const roll = message?.rolls?.[0];
      const entry: any = {
        combatant: combatant.name,
        combatantId: combatant.id,
        initiative: ini(combatant.initiative),
      };
      if (roll) {
        entry.formula = roll.formula;
        entry.dice = (roll.dice ?? []).map((d: any) => ({
          die: `${d.number}d${d.faces}`,
          results: (d.results ?? []).map((r: any) => r.result),
        }));
      }
      if (isDsa5()) {
        const extras = dsa5CombatantExtras(combatant);
        entry.initiativeBase = extras.initiativeBase;
      }
      rolled.push(entry);
    }
    return {
      rolled,
      order: (combat.turns ?? []).map((c: any) => ({
        name: c.name,
        initiative: ini(c.initiative),
      })),
      ...(rolled.length ? {} : { note: 'Nobody needed a roll (everyone already has initiative).' }),
    };
  }

  private async initiative(request: ManageCombatRequest): Promise<any> {
    const combat = this.resolveCombat(request);
    const result: any = { success: true };
    const errors: any[] = [];

    if (request.set?.length) {
      const set: any[] = [];
      for (const { combatant: ref, value } of request.set) {
        if (!Number.isFinite(value)) {
          errors.push({ ref, reason: 'value must be a number' });
          continue;
        }
        const { found, errors: e } = this.resolveCombatants(combat, [ref]);
        errors.push(...e);
        if (!found.length) continue;
        if (isDsa5()) await dsa5ForgetInitiativeDie(found);
        await combat.setInitiative(found[0].id, value);
        set.push({ combatant: found[0].name, combatantId: found[0].id, initiative: value });
      }
      await this.settle();
      result.set = set;
    }

    if (request.combatants?.length) {
      const { found, errors: e } = this.resolveCombatants(combat, request.combatants);
      errors.push(...e);
      if (found.length) {
        result.initiative = await this.rollAndReport(combat, {
          ids: found.map(c => c.id),
          ...(request.messageMode ? { messageMode: request.messageMode } : {}),
        });
      }
    } else if (request.mode || !request.set?.length) {
      result.initiative = await this.rollAndReport(combat, {
        mode: request.mode ?? 'missing',
        ...(request.messageMode ? { messageMode: request.messageMode } : {}),
      });
    }

    if (errors.length) result.errors = errors;
    return { ...result, ...this.buildState(combat) };
  }

  private async advance(
    request: ManageCombatRequest,
    action: 'next-turn' | 'previous-turn' | 'next-round' | 'previous-round'
  ): Promise<any> {
    const combat = this.resolveCombat(request);
    if (!combat.started) {
      throw new Error('The encounter has not started yet. Use action "start" first.');
    }
    const orderBefore: any[] = [...combat.turns];
    const roundBefore = combat.round;
    const turnBefore = combat.turn;

    const report = await this.tracked(combat, () => {
      if (action === 'next-turn') return combat.nextTurn();
      if (action === 'previous-turn') return combat.previousTurn();
      if (action === 'next-round') return combat.nextRound();
      return combat.previousRound();
    });

    const passedOver: any[] = [];
    // Combatants the system skipped on the way (defeated, or members of a minion group).
    if (action === 'next-turn') {
      const skipped =
        combat.round === roundBefore
          ? orderBefore.slice((turnBefore ?? -1) + 1, combat.turn ?? 0)
          : [
              ...orderBefore.slice((turnBefore ?? -1) + 1),
              ...combat.turns.slice(0, combat.turn ?? 0),
            ];
      for (const c of skipped) {
        passedOver.push({
          name: c.name,
          reason: c.isDefeated ? 'defeated' : c.group ? 'grouped' : 'skipped by the game system',
        });
      }
    }

    const current = combat.combatant;
    const warnings = isDsa5() ? dsa5AdvanceWarnings(combat, combat.round !== roundBefore) : [];
    return {
      success: true,
      ...(warnings.length ? { warnings } : {}),
      round: combat.round,
      turn: combat.turn,
      roundChanged: combat.round !== roundBefore,
      current: current
        ? { combatantId: current.id, name: current.name, tokenId: current.tokenId ?? null }
        : null,
      ...(passedOver.length ? { passedOver } : {}),
      ...report,
      ...this.buildState(combat),
    };
  }

  private async setDefeated(combatant: any, defeated: boolean): Promise<string[]> {
    const warnings: string[] = [];
    if (!!combatant.isDefeated === defeated) return warnings;
    const tracker = (ui as any).combat;
    if (typeof tracker?._onToggleDefeatedStatus === 'function') {
      // The tracker's skull button: sets the flag and the system's "defeated" status effect.
      await tracker._onToggleDefeatedStatus(combatant);
    } else {
      await combatant.update({ defeated });
      const statusId = (CONFIG as any).specialStatusEffects?.DEFEATED;
      if (statusId) {
        await combatant.actor?.toggleStatusEffect?.(statusId, { overlay: true, active: defeated });
      }
    }
    await this.settle();
    const statusId = (CONFIG as any).specialStatusEffects?.DEFEATED;
    const hasStatus = !!statusId && !!combatant.actor?.statuses?.has(statusId);
    if (defeated && statusId && combatant.actor && !hasStatus) {
      warnings.push(
        `${combatant.name} is marked defeated, but the game system did not add its "${statusId}" ` +
          'status to the actor (an unlinked token on a scene that is not on screen in the GM ' +
          'tab can cause this).'
      );
    }
    if (!defeated && hasStatus) {
      warnings.push(
        `${combatant.name} still carries the "${statusId}" status, so it still counts as defeated.`
      );
    }
    return warnings;
  }

  private async updateCombatants(request: ManageCombatRequest): Promise<any> {
    if (request.defeated === undefined && request.hidden === undefined) {
      throw new Error('Pass "defeated" and/or "hidden".');
    }
    if (!request.combatants?.length) throw new Error('Pass "combatants".');
    const combat = this.resolveCombat(request);
    const { found, errors } = this.resolveCombatants(combat, request.combatants);
    const warnings: string[] = [];
    const updated: any[] = [];
    const report = await this.tracked(combat, async () => {
      for (const combatant of found) {
        if (request.defeated !== undefined) {
          warnings.push(...(await this.setDefeated(combatant, request.defeated)));
        }
        if (request.hidden !== undefined && !!combatant.hidden !== request.hidden) {
          await combatant.update({ hidden: request.hidden });
        }
        updated.push({
          combatant: combatant.name,
          combatantId: combatant.id,
          defeated: !!combatant.isDefeated,
          hidden: !!combatant.hidden,
        });
      }
    });
    return {
      success: updated.length > 0,
      updated,
      ...report,
      ...(errors.length ? { errors } : {}),
      ...(warnings.length ? { warnings } : {}),
      ...this.buildState(combat),
    };
  }

  private async removeCombatants(request: ManageCombatRequest): Promise<any> {
    if (!request.combatants?.length) throw new Error('Pass "combatants".');
    const combat = this.resolveCombat(request);
    const { found, errors } = this.resolveCombatants(combat, request.combatants);
    if (found.length) {
      await combat.deleteEmbeddedDocuments(
        'Combatant',
        found.map(c => c.id)
      );
      await this.settle();
    }
    return {
      success: found.length > 0,
      removed: found.map(c => ({ combatant: c.name, combatantId: c.id })),
      ...(errors.length ? { errors } : {}),
      ...this.buildState(combat),
    };
  }

  private async activate(request: ManageCombatRequest): Promise<any> {
    const combat = this.resolveCombat(request);
    if (!combat.active) await combat.activate();
    return {
      success: true,
      message: 'Encounter is now the active one',
      ...this.buildState(combat),
    };
  }

  private async end(request: ManageCombatRequest): Promise<any> {
    const combat = this.resolveCombat(request);
    if (isDsa5()) {
      const blocker = dsa5EndBlocker(combat);
      if (blocker) return { success: false, error: blocker };
    }
    const scene = combat.scene;
    const summary = {
      id: combat.id,
      name: combat.name || null,
      round: combat.round,
      combatants: combat.combatants.map((c: any) => c.name),
    };
    // Effects on the combatants' actors, to report what the system removed with the encounter.
    const actors = new Map<string, any>();
    for (const c of combat.combatants) {
      if (c.actor) actors.set(c.id, { name: c.name, actor: c.actor });
    }
    const effectsOf = (actor: any) =>
      new Map<string, string>(
        [...(actor.effects ?? [])].filter((e: any) => !e.disabled).map((e: any) => [e.id, e.name])
      );
    const effectsBefore = new Map([...actors].map(([id, a]) => [id, effectsOf(a.actor)]));
    const messagesBefore = this.messageIds();

    await combat.delete();
    await this.settle();

    if ((game as any).combats?.has(summary.id)) {
      return {
        success: false,
        error:
          'The game system kept the encounter; it may be waiting for an answer in a Foundry ' +
          'dialog. End it from the combat tracker in Foundry.',
      };
    }
    const effectsRemoved: any[] = [];
    for (const [id, { name, actor }] of actors) {
      const now = effectsOf(actor);
      const gone = [...(effectsBefore.get(id) ?? new Map())]
        .filter(([effectId]) => !now.has(effectId))
        .map(([, effectName]) => effectName);
      if (gone.length) effectsRemoved.push({ combatant: name, effects: gone });
    }
    const messages = this.newMessages(messagesBefore).map(m => this.messageText(m));
    return {
      success: true,
      message: 'Encounter ended',
      ended: summary,
      effectsRemoved,
      ...(isDsa5()
        ? {
            note:
              'Defense counts, used actions and the other per-round tracker data lived on the ' +
              'combatants and are gone with the encounter; conditions such as "defeated" stay on ' +
              'the actors.',
          }
        : {}),
      ...(messages.length ? { chatMessages: messages } : {}),
      remainingEncounters: scene
        ? this.combatsOnScene(scene).map((c: any) => ({
            id: c.id,
            name: c.name || null,
            active: !!c.active,
            started: !!c.started,
          }))
        : [],
    };
  }
}

export const combatManager = new CombatManager();
