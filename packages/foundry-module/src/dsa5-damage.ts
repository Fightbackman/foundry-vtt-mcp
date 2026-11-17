/**
 * DSA5 damage, healing, regeneration and AsP/KaP (dsa5-apply-damage).
 *
 * Everything goes through the system's own code so its hooks run (preApplyDamage, brawling
 * points, structure points, pain and stun conditions, maintained spells):
 * - Damage and spell costs from a chat card run the handlers of DSA5's chat context menu
 *   ("Apply damage as TP/SP", "Pay AsP/KaP"). Those handlers are not exported by the
 *   system bundle, but the system adds them to every chat message's context menu through
 *   the getChatMessageContextOptions hook, so they are collected from that hook and called
 *   with the message id, exactly as a click on the menu entry does.
 * - Direct damage and healing use Actor#applyDamage (a negative amount heals, capped at the
 *   maximum), AsP/KaP use Actor#applyMana (negative restores), with the same armor rule as
 *   the system's "apply damage as TP" for plain damage cards.
 * - Regeneration runs setupRegeneration() + basicTest() like the sheet's button and applies
 *   the card with the system's RegenerationHelper.
 */

import { applyDialogDefaults, speakerTokenId } from './dsa5-rolls.js';
import { findOpposedResultMessage, opposedDamage } from './dsa5-opposed.js';

type AnyRecord = Record<string, any>;

export const DSA5_DAMAGE_ACTIONS = ['damage', 'heal', 'regenerate', 'spend', 'pay-cost'] as const;
export type Dsa5DamageAction = (typeof DSA5_DAMAGE_ACTIONS)[number];

export const DSA5_RESOURCES = ['LeP', 'AsP', 'KaP'] as const;
export type Dsa5Resource = (typeof DSA5_RESOURCES)[number];

const POOLS: Record<Dsa5Resource, string> = {
  LeP: 'wounds',
  AsP: 'astralenergy',
  KaP: 'karmaenergy',
};

// Card types the system lets "Pay AsP/KaP" run on, and those paid with AsP.
const COST_SOURCE_TYPES = ['liturgy', 'ceremony', 'spell', 'ritual', 'magicalsign'];
const ASP_SOURCE_TYPES = ['ritual', 'spell'];

/** Dialog values of the regeneration test (DSA5.regnerationCampLocations / ...InterruptOptions). */
export const DSA5_CAMPSITES = { normal: 0, bad: -1, good: 1 } as const;
export const DSA5_INTERRUPTIONS = { none: 0, small: -1, big: -2 } as const;

export interface Dsa5DamageParams {
  action: Dsa5DamageAction;
  messageId?: string | undefined;
  amount?: number | string | undefined;
  armor?: boolean | undefined;
  resource?: Dsa5Resource | undefined;
  resources?: Dsa5Resource[] | undefined;
  campsite?: keyof typeof DSA5_CAMPSITES | undefined;
  interruption?: keyof typeof DSA5_INTERRUPTIONS | undefined;
  badEnvironment?: boolean | undefined;
  modifier?: number | undefined;
  apply?: boolean | undefined;
  messageMode?: string | undefined;
}

interface ConditionState {
  name: string;
  level: number | null;
}

interface ActorSnapshot {
  values: Record<string, number>;
  max: Record<string, number>;
  conditions: Record<string, ConditionState>;
}

export interface Dsa5ConditionChanges {
  added: Array<{ id: string; name: string; level: number | null }>;
  removed: Array<{ id: string; name: string; level: number | null }>;
  changed: Array<{ id: string; name: string; from: number | null; to: number | null }>;
}

export interface Dsa5DamageResult {
  success: boolean;
  action: Dsa5DamageAction;
  error?: string;
  message?: string;
  actorName?: string;
  tokenId?: string;
  rolled?: number;
  formula?: string;
  armor?: number;
  applied?: number;
  resource?: Dsa5Resource;
  before?: Record<string, number>;
  after?: Record<string, number>;
  max?: Record<string, number>;
  conditions?: Dsa5ConditionChanges;
  regeneration?: Record<string, number>;
  messageId?: string;
  notifications?: string[];
  notes?: string[];
}

function localize(key: string): string {
  return (game as any).i18n?.localize?.(key) ?? key;
}

function utility(): any {
  return (game as any).dsa5?.apps?.DSA5_Utility;
}

function getMessage(id: string | undefined): any {
  return id ? (game as any).messages?.get?.(id) : undefined;
}

/** Actor a chat card speaks for: the token's synthetic actor when the card names a token. */
function speakerActor(speaker: AnyRecord | undefined): any {
  if (!speaker) return undefined;
  return (
    utility()?.getSpeaker?.(speaker) ??
    (speaker.actor ? (game as any).actors?.get?.(speaker.actor) : undefined)
  );
}

function fail(action: Dsa5DamageAction, error: string, extra: Partial<Dsa5DamageResult> = {}) {
  return { ...extra, success: false, action, error } as Dsa5DamageResult;
}

/** LeP/AsP/KaP (and brawling points while in use) plus every condition on the actor. */
export function snapshotDsa5Actor(actor: any): ActorSnapshot {
  const status: AnyRecord = actor?.system?.status ?? {};
  const values: Record<string, number> = {};
  const max: Record<string, number> = {};
  for (const resource of DSA5_RESOURCES) {
    const pool = status[POOLS[resource]];
    if (!pool) continue;
    const value = Number(pool.value ?? 0);
    const poolMax = Number(pool.max ?? 0);
    // Pools a character does not have (AsP of a non-caster) stay out of the report.
    if (resource !== 'LeP' && poolMax <= 0 && value === 0) continue;
    values[resource] = value;
    max[resource] = poolMax;
  }
  const brawling = status.temporaryLeP;
  if (brawling && (Number(brawling.max) > 0 || Number(brawling.value) !== 0)) {
    values.temporaryLeP = Number(brawling.value ?? 0);
    max.temporaryLeP = Number(brawling.max ?? 0);
  }

  const conditions: Record<string, ConditionState> = {};
  for (const effect of Array.from<any>(actor?.effects ?? [])) {
    const statuses: string[] = Array.from(effect?.statuses ?? []);
    const id = statuses[0] ?? `effect:${effect?.id}`;
    const raw = effect?.system?.condition?.value;
    const level = raw === undefined || raw === null ? null : Number(raw);
    const existing = conditions[id];
    // DSA5 sometimes keeps duplicate condition effects; report the highest level.
    if (!existing || (level ?? 0) > (existing.level ?? 0)) {
      conditions[id] = { name: String(effect?.name ?? id), level };
    }
  }
  return { values, max, conditions };
}

/** Timing of settledSnapshot; tests shorten it. */
export const dsa5SettleTiming = { intervalMs: 100, maxPolls: 10 };

function conditionSignature(actor: any): string {
  return JSON.stringify(snapshotDsa5Actor(actor));
}

/**
 * Snapshot after the system's follow-up hooks have run. Pain and stun levels are set inside
 * the actor update, but dependent conditions (incapacitated at pain level IV, bloodrush)
 * are added afterwards by unawaited effect hooks, so wait until nothing changes for two
 * polls (at most about a second).
 */
async function settledSnapshot(actor: any): Promise<ActorSnapshot> {
  let last = conditionSignature(actor);
  let stable = 0;
  for (let i = 0; i < dsa5SettleTiming.maxPolls && stable < 2; i++) {
    await new Promise(resolve => setTimeout(resolve, dsa5SettleTiming.intervalMs));
    const current = conditionSignature(actor);
    if (current === last) stable++;
    else {
      stable = 0;
      last = current;
    }
  }
  return snapshotDsa5Actor(actor);
}

export function diffConditions(
  before: Record<string, ConditionState>,
  after: Record<string, ConditionState>
): Dsa5ConditionChanges {
  const changes: Dsa5ConditionChanges = { added: [], removed: [], changed: [] };
  for (const [id, state] of Object.entries(after)) {
    const old = before[id];
    if (!old) changes.added.push({ id, name: state.name, level: state.level });
    else if (old.level !== state.level) {
      changes.changed.push({ id, name: state.name, from: old.level, to: state.level });
    }
  }
  for (const [id, state] of Object.entries(before)) {
    if (!after[id]) changes.removed.push({ id, name: state.name, level: state.level });
  }
  return changes;
}

/** Run `fn` and collect the error/warning notifications the system shows meanwhile. */
async function withNotifications<T>(fn: () => Promise<T>): Promise<{ value: T; notes: string[] }> {
  const notifications = (globalThis as any).ui?.notifications;
  const notes: string[] = [];
  if (!notifications) return { value: await fn(), notes };
  const kinds = ['error', 'warn'] as const;
  const originals = kinds.map(kind => ({
    kind,
    own: Object.prototype.hasOwnProperty.call(notifications, kind),
    fn: notifications[kind],
  }));
  for (const { kind, fn: original } of originals) {
    notifications[kind] = function (message: unknown, options?: AnyRecord) {
      notes.push(options?.localize ? localize(String(message)) : String(message));
      return original.call(notifications, message, options);
    };
  }
  try {
    return { value: await fn(), notes };
  } finally {
    for (const { kind, own, fn: original } of originals) {
      if (own) notifications[kind] = original;
      else delete notifications[kind];
    }
  }
}

/**
 * The system's chat context menu entry whose visibility check has the given name
 * (ConditionChecker.canHurt, canHurtSP, canCostMana, ...). DSA5 registers these through
 * the getChatMessageContextOptions hook; calling the hook with an empty list collects them
 * without rendering anything.
 */
export function dsa5ChatAction(
  visibleName: string
): ((event: unknown, li: unknown) => any) | undefined {
  const options: AnyRecord[] = [];
  (Hooks as any).call('getChatMessageContextOptions', (globalThis as any).ui?.chat, options);
  const option = options.find(
    o => o?.visible?.name === visibleName && typeof o.onClick === 'function'
  );
  return option?.onClick;
}

async function runChatAction(visibleName: string, messageId: string): Promise<boolean> {
  const onClick = dsa5ChatAction(visibleName);
  if (!onClick) return false;
  // The handlers only read li.dataset.messageId, like the menu's <li> element provides.
  await onClick(null, { dataset: { messageId } });
  return true;
}

/** A whole number or a dice formula ("2d6+2"); formulas are rolled with Foundry's Roll. */
async function resolveAmount(
  amount: number | string | undefined
): Promise<{ total?: number; formula?: string; error?: string }> {
  if (amount === undefined || amount === null || amount === '') {
    return { error: '"amount" is required: a whole number or a dice formula such as "1d6+2".' };
  }
  if (typeof amount === 'number') {
    if (!Number.isInteger(amount)) return { error: '"amount" must be a whole number.' };
    return { total: amount };
  }
  const text = amount.trim();
  if (/^[+-]?\d+$/.test(text)) return { total: Number(text) };
  try {
    const roll = await new (globalThis as any).Roll(text).evaluate();
    if (!Number.isFinite(Number(roll?.total))) throw new Error('no total');
    return { total: Math.round(Number(roll.total)), formula: text };
  } catch {
    return { error: `"${text}" is not a valid whole number or dice formula.` };
  }
}

function describeActor(actor: any, result: Dsa5DamageResult): void {
  result.actorName = actor.name;
  if (actor.isToken && actor.token?.id) result.tokenId = actor.token.id;
}

/** Fill before/after/max/conditions from two snapshots. */
function report(
  result: Dsa5DamageResult,
  before: ActorSnapshot,
  after: ActorSnapshot
): Dsa5DamageResult {
  result.before = before.values;
  result.after = after.values;
  result.max = after.max;
  const conditions = diffConditions(before.conditions, after.conditions);
  if (conditions.added.length || conditions.removed.length || conditions.changed.length) {
    result.conditions = conditions;
  }
  return result;
}

function noteNotifications(result: Dsa5DamageResult, notes: string[]): void {
  if (notes.length) result.notifications = notes;
}

function poolMax(actor: any, resource: Dsa5Resource): number {
  return Number(actor?.system?.status?.[POOLS[resource]]?.max ?? 0);
}

function armorOf(actor: any): number {
  const armorValue = actor?.constructor?.armorValue;
  if (typeof armorValue !== 'function') return 0;
  return Number(armorValue.call(actor.constructor, actor)?.armor ?? 0);
}

// ----- damage -----

async function damageDirect(actor: any, params: Dsa5DamageParams): Promise<Dsa5DamageResult> {
  const { total, formula, error } = await resolveAmount(params.amount);
  if (error || total === undefined) return fail('damage', error ?? 'Invalid amount.');
  if (total <= 0)
    return fail('damage', 'Damage must be greater than 0; use action "heal" to heal.');

  const withArmor = params.armor !== false;
  const armor = withArmor ? armorOf(actor) : 0;
  // Same rule as DSA5's "apply damage as TP" for damage cards: TP minus RS, at least 0.
  const applied = Math.max(0, Math.round(total - armor));
  const result: Dsa5DamageResult = { success: true, action: 'damage', rolled: total, applied };
  if (formula) result.formula = formula;
  if (withArmor) result.armor = armor;
  describeActor(actor, result);

  const before = snapshotDsa5Actor(actor);
  const { notes } = await withNotifications(async () => {
    if (applied > 0) await actor.applyDamage(applied);
  });
  noteNotifications(result, notes);
  result.message =
    applied > 0
      ? `${actor.name} takes ${applied} damage${withArmor ? ` (${total} TP - ${armor} RS)` : ' (SP, armor ignored)'}.`
      : `${actor.name}'s armor (${armor} RS) absorbs all ${total} TP.`;
  return report(result, before, await settledSnapshot(actor));
}

async function damageFromOpposedCard(resultMessage: any, params: Dsa5DamageParams) {
  const data: AnyRecord = resultMessage.flags.opposeData;
  const withArmor = params.armor !== false;
  const damage = opposedDamage(data);
  if (data.winner !== 'attacker' || !damage) {
    return fail('damage', 'The defender won this opposed test; there is no damage to apply.', {
      messageId: resultMessage.id,
    });
  }
  if (resultMessage.flags?.data?.damageApplied) {
    return fail(
      'damage',
      'The damage of this opposed test has already been applied (the card is marked). Use "amount" to apply more damage.',
      { messageId: resultMessage.id }
    );
  }
  if (!withArmor && damage.rolled === undefined) {
    return fail(
      'damage',
      'This card only offers its damage with armor (as TP); omit armor: false.',
      {
        messageId: resultMessage.id,
      }
    );
  }
  const amount = withArmor ? damage.afterArmor : (damage.rolled as number);
  if (!(amount > 0)) {
    return fail(
      'damage',
      `No damage gets through: ${damage.rolled ?? '?'} TP - ${damage.armor ?? '?'} RS. Pass armor: false to apply the TP as SP anyway.`,
      { messageId: resultMessage.id }
    );
  }

  const actor = speakerActor(data.speakerDefend);
  if (!actor) {
    return fail('damage', 'The defender of this opposed test no longer exists on a scene.', {
      messageId: resultMessage.id,
    });
  }

  const result: Dsa5DamageResult = {
    success: true,
    action: 'damage',
    messageId: resultMessage.id,
    applied: amount,
  };
  if (damage.rolled !== undefined) result.rolled = damage.rolled;
  if (withArmor && damage.armor !== undefined) result.armor = damage.armor;
  describeActor(actor, result);

  const before = snapshotDsa5Actor(actor);
  const { value: ran, notes } = await withNotifications(() =>
    runChatAction(withArmor ? 'canHurt' : 'canHurtSP', resultMessage.id)
  );
  if (!ran) {
    return fail(
      'damage',
      'This DSA5 version does not provide the "apply damage" chat action; apply the damage from the chat card in Foundry.'
    );
  }
  noteNotifications(result, notes);
  const after = await settledSnapshot(actor);
  if (
    after.values.LeP === before.values.LeP &&
    !getMessage(resultMessage.id)?.flags?.data?.damageApplied
  ) {
    return fail(
      'damage',
      `DSA5 did not apply the damage. ${notes.join(' ')}`.trim(),
      report(result, before, after)
    );
  }
  result.message = `${actor.name} takes ${amount} damage from the opposed test${withArmor ? '' : ' (SP, armor ignored)'}.`;
  return report(result, before, after);
}

async function damageFromCard(message: any, target: any, params: Dsa5DamageParams) {
  const postData: AnyRecord | undefined = message.flags?.data?.postData;
  const raw = postData?.chatCardDamage;
  // Damage cards (traps, damage rolls) carry chatCardDamage; a plain dice roll message its
  // roll total. A DSA5 test card's own dice (e.g. the attack d20) are no damage.
  let total = NaN;
  if (raw !== undefined && raw !== null && raw !== '') total = Number(raw);
  else if (!postData && message.isRoll) total = Number(message.rolls?.[0]?.total);
  if (!Number.isFinite(total)) {
    if (postData?.damage !== undefined) {
      return fail(
        'damage',
        `This roll has no opposed result, so DSA5 has no damage to apply from it (an attack needs a targeted token and the target's defense). To apply its damage roll anyway, call action "damage" with actor and amount ${Number(postData.damage)}.`,
        { messageId: message.id }
      );
    }
    return fail('damage', 'This chat message carries no damage DSA5 can apply.', {
      messageId: message.id,
    });
  }
  if (message.flags?.data?.damageApplied) {
    return fail('damage', 'The damage of this card has already been applied.', {
      messageId: message.id,
    });
  }
  // DSA5 applies a damage card to the controlled tokens, else to the card's speaker; here
  // the caller names the target instead of relying on the GM's token selection.
  const actor = target ?? speakerActor(message.speaker);
  if (!actor) return fail('damage', 'Pass "actor": this card has no speaker to damage.');
  const result = await damageDirect(actor, { ...params, amount: Math.round(total) });
  if (result.success) {
    result.messageId = message.id;
    await message.update({ 'flags.data.damageApplied': true });
  }
  return result;
}

async function applyDamageAction(actor: any, params: Dsa5DamageParams): Promise<Dsa5DamageResult> {
  if (!params.messageId) {
    if (!actor)
      return fail('damage', 'Pass "actor" with "amount", or "messageId" of a result card.');
    return damageDirect(actor, params);
  }
  const message = getMessage(params.messageId);
  if (!message) return fail('damage', `Chat message not found: ${params.messageId}`);

  const found = findOpposedResultMessage(message);
  if (found.message) return damageFromOpposedCard(found.message, params);
  if (found.candidates) {
    return fail(
      'damage',
      `This attack has several opposed results; pass one of these messageIds: ${found.candidates.join(', ')}.`
    );
  }
  if (found.pending) {
    return fail(
      'damage',
      'The opposed test is still pending: the target has not defended yet. Roll its defense with dsa5-roll-check (parry or dodge with the target token id), then apply the damage from the result card.',
      { messageId: message.id }
    );
  }
  return damageFromCard(message, actor, params);
}

// ----- healing and AsP/KaP -----

async function healAction(actor: any, params: Dsa5DamageParams): Promise<Dsa5DamageResult> {
  const resource = params.resource ?? 'LeP';
  const { total, formula, error } = await resolveAmount(params.amount);
  if (error || total === undefined) return fail('heal', error ?? 'Invalid amount.');
  if (total <= 0) return fail('heal', 'The amount to heal or restore must be greater than 0.');
  if (resource !== 'LeP' && poolMax(actor, resource) <= 0) {
    return fail('heal', `${actor.name} has no ${resource}.`);
  }

  const result: Dsa5DamageResult = { success: true, action: 'heal', resource, rolled: total };
  if (formula) result.formula = formula;
  describeActor(actor, result);
  const before = snapshotDsa5Actor(actor);
  // Both system methods treat a negative amount as healing and cap it at the maximum.
  const { notes } = await withNotifications(async () => {
    if (resource === 'LeP') await actor.applyDamage(-total);
    else await actor.applyMana(-total, resource);
  });
  noteNotifications(result, notes);
  const after = await settledSnapshot(actor);
  const key = resource;
  const gained = (after.values[key] ?? 0) - (before.values[key] ?? 0);
  result.applied = gained;
  result.message = `${actor.name} regains ${gained} ${resource}${gained < total ? ` (${total} requested, capped at the maximum of ${after.max[key]})` : ''}.`;
  return report(result, before, after);
}

async function spendAction(actor: any, params: Dsa5DamageParams): Promise<Dsa5DamageResult> {
  const resource = params.resource;
  if (resource !== 'AsP' && resource !== 'KaP') {
    return fail('spend', '"resource" must be "AsP" or "KaP" (use action "damage" for LeP).');
  }
  if (poolMax(actor, resource) <= 0) return fail('spend', `${actor.name} has no ${resource}.`);
  const { total, formula, error } = await resolveAmount(params.amount);
  if (error || total === undefined) return fail('spend', error ?? 'Invalid amount.');
  if (total <= 0) return fail('spend', 'The amount to spend must be greater than 0.');

  const result: Dsa5DamageResult = { success: true, action: 'spend', resource, rolled: total };
  if (formula) result.formula = formula;
  describeActor(actor, result);
  const before = snapshotDsa5Actor(actor);
  // skipPowerSource: with charged power sources (Kraftspeicher) DSA5 would ask in a dialog
  // how to split the cost; a GM ruling through the bridge pays from the actor's own AsP.
  const { value: paid, notes } = await withNotifications(() =>
    actor.applyMana(total, resource, { skipPowerSource: true })
  );
  noteNotifications(result, notes);
  const after = await settledSnapshot(actor);
  report(result, before, after);
  if (!paid) {
    return {
      ...result,
      success: false,
      error: `${actor.name} has only ${before.values[resource] ?? 0} ${resource}; DSA5 refused to spend ${total}.`,
    };
  }
  result.applied = total;
  result.message = `${actor.name} spends ${total} ${resource}.`;
  return result;
}

async function payCostAction(params: Dsa5DamageParams): Promise<Dsa5DamageResult> {
  if (!params.messageId) {
    return fail('pay-cost', '"messageId" of the spell or liturgy chat card is required.');
  }
  const message = getMessage(params.messageId);
  if (!message) return fail('pay-cost', `Chat message not found: ${params.messageId}`);
  const data: AnyRecord | undefined = message.flags?.data;
  const source = data?.preData?.source;
  const calc: AnyRecord = data?.preData?.calculatedSpellModifiers ?? {};
  if (!source || (!COST_SOURCE_TYPES.includes(source.type) && !calc.costsMana)) {
    return fail('pay-cost', 'This chat message is not a spell, ritual, liturgy or ceremony card.');
  }
  if (data?.manaApplied) {
    return fail('pay-cost', 'The cost of this card has already been paid.', {
      messageId: message.id,
    });
  }
  const actor = speakerActor(message.speaker);
  if (!actor) return fail('pay-cost', 'The caster of this card no longer exists.');

  const resource: Dsa5Resource =
    ASP_SOURCE_TYPES.includes(source.type) || calc.costsMana ? 'AsP' : 'KaP';
  const cost = Number(calc.finalcost);
  const current = Number(actor.system?.status?.[POOLS[resource]]?.value ?? 0);
  const result: Dsa5DamageResult = {
    success: true,
    action: 'pay-cost',
    resource,
    messageId: message.id,
  };
  if (Number.isFinite(cost)) result.applied = cost;
  describeActor(actor, result);

  const charged = (actor.powersource?.segments ?? []).some((s: AnyRecord) => Number(s?.value) > 0);
  if (resource === 'AsP' && charged) {
    return fail(
      'pay-cost',
      `${actor.name} has charged power sources (Kraftspeicher); DSA5 asks in a dialog how to split the cost, so pay it from the chat card in Foundry, or spend AsP directly with action "spend".`,
      { messageId: message.id }
    );
  }
  // DSA5 marks the card as paid even when the payment fails, so check first.
  if (Number.isFinite(cost) && cost > current) {
    return fail(
      'pay-cost',
      `${actor.name} has only ${current} ${resource} but ${source.name} costs ${cost}; nothing was paid.`,
      { messageId: message.id, actorName: actor.name }
    );
  }

  const before = snapshotDsa5Actor(actor);
  const { value: ran, notes } = await withNotifications(() =>
    runChatAction('canCostMana', message.id)
  );
  if (!ran) {
    return fail(
      'pay-cost',
      'This DSA5 version does not provide the "pay AsP/KaP" chat action; pay from the chat card in Foundry.'
    );
  }
  noteNotifications(result, notes);
  report(result, before, await settledSnapshot(actor));
  if (!getMessage(message.id)?.flags?.data?.manaApplied) {
    return {
      ...result,
      success: false,
      error:
        `DSA5 did not take the cost (e.g. a cooperative casting pays on its summary card). ${notes.join(' ')}`.trim(),
    };
  }
  result.message = `${actor.name} pays ${Number.isFinite(cost) ? cost : calc.finalcost} ${resource} for ${source.name}.`;
  return result;
}

// ----- regeneration -----

function regenerationHelper(): any {
  return (game as any).dsa5?.apps?.RegenerationHelper;
}

/** Apply a regeneration card through the system, as its "regenerate" context entry does. */
async function applyRegenerationCard(
  message: any,
  actor: any,
  result: Dsa5DamageResult
): Promise<{ applied: boolean; notes: string[] }> {
  const helper = regenerationHelper();
  const postData: AnyRecord = message.flags?.data?.postData ?? {};
  if (helper.hasNegative(postData) && !postData.negativeRegenerationConfirmed) {
    // DSA5 asks before applying a negative regeneration; declining sets the negative pools
    // to 0, which is what happens here (there is nobody to confirm a loss headless).
    const amounts = helper.normalizeAmounts(postData);
    for (const key of DSA5_RESOURCES) if (amounts[key] < 0) amounts[key] = 0;
    (result.notes ??= []).push(
      'The regeneration roll came out negative; as when the confirmation is declined in DSA5, negative values were treated as 0.'
    );
    const { value, notes } = await withNotifications(async () => {
      const ok = await helper.applyToActor(actor, amounts, { skipConfirm: true });
      if (ok) await helper.markApplied(message);
      return Boolean(ok);
    });
    return { applied: value, notes };
  }
  const { value, notes } = await withNotifications(async () =>
    Boolean(await helper.applyFromMessage(message, { allowGM: true }))
  );
  return { applied: value, notes };
}

function regenerationAmounts(postData: AnyRecord): Record<string, number> {
  const out: Record<string, number> = {};
  for (const key of DSA5_RESOURCES) {
    if (postData?.[key] !== undefined && postData[key] !== null) out[key] = Number(postData[key]);
  }
  return out;
}

async function regenerateFromCard(params: Dsa5DamageParams): Promise<Dsa5DamageResult> {
  const message = getMessage(params.messageId);
  if (!message) return fail('regenerate', `Chat message not found: ${params.messageId}`);
  const helper = regenerationHelper();
  const postData: AnyRecord = message.flags?.data?.postData ?? {};
  if (postData.rollType !== 'regenerate' || !helper?.hasRegenStats(postData)) {
    return fail('regenerate', 'This chat message is not a regeneration roll.');
  }
  if (helper.isApplied(message)) {
    return fail('regenerate', 'This regeneration has already been applied.', {
      messageId: message.id,
    });
  }
  const actor = helper.getActorFromMessage(message);
  if (!actor) return fail('regenerate', 'The actor of this regeneration roll no longer exists.');

  const result: Dsa5DamageResult = {
    success: true,
    action: 'regenerate',
    messageId: message.id,
    regeneration: regenerationAmounts(postData),
  };
  describeActor(actor, result);
  const before = snapshotDsa5Actor(actor);
  const { applied, notes } = await applyRegenerationCard(message, actor, result);
  noteNotifications(result, notes);
  report(result, before, await settledSnapshot(actor));
  if (!applied) {
    return {
      ...result,
      success: false,
      error: `DSA5 did not apply the regeneration. ${notes.join(' ')}`.trim(),
    };
  }
  result.message = `${actor.name} regenerates.`;
  return result;
}

async function regenerateAction(actor: any, params: Dsa5DamageParams): Promise<Dsa5DamageResult> {
  if (params.messageId) return regenerateFromCard(params);
  if (!actor)
    return fail(
      'regenerate',
      'Pass "actor" to roll a regeneration, or "messageId" of a regeneration card to apply it.'
    );
  const helper = regenerationHelper();
  if (typeof actor.setupRegeneration !== 'function' || !helper) {
    return fail('regenerate', 'This DSA5 version does not provide the regeneration test.');
  }
  const campsite = params.campsite ?? 'normal';
  const interruption = params.interruption ?? 'none';
  if (!(campsite in DSA5_CAMPSITES)) {
    return fail('regenerate', `campsite must be one of ${Object.keys(DSA5_CAMPSITES).join(', ')}.`);
  }
  if (!(interruption in DSA5_INTERRUPTIONS)) {
    return fail(
      'regenerate',
      `interruption must be one of ${Object.keys(DSA5_INTERRUPTIONS).join(', ')}.`
    );
  }
  const modifier = params.modifier ?? 0;
  if (!Number.isInteger(modifier)) return fail('regenerate', 'modifier must be a whole number.');
  const wanted = new Set<Dsa5Resource>(
    params.resources?.length ? params.resources : DSA5_RESOURCES
  );

  const options: AnyRecord = { bypass: true };
  if (params.messageMode) options.messageMode = params.messageMode;
  const setup = await actor.setupRegeneration('regenerate', options, speakerTokenId(actor));
  if (!setup?.testData) return fail('regenerate', 'DSA5 did not start the regeneration test.');

  // What the regeneration dialog's callback adds when confirmed with these inputs.
  applyDialogDefaults(setup, modifier);
  const testData = setup.testData;
  const config: AnyRecord = (game as any).dsa5?.config ?? {};
  const campValue = DSA5_CAMPSITES[campsite];
  const interruptValue = DSA5_INTERRUPTIONS[interruption];
  testData.situationalModifiers.push(
    {
      name: `${localize('camplocation')} - ${localize(config.regnerationCampLocations?.[campValue] ?? campsite)}`,
      value: campValue,
    },
    {
      name: `${localize('interruption')} - ${localize(config.regenerationInterruptOptions?.[interruptValue] ?? interruption)}`,
      value: interruptValue,
    }
  );
  testData.regenerationFactor = params.badEnvironment ? 0.5 : 1;
  const status: AnyRecord = actor.system?.status ?? {};
  const consumeTemp: AnyRecord = {};
  for (const key of DSA5_RESOURCES) {
    const regenerate = wanted.has(key) ? 1 : 0;
    testData[`${key}Modifier`] = 0;
    testData[`regeneration${key}`] = Number(status.regeneration?.[`${key}max`] ?? 0);
    testData[`regenerate${key}`] = regenerate;
    // One-off regeneration bonuses (e.g. from a potion) are used up by the test.
    if (regenerate) consumeTemp[`system.status.regeneration.${key}Temp`] = 0;
  }
  await actor.update(consumeTemp);

  const outcome = await actor.basicTest(setup);
  const rolled = outcome?.result;
  if (!rolled) return fail('regenerate', `DSA5 did not roll the regeneration for ${actor.name}.`);

  const result: Dsa5DamageResult = {
    success: true,
    action: 'regenerate',
    regeneration: regenerationAmounts(rolled),
  };
  if (rolled.messageId) result.messageId = String(rolled.messageId);
  describeActor(actor, result);
  const notes: string[] = [];
  if (wanted.has('AsP') && params.resources?.includes('AsP') && !actor.system?.isMage) {
    notes.push(`${actor.name} is not a spellcaster; no AsP were regenerated.`);
  }
  if (wanted.has('KaP') && params.resources?.includes('KaP') && !actor.system?.isPriest) {
    notes.push(`${actor.name} is not a blessed one; no KaP were regenerated.`);
  }
  const blocked = helper.regenerationPhaseBlocks?.(actor) ?? [];
  if (blocked.length) notes.push(`No regeneration while affected by: ${blocked.join(', ')}.`);
  if (notes.length) result.notes = notes;

  const before = snapshotDsa5Actor(actor);
  const message = getMessage(result.messageId);
  if (params.apply === false || !message) {
    result.message = `${actor.name} rolled a regeneration; it was not applied. Apply it with action "regenerate" and messageId "${result.messageId}".`;
    return report(result, before, before);
  }
  const { applied, notes: shown } = await applyRegenerationCard(message, actor, result);
  noteNotifications(result, shown);
  report(result, before, await settledSnapshot(actor));
  if (!applied) {
    return {
      ...result,
      success: false,
      error: `DSA5 rolled but did not apply the regeneration. ${shown.join(' ')}`.trim(),
    };
  }
  result.message = `${actor.name} regenerates.`;
  return result;
}

/**
 * Entry point of dsa5-apply-damage. `actor` is the resolved actor or token actor (unlinked
 * tokens resolve to their synthetic actor), or undefined for card-based actions.
 */
export async function applyDsa5Damage(
  actor: any,
  params: Dsa5DamageParams
): Promise<Dsa5DamageResult> {
  switch (params.action) {
    case 'damage':
      return applyDamageAction(actor, params);
    case 'heal':
      if (!actor) return fail('heal', '"actor" is required.');
      return healAction(actor, params);
    case 'spend':
      if (!actor) return fail('spend', '"actor" is required.');
      return spendAction(actor, params);
    case 'pay-cost':
      return payCostAction(params);
    case 'regenerate':
      return regenerateAction(actor, params);
    default:
      return fail(
        params.action,
        `Unknown action "${String(params.action)}". Use one of ${DSA5_DAMAGE_ACTIONS.join(', ')}.`
      );
  }
}
