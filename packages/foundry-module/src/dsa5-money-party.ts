/**
 * DSA5 money and party support (dsa5-money / dsa5-party).
 *
 * Money in DSA5 is a set of `money` items on the actor (Dukaten, Silbertaler, Heller,
 * Kreuzer; worth 10 / 1 / 0.1 / 0.01 Silbertaler in `system.price.value`, count in
 * `system.quantity.value`). Paying and receiving go through the system's own
 * `DSA5Payment.executePayment`, so change-making across coins, the affordability check,
 * the chat message and the money tracker journal entry are exactly the system's.
 *
 * The party is the system's own definition (ActorPickerDialog #getTrackedActors): the
 * members of the primary party group actor (setting `primaryParty`), else the GM menu's
 * tracked heroes (setting `trackedActors`), else every player-owned actor. Group
 * Schicksalspunkte live in the world setting `groupschips` as "current/max".
 */

const COIN_VALUES = { dukaten: 10, silbertaler: 1, heller: 0.1, kreuzer: 0.01 } as const;

export type Dsa5CoinAmount = Partial<Record<keyof typeof COIN_VALUES, number>>;
export type Dsa5Amount = number | string | Dsa5CoinAmount;

export interface Dsa5MoneyRequest {
  action: 'get' | 'pay' | 'receive' | 'transfer';
  actors?: string[];
  party?: boolean;
  amount?: Dsa5Amount;
  from?: string;
  to?: string;
  postToChat?: boolean;
  description?: string;
}

export interface Dsa5PartyRequest {
  action: 'get' | 'schips' | 'add-member' | 'remove-member' | 'set-primary';
  group?: string;
  list?: 'auto' | 'group' | 'gmMenu';
  target?: string;
  operation?: 'use' | 'restore' | 'set';
  amount?: number;
  value?: number;
  max?: number;
  actor?: string;
}

const round2 = (n: number): number => Math.round((n + Number.EPSILON) * 100) / 100;

function g(): any {
  return game as any;
}

function payment(): any {
  const P = g().dsa5?.apps?.DSA5Payment;
  if (!P?.executePayment) {
    throw new Error('The DSA5 payment API (game.dsa5.apps.DSA5Payment) is not available');
  }
  return P;
}

/** The system's chat/refusal texts are HTML with coin icons whose name is only in the tooltip. */
export function moneyHtmlToText(html: string): string {
  return String(html ?? '')
    .replace(/<span[^>]*data-tooltip="([^"]*)"[^>]*><\/span>/g, ' $1')
    .replace(/<[^>]+>/g, '')
    .replace(/\s+/g, ' ')
    .replace(/\s+([.,])/g, '$1')
    .trim();
}

/**
 * Resolve an actor strictly: id, exact name, unique case-insensitive name, unique partial
 * name, or a scene token id. Money changes must never land on the wrong actor, so an
 * ambiguous name is an error instead of a first match.
 */
export function resolveDsa5Actor(identifier: string): { actor?: any; error?: string } {
  const actors: any[] = Array.from(g().actors ?? []);
  const byId = g().actors?.get?.(identifier);
  if (byId) return { actor: byId };
  const lower = identifier.toLowerCase();
  // Most specific match first; several actors at the same level is an ambiguity.
  const levels = [
    actors.filter(a => a.name === identifier),
    actors.filter(a => a.name?.toLowerCase() === lower),
    actors.filter(a => a.name?.toLowerCase().includes(lower)),
  ];
  for (const matches of levels) {
    if (matches.length === 1) return { actor: matches[0] };
    if (matches.length > 1) {
      return {
        error: `"${identifier}" matches several actors (${matches.map(a => a.name).join(', ')}); use the actor id`,
      };
    }
  }
  const scenes: any[] = Array.from(g().scenes ?? []);
  for (const scene of scenes) {
    const token = scene.tokens?.get?.(identifier);
    if (token?.actor) return { actor: token.actor };
  }
  return { error: `Actor not found: ${identifier}` };
}

/**
 * The party as the system defines it for its payment/AP dialogs (ActorPickerDialog
 * #getTrackedActors): primary party group members, else GM menu tracked heroes, else
 * player-owned actors.
 */
export function resolveDsa5Party(): {
  source: 'primaryParty' | 'gmMenu' | 'playerOwned';
  group: any;
  actors: any[];
} {
  const partyUuid = g().settings.get('dsa5', 'primaryParty');
  const group = partyUuid ? ((globalThis as any).fromUuidSync?.(partyUuid) ?? null) : null;
  if (group?.system?.actors?.size) {
    return { source: 'primaryParty', group, actors: Array.from(group.system.actors) };
  }
  const tracked: string[] = g().settings.get('dsa5', 'trackedActors')?.actors ?? [];
  const all: any[] = Array.from(g().actors ?? []);
  if (tracked.length) {
    const actors = all
      .filter(a => tracked.includes(a.id))
      .sort((a, b) => tracked.indexOf(a.id) - tracked.indexOf(b.id));
    return { source: 'gmMenu', group, actors };
  }
  return { source: 'playerOwned', group, actors: all.filter(a => a.hasPlayerOwner) };
}

/** Coins the system counts as money (subcategory 1 is excluded by DSA5Payment._actorsMoney). */
function standardCoins(actor: any): any[] {
  return Array.from(actor.items ?? []).filter(
    (i: any) => i.type === 'money' && i.system?.subcategory != 1
  );
}

/**
 * A compact purse: coin name -> count (highest value first) and the total in Silbertaler.
 * Names are the item names on the actor (German worlds: "Silber", English: "Silverthaler").
 */
export function purseOf(actor: any): {
  coins: Record<string, number>;
  total: number;
  otherMoney?: Record<string, number>;
} {
  const items = standardCoins(actor)
    .map((i: any) => ({
      name: i.name as string,
      value: Number(i.system?.price?.value) || 0,
      quantity: Number(i.system?.quantity?.value) || 0,
    }))
    .sort((a, b) => b.value - a.value);
  const coins: Record<string, number> = {};
  for (const c of items) coins[c.name] = (coins[c.name] ?? 0) + c.quantity;
  const total = round2(items.reduce((sum, c) => sum + c.value * c.quantity, 0));
  const other: Record<string, number> = {};
  const allItems: any[] = Array.from(actor.items ?? []);
  for (const i of allItems) {
    if (i.type === 'money' && i.system?.subcategory == 1) {
      other[i.name] = Number(i.system?.quantity?.value) || 0;
    }
  }
  return { coins, total, ...(Object.keys(other).length ? { otherMoney: other } : {}) };
}

/** Per coin: the signed change in count, only for coins that changed. */
function coinChanges(
  before: ReturnType<typeof purseOf>,
  after: ReturnType<typeof purseOf>
): Record<string, number> {
  const changes: Record<string, number> = {};
  for (const [name, count] of Object.entries(after.coins)) {
    const change = count - (before.coins[name] ?? 0);
    if (change !== 0) changes[name] = change;
  }
  return changes;
}

/**
 * The amount as coins, computed in whole Kreuzer. The system's own _moneyToString works in
 * floating point and can print 0.3 S as "2 Heller 10 Kreuzer", so it is not used here.
 */
export function amountToCoinText(
  money: number,
  coinDefs?: Array<{ name: string; value: number }>
): string {
  const defs = (coinDefs?.length ? coinDefs : DEFAULT_COIN_NAMES)
    .filter(c => c.value > 0)
    .sort((a, b) => b.value - a.value);
  let rest = Math.round(money * 100);
  const parts: string[] = [];
  for (const coin of defs) {
    const unit = Math.round(coin.value * 100);
    if (unit <= 0) continue;
    const count = Math.floor(rest / unit);
    rest -= count * unit;
    if (count > 0) parts.push(`${count} ${coin.name}`);
  }
  return parts.join(' ') || '0';
}

const DEFAULT_COIN_NAMES = [
  { name: 'Dukaten', value: 10 },
  { name: 'Silbertaler', value: 1 },
  { name: 'Heller', value: 0.1 },
  { name: 'Kreuzer', value: 0.01 },
];

function coinDefsOf(actor: any): Array<{ name: string; value: number }> {
  return standardCoins(actor).map((i: any) => ({
    name: i.name,
    value: Number(i.system?.price?.value) || 0,
  }));
}

function trackerJournal(actor: any): any {
  return Array.from(g().journal ?? []).find((j: any) => j.flags?.dsa5?.moneyTrackerId === actor.id);
}

function trackerEntryCount(actor: any): number {
  const journal = trackerJournal(actor);
  if (!journal) return 0;
  return Array.from(journal.pages ?? [])
    .filter((p: any) => p.type === 'dsamoneytracker')
    .reduce((n: number, p: any) => n + Object.keys(p.system?.entries ?? {}).length, 0);
}

/** Mirrors the conditions under which MoneyTracker (JournalTracker.track) writes an entry. */
function trackerStatus(actor: any, entriesBefore: number): Record<string, unknown> {
  if (!g().settings.get('dsa5', 'enableMoneyTracking')) {
    return { status: 'disabled', reason: 'the DSA5 money tracking setting is off' };
  }
  if (!actor.hasPlayerOwner) {
    return {
      status: 'skipped',
      reason: 'the system only tracks money of actors with a player owner',
    };
  }
  const journal = trackerJournal(actor);
  if (journal && trackerEntryCount(actor) > entriesBefore) {
    return { status: 'recorded', journal: journal.name, journalId: journal.id };
  }
  return { status: 'not recorded' };
}

/** Turn the tool's amount into what DSA5Payment accepts: a number or a roll formula (Silbertaler). */
export function amountToPaymentInput(amount: Dsa5Amount | undefined): {
  input?: number | string;
  error?: string;
} {
  if (amount === undefined || amount === null) return { error: 'amount is required' };
  if (typeof amount === 'number') {
    return Number.isFinite(amount) && amount > 0
      ? { input: round2(amount) }
      : { error: 'amount must be a positive number of Silbertaler' };
  }
  if (typeof amount === 'string') {
    const trimmed = amount.trim();
    return trimmed ? { input: trimmed } : { error: 'amount must not be empty' };
  }
  let sum = 0;
  for (const [key, count] of Object.entries(amount)) {
    const value = COIN_VALUES[key as keyof typeof COIN_VALUES];
    if (value === undefined) return { error: `Unknown coin "${key}"` };
    if (count === undefined) continue;
    if (!Number.isInteger(count) || count < 0) {
      return { error: `${key} must be a non-negative whole number` };
    }
    sum += count * value;
  }
  sum = round2(sum);
  return sum > 0 ? { input: sum } : { error: 'amount must be more than 0' };
}

async function evaluate(
  P: any,
  input: number | string
): Promise<{ money: number; rolled: boolean } | null> {
  const evaluated = await P.evaluatePaymentAmount(input, { showDice: false });
  if (!evaluated) return null;
  return { money: round2(evaluated.money), rolled: evaluated.roll?.isDeterministic === false };
}

function resolveTargets(request: Dsa5MoneyRequest): { actors?: any[]; error?: string } {
  const actors: any[] = [];
  for (const identifier of request.actors ?? []) {
    const { actor, error } = resolveDsa5Actor(identifier);
    if (!actor) return { error: error ?? `Actor not found: ${identifier}` };
    actors.push(actor);
  }
  // Reading defaults to the party; writes must name their targets (actors and/or party).
  if (request.party || (request.action === 'get' && !request.actors?.length)) {
    const party = resolveDsa5Party();
    if (request.party && !party.actors.length) {
      return {
        error: 'The party is empty (no primary party, no GM menu heroes, no player-owned actors)',
      };
    }
    actors.push(...party.actors);
  }
  return { actors: actors.filter((a, i) => actors.findIndex(b => b.id === a.id) === i) };
}

/** Standard coin items from the system's money compendium, as the system adds them to new actors. */
async function standardMoneyItems(): Promise<any[]> {
  return (await g().dsa5.apps.DSA5_Utility.allMoneyItems()) ?? [];
}

async function ensureCoins(actor: any, moneyItems: any[]): Promise<boolean> {
  if (standardCoins(actor).length) return false;
  await actor.createEmbeddedDocuments(
    'Item',
    (globalThis as any).foundry.utils.deepClone(moneyItems)
  );
  return true;
}

async function runPayment(
  P: any,
  actor: any,
  mode: 'pay' | 'getPaid',
  money: number,
  request: Dsa5MoneyRequest,
  description: string,
  before = purseOf(actor)
): Promise<{ result: any; before: any; after: any; tracker: Record<string, unknown> }> {
  const entriesBefore = trackerEntryCount(actor);
  // Same options the system uses when the GM executes a payment request for an actor
  // (PaymentRequestService.executeForActor), plus an optional chat message.
  const result = await P.executePayment(actor, mode, money, {
    silent: true,
    render: true,
    showChatMessage: !!request.postToChat,
    notifyOnFailure: false,
    track: true,
    description,
    showDice: false,
  });
  return { result, before, after: purseOf(actor), tracker: trackerStatus(actor, entriesBefore) };
}

export async function dsa5Money(request: Dsa5MoneyRequest): Promise<any> {
  const P = payment();

  if (request.action === 'get') {
    const { actors, error } = resolveTargets(request);
    if (!actors) return { success: false, error };
    const entries = actors.map(a => ({ id: a.id, name: a.name, type: a.type, purse: purseOf(a) }));
    return {
      success: true,
      actors: entries,
      total: round2(entries.reduce((sum, e) => sum + e.purse.total, 0)),
      unit: 'Silbertaler',
    };
  }

  const { input, error: amountError } = amountToPaymentInput(request.amount);
  if (input === undefined) return { success: false, error: amountError };
  const description = request.description?.trim() ?? '';

  if (request.action === 'transfer') {
    if (!request.from || !request.to)
      return { success: false, error: 'transfer needs from and to' };
    const from = resolveDsa5Actor(request.from);
    if (!from.actor) return { success: false, error: from.error };
    const to = resolveDsa5Actor(request.to);
    if (!to.actor) return { success: false, error: to.error };
    if (from.actor.id === to.actor.id) {
      return { success: false, error: 'from and to are the same actor' };
    }
    const evaluated = await evaluate(P, input);
    if (!evaluated) return { success: false, error: `Invalid amount: ${String(input)}` };

    const canPay = await P.canPay(from.actor, evaluated.money, false);
    if (!canPay.success) {
      return {
        success: false,
        error: 'Cannot afford the transfer; nothing was changed',
        refused: [refusal(from.actor, evaluated.money, canPay)],
      };
    }
    const moneyItems = standardCoins(to.actor).length ? [] : await standardMoneyItems();
    if (!standardCoins(to.actor).length && !moneyItems.length) {
      return {
        success: false,
        error: `${to.actor.name} has no coin items and the system's money compendium is unavailable; nothing was changed`,
      };
    }

    const paid = await runPayment(
      P,
      from.actor,
      'pay',
      evaluated.money,
      request,
      description || `→ ${to.actor.name}`
    );
    if (!paid.result.success) {
      return { success: false, error: moneyHtmlToText(paid.result.msg) || 'Payment failed' };
    }
    try {
      const toBefore = purseOf(to.actor);
      const coinsCreated = await ensureCoins(to.actor, moneyItems);
      const received = await runPayment(
        P,
        to.actor,
        'getPaid',
        evaluated.money,
        request,
        description || `← ${from.actor.name}`,
        toBefore
      );
      return {
        success: true,
        action: 'transfer',
        amount: evaluated.money,
        amountText: amountToCoinText(evaluated.money, coinDefsOf(from.actor)),
        ...(evaluated.rolled ? { rolled: true } : {}),
        actors: [
          actorResult(from.actor, paid),
          { ...actorResult(to.actor, received), ...(coinsCreated ? { coinsCreated: true } : {}) },
        ],
      };
    } catch (error) {
      // The payer already paid: give the money back so the transfer does not lose coins.
      await runPayment(
        P,
        from.actor,
        'getPaid',
        evaluated.money,
        { ...request, postToChat: false },
        `↩ ${to.actor.name}`
      );
      return {
        success: false,
        error: `Receiving failed (${error instanceof Error ? error.message : String(error)}); the payment was refunded to ${from.actor.name}`,
      };
    }
  }

  if (request.action !== 'pay' && request.action !== 'receive') {
    return { success: false, error: `Unknown action: ${String(request.action)}` };
  }
  const { actors, error } = resolveTargets(request);
  if (!actors) return { success: false, error };
  if (!actors.length)
    return { success: false, error: `${request.action} needs actors and/or party: true` };

  // Evaluate per actor, like the system's group payment request does for dice formulas
  // (a fixed amount evaluates the same for everyone).
  const planned: Array<{ actor: any; money: number; rolled: boolean }> = [];
  for (const actor of actors) {
    const evaluated = await evaluate(P, input);
    if (!evaluated) {
      return {
        success: false,
        error: `Invalid amount: ${String(input)} (a number or roll formula in Silbertaler, e.g. 12.5 or "2d6")`,
      };
    }
    planned.push({ actor, ...evaluated });
  }

  // Check everyone first so a party payment is all-or-nothing.
  if (request.action === 'pay') {
    const refused: any[] = [];
    for (const p of planned) {
      const canPay = await P.canPay(p.actor, p.money, false);
      if (!canPay.success) refused.push(refusal(p.actor, p.money, canPay));
    }
    if (refused.length) {
      return {
        success: false,
        error: `${refused.map(r => r.name).join(', ')} cannot afford the payment; nothing was changed`,
        refused,
      };
    }
  }
  let moneyItems: any[] = [];
  if (request.action === 'receive' && planned.some(p => !standardCoins(p.actor).length)) {
    moneyItems = await standardMoneyItems();
    if (!moneyItems.length) {
      return {
        success: false,
        error:
          "Some actors have no coin items and the system's money compendium is unavailable; nothing was changed",
      };
    }
  }

  const results: any[] = [];
  for (const p of planned) {
    const before = purseOf(p.actor);
    const coinsCreated =
      request.action === 'receive' ? await ensureCoins(p.actor, moneyItems) : false;
    const mode = request.action === 'pay' ? 'pay' : 'getPaid';
    const run = await runPayment(P, p.actor, mode, p.money, request, description, before);
    results.push({
      ...actorResult(p.actor, run),
      amount: p.money,
      amountText: amountToCoinText(p.money, coinDefsOf(p.actor)),
      ...(p.rolled ? { rolled: true } : {}),
      ...(coinsCreated ? { coinsCreated: true } : {}),
    });
  }
  const failed = results.filter(r => !r.success);
  return {
    success: failed.length === 0,
    action: request.action,
    postedToChat: !!request.postToChat,
    actors: results,
    ...(failed.length ? { error: `Failed for ${failed.map(r => r.name).join(', ')}` } : {}),
  };
}

function refusal(actor: any, money: number, canPay: any): Record<string, unknown> {
  const available = round2(Number(canPay.actorsMoney?.sum) || 0);
  return {
    id: actor.id,
    name: actor.name,
    amount: money,
    available,
    missing: round2(money - available),
    message: moneyHtmlToText(canPay.msg),
  };
}

function actorResult(actor: any, run: Awaited<ReturnType<typeof runPayment>>): Record<string, any> {
  return {
    id: actor.id,
    name: actor.name,
    success: !!run.result.success,
    before: run.before,
    after: run.after,
    coinsChanged: coinChanges(run.before, run.after),
    tracker: run.tracker,
    message: moneyHtmlToText(run.result.msg),
  };
}

// ---------------------------------------------------------------------------------------
// Party
// ---------------------------------------------------------------------------------------

function readGroupSchips(): { current: number; max: number } {
  const [current, max] = String(g().settings.get('dsa5', 'groupschips') || '0/0')
    .split('/')
    .map(x => Number(x) || 0);
  return { current: current ?? 0, max: max ?? 0 };
}

function pool(stat: any): string | undefined {
  if (!stat || !(Number(stat.max) > 0)) return undefined;
  return `${stat.value}/${stat.max}`;
}

function conditionsOf(actor: any): string[] {
  const statuses: string[] = Array.from(actor.statuses ?? []);
  const effects: any[] = (CONFIG as any).statusEffects ?? [];
  return statuses.map(id => {
    const def = effects.find(e => e.id === id);
    const name = def?.name ? g().i18n.localize(def.name) : id;
    const level = Number(actor.system?.condition?.[id]) || 0;
    return level > 0 ? `${name} ${level}` : name;
  });
}

function memberLine(actor: any): Record<string, unknown> {
  const s = actor.system?.status ?? {};
  const fate = s.fatePoints;
  const line: Record<string, unknown> = { id: actor.id, name: actor.name, type: actor.type };
  if (s.wounds) line.LeP = `${s.wounds.value}/${s.wounds.max}`;
  const asp = pool(s.astralenergy);
  if (asp) line.AsP = asp;
  const kap = pool(s.karmaenergy);
  if (kap) line.KaP = kap;
  if (fate) line.schips = `${fate.value}/${fate.max ?? fate.current}`;
  line.money = purseOf(actor).total;
  const conditions = conditionsOf(actor);
  if (conditions.length) line.conditions = conditions;
  return line;
}

function groupSummary(group: any): Record<string, unknown> {
  const system = group.system ?? {};
  return {
    id: group.id,
    name: group.name,
    isPrimaryParty: g().settings.get('dsa5', 'primaryParty') === group.uuid,
    memberCount: system.memberCount ?? 0,
    purse: purseOf(group),
    ...(system.aggregateStats ? { aggregateStats: system.aggregateStats } : {}),
    locations: (system.resolvedLocations ?? []).map((loc: any) => ({
      name: loc.name,
      type: loc.type || undefined,
      locked: !!loc.locked,
      money: purseOf(loc.actor).total,
    })),
  };
}

function resolveGroupActor(identifier: string): { group?: any; error?: string } {
  const { actor, error } = resolveDsa5Actor(identifier);
  if (!actor) return { error: error ?? `Group not found: ${identifier}` };
  if (actor.type !== 'group') return { error: `${actor.name} is not a group actor` };
  return { group: actor };
}

export async function dsa5Party(request: Dsa5PartyRequest): Promise<any> {
  switch (request.action) {
    case 'get':
      return partyGet(request);
    case 'schips':
      return changeSchips(request);
    case 'add-member':
    case 'remove-member':
      return changeMembership(request);
    case 'set-primary':
      return setPrimaryParty(request);
    default:
      return { success: false, error: `Unknown action: ${String((request as any).action)}` };
  }
}

function partyGet(request: Dsa5PartyRequest): any {
  let source: string;
  let group: any = null;
  let actors: any[];
  if (request.group) {
    const resolved = resolveGroupActor(request.group);
    if (!resolved.group) return { success: false, error: resolved.error };
    group = resolved.group;
    actors = Array.from(group.system?.actors ?? []);
    source = 'group';
  } else {
    const party = resolveDsa5Party();
    ({ source, group, actors } = party);
  }
  const members = actors.map(memberLine);
  const tracked: string[] = g().settings.get('dsa5', 'trackedActors')?.actors ?? [];
  const otherGroups = Array.from(g().actors ?? [])
    .filter((a: any) => a.type === 'group' && a.id !== group?.id)
    .map((a: any) => a.name);
  return {
    success: true,
    source,
    sourceNote:
      source === 'primaryParty' || source === 'group'
        ? 'members of the group actor'
        : source === 'gmMenu'
          ? "the GM menu's tracked heroes (no primary party group set)"
          : 'all player-owned actors (no primary party group and no GM menu heroes set)',
    group: group ? groupSummary(group) : null,
    members,
    memberMoneyTotal: round2(actors.reduce((sum, a) => sum + purseOf(a).total, 0)),
    groupSchips: readGroupSchips(),
    gmMenuTracked: tracked.map(id => g().actors?.get?.(id)?.name ?? id),
    ...(otherGroups.length ? { otherGroups } : {}),
  };
}

function nonNegativeInt(value: unknown, name: string): string | undefined {
  if (value === undefined) return undefined;
  return Number.isInteger(value) && (value as number) >= 0
    ? undefined
    : `${name} must be a non-negative whole number`;
}

async function changeSchips(request: Dsa5PartyRequest): Promise<any> {
  const op = request.operation;
  if (!op) return { success: false, error: 'schips needs operation: use, restore or set' };
  for (const [key, value] of [
    ['amount', request.amount],
    ['value', request.value],
    ['max', request.max],
  ] as const) {
    const error = nonNegativeInt(value, key);
    if (error) return { success: false, error };
  }
  const target = request.target ?? 'group';

  if (target.toLowerCase() === 'group') {
    const before = readGroupSchips();
    let { current, max } = before;
    if (op === 'use') {
      const amount = request.amount ?? 1;
      if (current < amount) {
        return {
          success: false,
          error: `Only ${current} group Schicksalspunkte left; cannot use ${amount}`,
          groupSchips: before,
        };
      }
      current -= amount;
    } else if (op === 'restore') {
      current = request.amount === undefined ? max : Math.min(max, current + request.amount);
    } else {
      if (request.value === undefined && request.max === undefined) {
        return { success: false, error: 'set needs value and/or max' };
      }
      // Same rules as the GM menu: the maximum is never negative and the current value is
      // capped at the maximum (masters_menu.js changeGroupSchipCount).
      if (request.max !== undefined) max = request.max;
      if (request.value !== undefined) current = request.value;
      if (request.value !== undefined && current > max) {
        return {
          success: false,
          error: `value ${current} is above the maximum ${max}; raise max as well`,
          groupSchips: before,
        };
      }
      current = Math.min(current, max);
    }
    await g().settings.set('dsa5', 'groupschips', `${current}/${max}`);
    return { success: true, target: 'group', before, after: readGroupSchips() };
  }

  const { actor, error } = resolveDsa5Actor(target);
  if (!actor) return { success: false, error };
  const fate = actor.system?.status?.fatePoints;
  if (!fate) return { success: false, error: `${actor.name} has no Schicksalspunkte` };
  if (request.max !== undefined) {
    return {
      success: false,
      error:
        "A hero's Schicksalspunkte maximum comes from the character sheet; only the current value can be changed here",
    };
  }
  const max = Number(fate.max ?? fate.current) || 0;
  const value = Number(fate.value) || 0;
  let next = value;
  if (op === 'use') {
    const amount = request.amount ?? 1;
    if (value < amount) {
      return {
        success: false,
        error: `${actor.name} has only ${value} Schicksalspunkte left; cannot use ${amount}`,
      };
    }
    next = value - amount;
  } else if (op === 'restore') {
    next = request.amount === undefined ? max : Math.min(max, value + request.amount);
  } else {
    if (request.value === undefined) return { success: false, error: 'set needs value' };
    if (request.value > max) {
      return {
        success: false,
        error: `value ${request.value} is above ${actor.name}'s maximum ${max}`,
      };
    }
    next = request.value;
  }
  // The same field the sheet and GM menu pips write (actor.setSchipFromPip).
  await actor.update({ 'system.status.fatePoints.value': next });
  return {
    success: true,
    target: actor.name,
    before: { current: value, max },
    after: { current: Number(actor.system.status.fatePoints.value) || 0, max },
  };
}

async function changeMembership(request: Dsa5PartyRequest): Promise<any> {
  if (!request.actor) return { success: false, error: `${request.action} needs actor` };
  const { actor, error } = resolveDsa5Actor(request.actor);
  if (!actor) return { success: false, error };
  const adding = request.action === 'add-member';
  const list = request.list ?? 'auto';

  let group: any = null;
  if (request.group) {
    const resolved = resolveGroupActor(request.group);
    if (!resolved.group) return { success: false, error: resolved.error };
    group = resolved.group;
  } else if (list !== 'gmMenu') {
    const partyUuid = g().settings.get('dsa5', 'primaryParty');
    group = partyUuid ? ((globalThis as any).fromUuidSync?.(partyUuid) ?? null) : null;
    if (!group && list === 'group') {
      return {
        success: false,
        error: 'No primary party group actor is set; pass group or use list "gmMenu"',
      };
    }
  }

  if (group && list !== 'gmMenu') {
    if (actor.type === 'group')
      return { success: false, error: 'A group cannot be a member of a group' };
    const members: Record<string, any> = group.system?.members ?? {};
    const key = Object.keys(members).find(k => members[k]?.uuid === actor.uuid);
    if (adding && key)
      return {
        success: true,
        changed: false,
        list: 'group',
        group: group.name,
        note: `${actor.name} is already a member`,
      };
    if (!adding && !key)
      return { success: false, error: `${actor.name} is not a member of ${group.name}` };
    // The group actor's own API (GroupData.addMember / removeMember), as the sheet uses.
    if (adding) await group.system.addMember(actor);
    else await group.system.removeMember(key);
    return {
      success: true,
      changed: true,
      list: 'group',
      group: group.name,
      members: Array.from(group.system?.actors ?? []).map((a: any) => a.name),
    };
  }

  const menu = g().dsa5?.apps?.gameMasterMenu;
  const all: any[] = Array.from(g().actors ?? []);
  let tracked: string[] = [...(g().settings.get('dsa5', 'trackedActors')?.actors ?? [])];
  // An empty list means "all player-owned actors" to the system; the GM menu writes that
  // default into the setting when it first renders (getTrackedHeros), so do the same before
  // editing it.
  if (!tracked.length) tracked = all.filter(a => a.hasPlayerOwner).map(a => a.id);
  const has = tracked.includes(actor.id);
  if (adding && has)
    return {
      success: true,
      changed: false,
      list: 'gmMenu',
      note: `${actor.name} is already tracked`,
    };
  if (!adding && !has)
    return { success: false, error: `${actor.name} is not in the GM menu's hero list` };
  tracked = adding ? [...tracked, actor.id] : tracked.filter(id => id !== actor.id);
  if (menu?.setTrackedHeros) await menu.setTrackedHeros(tracked);
  else
    await g().settings.set('dsa5', 'trackedActors', {
      actors: tracked.filter(id => g().actors.has(id)),
    });
  if (menu?.rendered) menu.render(true);
  const after: string[] = g().settings.get('dsa5', 'trackedActors')?.actors ?? [];
  return {
    success: true,
    changed: true,
    list: 'gmMenu',
    members: after.map(id => g().actors?.get?.(id)?.name ?? id),
    ...(after.length
      ? {}
      : { note: 'The list is now empty, so the system falls back to all player-owned actors' }),
  };
}

/** Make a group actor the primary party, as the group sheet's "primary party" toggle does. */
async function setPrimaryParty(request: Dsa5PartyRequest): Promise<any> {
  if (!request.group) return { success: false, error: 'set-primary needs group' };
  const resolved = resolveGroupActor(request.group);
  if (!resolved.group) return { success: false, error: resolved.error };
  const before = g().settings.get('dsa5', 'primaryParty');
  const previous = before ? ((globalThis as any).fromUuidSync?.(before)?.name ?? before) : null;
  await g().settings.set('dsa5', 'primaryParty', resolved.group.uuid);
  return { success: true, primaryParty: resolved.group.name, previous };
}
