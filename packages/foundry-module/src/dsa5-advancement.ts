/**
 * DSA5 advancement: raising and lowering values with Abenteuerpunkte (AP), cost previews,
 * and AP awards.
 *
 * The DSA5 system implements advancement on its sheet classes (the "+"/"-" buttons). Those
 * methods do not need a rendered sheet: `item.sheet` / `actor.sheet` return an unrendered
 * instance whose `_advanceStep()`, `_advanceAttribute()` etc. run the same cost lookup,
 * maximum check, AP bookkeeping (`Actordsa5._updateAPs`) and AP tracker entry
 * (`APTracker.track`) as a click. This file calls those methods step by step, so the result
 * is identical to clicking "+" on the sheet, and only adds what a headless caller needs:
 * a cost plan up front, a pre-check of free AP (the system's `checkEnoughXP` opens a dialog
 * when a hero has 0 AP total, which would block the GM client), and a report.
 */

/** Item types the system advances through `AdvancableSkill` sheets (talentValue + StF). */
export const DSA5_ADVANCEABLE_ITEM_TYPES = [
  'skill',
  'combatskill',
  'spell',
  'liturgy',
  'ritual',
  'ceremony',
] as const;

export const DSA5_ATTRIBUTE_KEYS = ['mu', 'kl', 'in', 'ch', 'ff', 'ge', 'ko', 'kk'] as const;

/** Bought points (LeP/AsP/KaP) live in system.status.<key>.advances. */
const POINT_ALIASES: Record<string, string[]> = {
  wounds: ['wounds', 'lep', 'lp', 'le', 'life', 'lifepoints', 'life points', 'lebenspunkte'],
  astralenergy: ['astralenergy', 'asp', 'ae', 'arcane energy', 'astralpunkte'],
  karmaenergy: ['karmaenergy', 'kap', 'kp', 'ke', 'karma', 'karma points', 'karmapunkte'],
};

export type Dsa5AdvanceAction = 'raise' | 'lower' | 'preview';

export interface Dsa5AdvanceRequest {
  action: Dsa5AdvanceAction;
  target: string;
  steps?: number;
  toValue?: number;
  free?: boolean;
  ignoreMaximum?: boolean;
}

export interface Dsa5AwardRequest {
  amount: number;
  reason?: string;
  postToChat?: boolean;
}

interface Maximum {
  value: number | null;
  reason: string;
}

/** One advanceable value on an actor, with the system calls that change it. */
interface AdvanceTrack {
  kind: 'item' | 'attribute' | 'points';
  name: string;
  details: Record<string, unknown>;
  value(): number;
  floor(): number;
  maximum(): Maximum;
  /** AP for raising from `value` to `value + 1`, from the system's cost table. */
  costUp(value: number): number | undefined;
  /** AP refunded for lowering from `value` to `value - 1`. */
  costDown(value: number): number | undefined;
  systemUp(): Promise<unknown>;
  systemDown(): Promise<unknown>;
  writeFree(next: number): Promise<void>;
  trackerDescription(previous: number, next: number): Record<string, unknown>;
}

interface PlannedStep {
  from: number;
  to: number;
  cost: number;
}

function dsa5(): any {
  return (game as any).dsa5;
}

function loc(key: string): string {
  return (game as any).i18n?.localize?.(key) ?? key;
}

function norm(text: string): string {
  return String(text ?? '')
    .trim()
    .toLowerCase();
}

/** The system's own cost lookup: DSA5.advancementCosts[category][value + modifier]. */
function advCost(value: number, category: string, modifier = 1): number | undefined {
  const utility = dsa5()?.apps?.DSA5_Utility;
  const cost = utility
    ? utility._calculateAdvCost(value, category, modifier)
    : dsa5()?.config?.advancementCosts?.[category]?.[Number(value) + modifier];
  return typeof cost === 'number' && !isNaN(cost) ? cost : undefined;
}

function experience(actor: any): { total: number; spent: number; free: number } {
  const exp = actor.system?.details?.experience ?? {};
  const total = Number(exp.total) || 0;
  const spent = Number(exp.spent) || 0;
  return { total, spent, free: total - spent };
}

/** Familiars and pets advance on cost column C (see the system's sheet methods). */
function isCompanion(actor: any): boolean {
  return Boolean(actor.system?.isPet || actor.system?.isFamiliar);
}

/**
 * The system tracks AP only when the world setting is on and the actor has a player owner
 * (JournalTracker.track); report which, so a missing journal entry is not a surprise.
 */
export function apTrackerStatus(actor: any): Record<string, unknown> {
  let enabled = false;
  try {
    enabled = Boolean((game as any).settings.get('dsa5', 'enableAPTracking'));
  } catch {
    enabled = false;
  }
  if (!enabled) {
    return { recorded: false, note: 'AP tracking is disabled in the DSA5 system settings' };
  }
  if (!actor.hasPlayerOwner) {
    return {
      recorded: false,
      note: 'the DSA5 AP tracker only records actors that have a player owner',
    };
  }
  const journal = (game as any).journal?.find((j: any) => j.flags?.dsa5?.apTrackerId === actor.id);
  return { recorded: true, ...(journal ? { journal: journal.name, journalId: journal.id } : {}) };
}

function itemTrack(actor: any, item: any): AdvanceTrack {
  const type = item.type as string;
  return {
    kind: 'item',
    name: item.name,
    details: {
      id: item.id,
      itemType: type,
      steigerungsfaktor: item.system?.StF?.value,
      costColumn: item.system?.advanceCategory,
    },
    value: () => Number(item.system.talentValue.value) || 0,
    floor: () => Number(item.system.advanceMin || 0),
    maximum: () => {
      // _checkMaximumItemAdvancement(newValue) computes the limit from the sheet's own
      // _maxAllowedAdvancement plus the Begabung/exceptional-skill bonus. Asking for 0 always
      // passes, so it returns {max, maxBonus} without the "maximum reached" notification.
      const check = item.sheet?._checkMaximumItemAdvancement?.(0);
      const max = typeof check?.max === 'number' ? check.max : null;
      const bonus = Number(check?.maxBonus) || 0;
      return { value: max, reason: describeItemMaximum(actor, item, max, bonus) };
    },
    costUp: v => advCost(v, item.system.advanceCategory),
    costDown: v => advCost(v, item.system.advanceCategory, 0),
    systemUp: () => item.sheet._advanceStep(),
    systemDown: () => item.sheet._refundStep(),
    writeFree: async next => {
      await item.update({ 'system.talentValue.value': next });
    },
    trackerDescription: (previous, next) => ({ type: 'item', item, previous, next }),
  };
}

function attributeLabel(actor: any, keys: string[]): string {
  return keys
    .map(k => {
      const value = actor.system?.characteristics?.[k]?.value;
      return `${loc(`CHARAbbrev.${k.toUpperCase()}`)} ${value}`;
    })
    .join(', ');
}

function describeItemMaximum(actor: any, item: any, max: number | null, bonus: number): string {
  const bonusText = bonus ? ` + ${bonus} from an exceptional-skill advantage` : '';
  switch (item.type) {
    case 'skill': {
      const keys = [1, 2, 3].map(n => item.system?.[`characteristic${n}`]?.value).filter(Boolean);
      return `highest of the skill's attributes (${attributeLabel(actor, keys)}) + 2${bonusText}`;
    }
    case 'combatskill': {
      const keys = String(item.system?.guidevalue?.value ?? '')
        .split('/')
        .filter(Boolean);
      return `highest primary attribute (${attributeLabel(actor, keys)}) + 2${bonusText}`;
    }
    default: {
      // Spells/rituals and liturgies/ceremonies: 14 (+ bonus), or the attribute rule when a
      // matching Merkmalskenntnis / Aspektkenntnis lifts it higher.
      const knowledge = ['spell', 'ritual'].includes(item.type)
        ? 'a matching property knowledge (Merkmalskenntnis)'
        : 'a matching aspect knowledge (Aspektkenntnis)';
      if (max !== null && max > 14 + bonus) {
        return `highest of its attributes + 2${bonusText}, because of ${knowledge}`;
      }
      return `14${bonusText}; ${knowledge} would allow highest attribute + 2`;
    }
  }
}

function attributeTrack(actor: any, key: string): AdvanceTrack {
  const characteristic = () => actor.system.characteristics[key];
  const category = () => (isCompanion(actor) ? 'C' : 'E');
  return {
    kind: 'attribute',
    name: loc(`CHAR.${key.toUpperCase()}`),
    details: { key, costColumn: category() },
    // The sheet raises `advances` and prices it by initial + advances (species and
    // temporary modifiers are not part of the price), so that is the value used here.
    value: () => Number(characteristic().initial) + Number(characteristic().advances),
    floor: () => Number(characteristic().initial),
    maximum: () => ({
      value: null,
      reason: 'the DSA5 system enforces no maximum when raising attributes',
    }),
    costUp: v => advCost(v, category()),
    costDown: v => advCost(v, category(), 0),
    systemUp: () => actor.sheet._advanceAttribute(key),
    systemDown: () => actor.sheet._refundAttributeAdvance(key),
    writeFree: async next => {
      await actor.update({
        [`system.characteristics.${key}.advances`]: next - Number(characteristic().initial),
      });
    },
    trackerDescription: (previous, next) => ({ type: 'attribute', attr: key, previous, next }),
  };
}

function pointsTrack(actor: any, key: string): AdvanceTrack {
  const category = () => (isCompanion(actor) ? 'C' : 'D');
  const reasons: Record<string, string> = {
    wounds: 'bought life points are limited to the KO value',
    astralenergy:
      'bought astral points are limited to the leading spellcasting attribute x energy factor (0 for non-spellcasters)',
    karmaenergy:
      'bought karma points are limited to the leading clerical attribute x energy factor (0 for non-clerics)',
  };
  return {
    kind: 'points',
    name: loc(key),
    details: { key, costColumn: category() },
    value: () => Number(actor.system.status[key].advances) || 0,
    floor: () => 0,
    maximum: () => ({
      value: Number(actor.system.pointAdvancementLimit(key)) || 0,
      reason: reasons[key],
    }),
    costUp: v => advCost(v, category()),
    costDown: v => advCost(v, category(), 0),
    systemUp: () => actor.sheet._advancePoints(key),
    systemDown: () => actor.sheet._refundPointsAdvance(key),
    writeFree: async next => {
      await actor.update({ [`system.status.${key}.advances`]: next });
    },
    trackerDescription: (previous, next) => ({ type: 'point', attr: key, previous, next }),
  };
}

/**
 * Resolve a target on the actor: item id, attribute (key, localized name or abbreviation),
 * bought points (LeP/AsP/KaP), then item name (exact, case-insensitive) among the
 * advanceable item types.
 */
export function resolveAdvanceTarget(
  actor: any,
  target: string
): { track: AdvanceTrack } | { error: string } {
  const wanted = norm(target);
  if (!wanted) return { error: 'target is required' };
  const items: any[] = Array.from(actor.items ?? []);
  const advanceable = (item: any) =>
    (DSA5_ADVANCEABLE_ITEM_TYPES as readonly string[]).includes(item.type);

  const byId = items.find(i => i.id === target);
  if (byId) {
    if (!advanceable(byId)) {
      return {
        error: `"${byId.name}" is a ${byId.type}; only ${DSA5_ADVANCEABLE_ITEM_TYPES.join(', ')} items can be raised with this tool`,
      };
    }
    return { track: itemTrack(actor, byId) };
  }

  for (const key of DSA5_ATTRIBUTE_KEYS) {
    const names = [key, loc(`CHAR.${key.toUpperCase()}`), loc(`CHARAbbrev.${key.toUpperCase()}`)];
    if (names.some(n => norm(n) === wanted)) return { track: attributeTrack(actor, key) };
  }

  for (const [key, aliases] of Object.entries(POINT_ALIASES)) {
    if ([...aliases, loc(key)].some(n => norm(n) === wanted)) {
      return { track: pointsTrack(actor, key) };
    }
  }

  const matches = items.filter(i => norm(i.name) === wanted);
  const usable = matches.filter(advanceable);
  if (usable.length === 1) return { track: itemTrack(actor, usable[0]) };
  if (usable.length > 1) {
    return {
      error: `"${target}" matches several items on ${actor.name}: ${usable
        .map(i => `${i.name} (${i.type}, id ${i.id})`)
        .join(', ')}. Use the item id.`,
    };
  }
  if (matches.length > 0) {
    return {
      error: `"${matches[0].name}" is a ${matches[0].type}; only ${DSA5_ADVANCEABLE_ITEM_TYPES.join(', ')} items, attributes and bought LeP/AsP/KaP can be raised with this tool`,
    };
  }

  const similar = items
    .filter(i => advanceable(i) && norm(i.name).includes(wanted))
    .slice(0, 10)
    .map(i => i.name);
  return {
    error:
      `No advanceable value "${target}" on ${actor.name}. Use an item name or id ` +
      `(skill, combat technique, spell, liturgy, ritual, ceremony), an attribute ` +
      `(${DSA5_ATTRIBUTE_KEYS.join(', ')} or its localized name) or LeP/AsP/KaP.${
        similar.length ? ` Similar items: ${similar.join(', ')}.` : ''
      }`,
  };
}

/** Simulate the steps from the current value towards `target` with the system's costs. */
function planSteps(
  track: AdvanceTrack,
  current: number,
  target: number,
  freeAP: number,
  free: boolean,
  ignoreMaximum: boolean
): { steps: PlannedStep[]; blocked?: { reason: string; message: string } } {
  const steps: PlannedStep[] = [];
  let remaining = freeAP;

  if (target > current) {
    const max = track.maximum();
    for (let v = current; v < target; v++) {
      const next = v + 1;
      if (max.value !== null && next > max.value && !ignoreMaximum) {
        return {
          steps,
          blocked: {
            reason: 'maximum',
            message: `${track.name} cannot go above ${max.value}: ${max.reason}`,
          },
        };
      }
      const cost = track.costUp(v);
      if (!free) {
        if (cost === undefined) {
          return {
            steps,
            blocked: {
              reason: 'costTable',
              message: `The DSA5 cost table has no price for raising ${track.name} from ${v}`,
            },
          };
        }
        if (cost > remaining) {
          return {
            steps,
            blocked: {
              reason: 'insufficientAP',
              message: `Not enough AP to raise ${track.name} from ${v} to ${next}: costs ${cost}, ${remaining} free`,
            },
          };
        }
        remaining -= cost;
      }
      steps.push({ from: v, to: next, cost: free ? 0 : (cost as number) });
    }
  } else {
    const floor = track.floor();
    for (let v = current; v > target; v--) {
      const next = v - 1;
      if (next < floor) {
        return {
          steps,
          blocked: {
            reason: 'minimum',
            message: `${track.name} cannot be lowered below ${floor} with this tool`,
          },
        };
      }
      const refund = free ? 0 : (track.costDown(v) ?? 0);
      steps.push({ from: v, to: next, cost: -refund });
    }
  }
  return { steps };
}

/**
 * Raise, lower or preview one value on a DSA5 actor. The caller has resolved the actor and
 * checked the write permission (not needed for preview).
 */
export async function dsa5Advance(actor: any, request: Dsa5AdvanceRequest): Promise<any> {
  const { action } = request;
  const free = Boolean(request.free);
  const ignoreMaximum = Boolean(request.ignoreMaximum);

  // Mirrors the system: only characters, familiars and pets have an AP economy
  // (baseactor `canAdvance`); the sheets of npcs and creatures show no advance buttons.
  if (!actor.canAdvance && !actor.system?.canAdvance) {
    return {
      success: false,
      error: `${actor.name} (${actor.type}) has no Abenteuerpunkte economy in DSA5: only characters, familiars and pets advance with AP. Edit an npc's or creature's values directly with manage-actors instead.`,
    };
  }
  if (ignoreMaximum && !free) {
    return {
      success: false,
      error:
        "ignoreMaximum requires free: true. A paid raise runs the system's own advancement, which always enforces the maximum.",
    };
  }
  if (request.steps !== undefined && request.toValue !== undefined) {
    return { success: false, error: 'Provide either steps or toValue, not both' };
  }

  const resolved = resolveAdvanceTarget(actor, request.target);
  if ('error' in resolved) return { success: false, error: resolved.error };
  const track = resolved.track;

  const current = track.value();
  const steps = request.steps ?? 1;
  let target: number;
  if (request.toValue !== undefined) target = request.toValue;
  else target = action === 'lower' ? current - steps : current + steps;

  if (action === 'raise' && target < current) {
    return {
      success: false,
      error: `${track.name} is ${current}; toValue ${target} would lower it (use action "lower")`,
    };
  }
  if (action === 'lower' && target > current) {
    return {
      success: false,
      error: `${track.name} is ${current}; toValue ${target} would raise it (use action "raise")`,
    };
  }

  const before = experience(actor);
  const maximum = track.maximum();
  const plan = planSteps(track, current, target, before.free, free, ignoreMaximum);
  const plannedCost = plan.steps.reduce((sum, s) => sum + s.cost, 0);
  const base = {
    action,
    actor: { id: actor.id, name: actor.name, type: actor.type },
    target: { kind: track.kind, name: track.name, ...track.details },
    free,
    currentValue: current,
    requestedValue: target,
    maximum: maximum.value,
    maximumReason: maximum.reason,
    minimum: track.floor(),
  };

  if (action === 'preview') {
    return {
      success: true,
      ...base,
      steps: plan.steps,
      reachableValue: plan.steps.length ? plan.steps[plan.steps.length - 1].to : current,
      totalCost: plannedCost,
      canAfford: !plan.blocked,
      ...(plan.blocked
        ? { blockedReason: plan.blocked.reason, blockedMessage: plan.blocked.message }
        : {}),
      ap: {
        before,
        afterIfApplied: {
          ...before,
          spent: before.spent + plannedCost,
          free: before.free - plannedCost,
        },
      },
    };
  }

  if (target === current) {
    return {
      success: true,
      ...base,
      newValue: current,
      steps: [],
      totalCost: 0,
      ap: { before, after: before },
      note: 'Nothing to do: the value is already at the requested level',
    };
  }
  if (plan.steps.length === 0) {
    return {
      success: false,
      ...base,
      error: plan.blocked?.message ?? 'Nothing could be changed',
      blockedReason: plan.blocked?.reason,
      ap: before,
    };
  }

  const done: PlannedStep[] = [];
  let stopped: { reason: string; message: string } | undefined = plan.blocked;
  for (const step of plan.steps) {
    const spentBefore = experience(actor).spent;
    if (free) {
      await track.writeFree(step.to);
      // A GM ruling still belongs in the AP history; cost 0 marks it as granted.
      await dsa5()?.apps?.APTracker?.track?.(
        actor,
        track.trackerDescription(step.from, step.to),
        0
      );
    } else if (step.to > step.from) {
      await track.systemUp();
    } else {
      await track.systemDown();
    }
    const now = track.value();
    if (now !== step.to) {
      stopped = {
        reason: 'systemRefused',
        message: `The DSA5 system did not change ${track.name} from ${step.from} to ${step.to}`,
      };
      break;
    }
    done.push({ from: step.from, to: step.to, cost: experience(actor).spent - spentBefore });
  }

  const after = experience(actor);
  const totalCost = after.spent - before.spent;
  const newValue = track.value();
  return {
    success: true,
    ...base,
    oldValue: current,
    newValue,
    ...(track.kind === 'attribute'
      ? { effectiveValue: actor.system.characteristics[track.details.key as string]?.value }
      : {}),
    steps: done,
    totalCost,
    completed: newValue === target,
    ...(newValue !== target && stopped
      ? {
          stoppedReason: stopped.reason,
          stoppedMessage: `Stopped at ${newValue}: ${stopped.message}`,
        }
      : {}),
    ap: { before, after },
    apTracker: apTrackerStatus(actor),
  };
}

/**
 * The actors the system's GM menu offers for an AP award by default: the primary party
 * group if one is set, else the GM menu's tracked actors, else all player-owned actors
 * (ActorPickerDialog #getTrackedActors).
 */
export function dsa5PartyActors(): any[] {
  const g = game as any;
  const partyUuid = g.settings.get('dsa5', 'primaryParty');
  if (partyUuid) {
    const party = (globalThis as any).fromUuidSync?.(partyUuid);
    if (party?.system?.actors?.size) return Array.from(party.system.actors);
  }
  const tracked = g.settings.get('dsa5', 'trackedActors');
  if (tracked?.actors?.length) {
    return Array.from(g.actors).filter((a: any) => tracked.actors.includes(a.id));
  }
  return Array.from(g.actors).filter((a: any) => a.hasPlayerOwner);
}

/**
 * Award AP the way the system's GM menu does (masters_menu.js getExp): familiars get 25 %
 * and pets 10 % of the amount (at least 1), everyone else the full amount, written as an
 * update of experience.total. The actor's _preUpdate writes the AP tracker entry, and a
 * chat message like the GM menu's is posted unless disabled.
 */
export async function dsa5AwardAP(actors: any[], request: Dsa5AwardRequest): Promise<any> {
  const amount = request.amount;
  const familiarAP = Math.max(1, Math.round(amount * 0.25));
  const petAP = Math.max(1, Math.round(amount * 0.1));
  const awarded: any[] = [];
  const skipped: any[] = [];
  const groups: { heroes: any[]; familiars: any[]; pets: any[] } = {
    heroes: [],
    familiars: [],
    pets: [],
  };

  for (const actor of actors) {
    if (!actor.canAdvance && !actor.system?.canAdvance) {
      skipped.push({
        id: actor.id,
        name: actor.name,
        type: actor.type,
        reason: 'no AP economy (only characters, familiars and pets advance with AP)',
      });
      continue;
    }
    let share = amount;
    let role = 'hero';
    if (actor.system?.isFamiliar) {
      share = familiarAP;
      role = 'familiar';
      groups.familiars.push(actor);
    } else if (actor.system?.isPet) {
      share = petAP;
      role = 'pet';
      groups.pets.push(actor);
    } else {
      groups.heroes.push(actor);
    }
    const before = experience(actor);
    await actor.update({ 'system.details.experience.total': before.total + share });
    const after = experience(actor);
    awarded.push({
      id: actor.id,
      name: actor.name,
      role,
      received: share,
      total: { before: before.total, after: after.total },
      free: after.free,
      apTracker: apTrackerStatus(actor),
    });
  }

  let chatMessageId: string | undefined;
  if (request.postToChat !== false && awarded.length > 0) {
    const i18n = (game as any).i18n;
    const line = (list: any[], number: number) =>
      i18n.format('MASTER.xpMessage', {
        heros: list.map(a => escapeText(a.name)).join(', '),
        number,
      });
    const parts: string[] = [];
    if (groups.heroes.length) parts.push(line(groups.heroes, amount));
    if (groups.familiars.length) parts.push(line(groups.familiars, familiarAP));
    if (groups.pets.length) parts.push(line(groups.pets, petAP));
    if (request.reason) parts.push(escapeText(request.reason));
    const html = `<p>${parts.join('</p><p>')}</p>`;
    const utility = dsa5()?.apps?.DSA5_Utility;
    const chatData = utility?.chatDataSetup ? utility.chatDataSetup(html) : { content: html };
    const message = await (globalThis as any).ChatMessage.create(chatData);
    chatMessageId = message?.id;
  }

  return {
    success: awarded.length > 0,
    amount,
    shares: { hero: amount, familiar: familiarAP, pet: petAP },
    awarded,
    ...(skipped.length ? { skipped } : {}),
    ...(request.reason ? { reason: request.reason } : {}),
    ...(chatMessageId ? { chatMessageId } : {}),
    ...(awarded.length === 0 ? { error: 'No actor could receive AP' } : {}),
  };
}

function escapeText(text: string): string {
  return String(text).replace(
    /[&<>"']/g,
    c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#x27;' })[c] as string
  );
}
