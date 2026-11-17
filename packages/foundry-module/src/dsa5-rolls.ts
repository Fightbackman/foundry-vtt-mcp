/**
 * DSA5 (Das Schwarze Auge 5) rolls and item use.
 *
 * DSA5 has no d20 + modifier checks: a skill check (Talentprobe) is 3d20 against three
 * attributes with a pool of skill points, an attribute check is 1d20 roll-under, combat
 * rolls are 1d20 against AT/PA/dodge, and every test runs through the system's own
 * setup*() / basicTest() pipeline, which also posts the chat card, starts opposed tests
 * against targeted tokens and consumes ammunition. Everything here calls that pipeline
 * instead of re-implementing the rules, so results match what a player gets from the
 * character sheet.
 *
 * The system's setup*() methods open a modifier dialog unless `options.bypass` is set.
 * With bypass the system returns the prepared test data straight away; the helpers below
 * add what the dialog would have added with its default inputs (see applyDialogDefaults).
 */

import { summarizeDsa5Opposed, type Dsa5OpposedEntry } from './dsa5-opposed.js';

type AnyRecord = Record<string, any>;

export type Dsa5CheckType = 'skill' | 'attribute' | 'attack' | 'parry' | 'dodge' | 'spell';

export const DSA5_CHECK_TYPES: readonly Dsa5CheckType[] = [
  'skill',
  'attribute',
  'attack',
  'parry',
  'dodge',
  'spell',
];

export const DSA5_MESSAGE_MODES = ['public', 'gm', 'blind', 'self'] as const;
export type Dsa5MessageMode = (typeof DSA5_MESSAGE_MODES)[number];

const SPELL_TYPES = ['spell', 'liturgy', 'ritual', 'ceremony'];
const CLERICAL_TYPES = ['liturgy', 'ceremony'];
const ATTACK_ITEM_TYPES = ['meleeweapon', 'rangeweapon', 'combatskill', 'trait'];
const ATTACK_TRAIT_TYPES = ['meleeAttack', 'rangeAttack'];
const WEAPONLESS_NAMES = ['weaponless', 'unarmed', 'brawl', 'brawling'];

export interface Dsa5RollSummary {
  rollType?: string;
  outcome: 'critical' | 'success' | 'failure' | 'botch';
  successLevel: number;
  description: string;
  dice: Array<{ check: string; roll: number; target?: number; success?: boolean }>;
  modifiers?: number;
  qualityStep?: number;
  remainingSkillPoints?: number;
  damage?: number;
  damageFormula?: string;
  damageDescription?: string;
  cost?: { amount: number; resource: 'AsP' | 'KaP'; paid: false; note: string };
  messageId?: string;
  opposed?: Dsa5OpposedEntry[];
}

export interface Dsa5RollOutcome {
  success: boolean;
  error?: string;
  actorName?: string;
  check?: Dsa5CheckType;
  name?: string;
  roll?: Dsa5RollSummary;
}

function localize(key: string): string {
  return (game as any).i18n?.localize?.(key) ?? key;
}

function stripHtml(text: unknown): string {
  return String(text ?? '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalize(text: unknown): string {
  return String(text ?? '')
    .trim()
    .toLowerCase();
}

/**
 * Token id the system uses for the chat speaker and for opposed tests. Mirrors what the
 * system's own automation (zone attacks) passes: the token of a synthetic actor, or the
 * first active token of a world actor on the viewed scene.
 */
export function speakerTokenId(actor: any): string | undefined {
  if (actor?.isToken && actor.token?.id) return actor.token.id;
  const tokens = typeof actor?.getActiveTokens === 'function' ? actor.getActiveTokens() : [];
  return tokens?.[0]?.id ?? undefined;
}

/**
 * Parse a request modifier. DSA5 modifiers are whole numbers where a positive value makes
 * the check easier (Erleichterung) and a negative one harder (Erschwernis).
 */
export function parseDsa5Modifier(value: unknown): number | null {
  if (value === undefined || value === null || value === '') return 0;
  if (typeof value === 'number') return Number.isInteger(value) ? value : null;
  const text = String(value).replace(/\s+/g, '');
  if (text === '') return 0;
  if (!/^[+-]?\d+$/.test(text)) return null;
  return Number(text);
}

/** Resolve MU/KL/... (key, localized abbreviation or localized name) to the system key. */
export function resolveDsa5Characteristic(input: string): string | null {
  const characteristics: AnyRecord = (game as any).dsa5?.config?.characteristics ?? {};
  const wanted = normalize(input);
  for (const [key, labelKey] of Object.entries(characteristics)) {
    const candidates = [
      key,
      localize(`CHARAbbrev.${key.toUpperCase()}`),
      localize(String(labelKey)),
    ].map(normalize);
    if (candidates.includes(wanted)) return key;
  }
  return null;
}

function characteristicHelp(): string {
  const characteristics: AnyRecord = (game as any).dsa5?.config?.characteristics ?? {};
  return Object.entries(characteristics)
    .map(
      ([key, labelKey]) =>
        `${key.toUpperCase()} (${localize(`CHARAbbrev.${key.toUpperCase()}`)}, ${localize(String(labelKey))})`
    )
    .join(', ');
}

function findItem(actor: any, identifier: string, types: string[]): any {
  const items: any[] = Array.from(actor?.items ?? []).filter((i: any) => types.includes(i.type));
  const wanted = normalize(identifier);
  return (
    items.find(i => i.id === identifier) ??
    items.find(i => normalize(i.name) === wanted) ??
    (() => {
      const partial = items.filter(i => normalize(i.name).includes(wanted));
      return partial.length === 1 ? partial[0] : undefined;
    })()
  );
}

function itemNames(actor: any, types: string[], limit = 25): string {
  const names = Array.from(actor?.items ?? [])
    .filter((i: any) => types.includes(i.type))
    .map((i: any) => i.name);
  if (names.length === 0) return 'none';
  return names.length > limit
    ? `${names.slice(0, limit).join(', ')}, … (${names.length} total)`
    : names.join(', ');
}

/**
 * Make bypassed setup data match a dialog confirmed with its default inputs. With bypass the
 * system copies every situational modifier it offered (including ones the dialog shows
 * switched off) and skips the dialog's own form handling, so:
 * - drop modifiers the dialog would show deselected,
 * - turn damage modifiers into damage bonuses the way the dialog's widget does,
 * - add the "manual" modifier field, which is where a requested modifier belongs.
 */
export function applyDialogDefaults(setup: AnyRecord, modifier: number): void {
  const testData = setup.testData;
  const modifiers: AnyRecord[] = Array.isArray(testData.situationalModifiers)
    ? testData.situationalModifiers
    : [];
  testData.situationalModifiers = modifiers
    .filter(m => m && m.selected !== false)
    .map(m => (m.type === 'dmg' ? { ...m, damageBonus: m.value, value: 0 } : m));
  testData.situationalModifiers.push({ name: localize('manual'), value: modifier, type: '' });

  // The spell dialog reads cost, casting time, range and maintenance cost from its form, and
  // the chat card's cost comes from there. Bypass leaves them at 0, which the card shows as
  // a cost of 1, so seed them with the spell's own values (what the dialog shows unchanged).
  const source = testData.source;
  const calc = testData.calculatedSpellModifiers;
  if (calc && SPELL_TYPES.includes(source?.type) && !Number(calc.cost)) {
    const sys = source.system ?? {};
    testData.calculatedSpellModifiers = {
      ...calc,
      cost: String(sys.AsPCost?.value ?? 0),
      castingTime: String(sys.castingTime?.value ?? 0),
      reach: String(sys.range?.value ?? ''),
      maintainCost: String(sys.maintainCost?.value ?? ''),
    };
  }
}

/**
 * 3d20 checks report a double 1 / double 20 as +-2 and a triple as +-3. 1d20 checks report a
 * confirmed critical or botch as +-3 and an unconfirmed one as +-2, which by the rules is an
 * ordinary success or failure.
 */
function outcomeFor(successLevel: number, threeD20: boolean): Dsa5RollSummary['outcome'] {
  const threshold = threeD20 ? 2 : 3;
  if (successLevel >= threshold) return 'critical';
  if (successLevel > 0) return 'success';
  if (successLevel <= -threshold) return 'botch';
  return 'failure';
}

/** Turn the system's test result into a compact, JSON-safe summary. */
export function summarizeDsa5Result(result: AnyRecord, sourceType?: string): Dsa5RollSummary {
  const successLevel = Number(result?.successLevel ?? 0);
  // Only 3d20 checks (skills, spells, liturgies) produce a quality level.
  const threeD20 = result?.qualityStep !== undefined;
  const summary: Dsa5RollSummary = {
    outcome: outcomeFor(successLevel, threeD20),
    successLevel,
    description: stripHtml(result?.description),
    dice: [],
  };
  if (result?.rollType) summary.rollType = String(result.rollType);

  for (const entry of (result?.characteristics ?? []) as AnyRecord[]) {
    if (entry?.res === undefined) continue;
    const die: Dsa5RollSummary['dice'][number] = {
      check: String(entry.char ?? ''),
      roll: Number(entry.res),
    };
    if (entry.tar !== undefined) die.target = Number(entry.tar);
    if (entry.suc !== undefined) die.success = Boolean(entry.suc);
    summary.dice.push(die);
  }

  if (result?.modifiers !== undefined) summary.modifiers = Number(result.modifiers);
  if (result?.qualityStep !== undefined) summary.qualityStep = Number(result.qualityStep);
  // For 3d20 checks `result` is the skill points left over (FP); other tests leave it unset.
  if (typeof result?.result === 'number') summary.remainingSkillPoints = result.result;
  if (result?.damage !== undefined) summary.damage = Number(result.damage);
  if (result?.damageRoll?.formula) summary.damageFormula = String(result.damageRoll.formula);
  if (result?.damagedescription) summary.damageDescription = stripHtml(result.damagedescription);

  // Rendering the chat card moves preData off the result, so fall back to the card's flags.
  const calc =
    result?.preData?.calculatedSpellModifiers ??
    (game as any).messages?.get?.(result?.messageId)?.flags?.data?.preData
      ?.calculatedSpellModifiers;
  const finalCost = calc?.finalcost;
  if (sourceType && SPELL_TYPES.includes(sourceType) && finalCost !== undefined) {
    const resource = CLERICAL_TYPES.includes(sourceType) ? 'KaP' : 'AsP';
    summary.cost = {
      amount: Number(finalCost),
      resource,
      paid: false,
      note: `Not deducted automatically: as in DSA5 itself, the ${resource} are paid from the chat card; use dsa5-apply-damage with action "pay-cost" and this messageId.`,
    };
  }
  if (result?.messageId) summary.messageId = String(result.messageId);
  return summary;
}

interface PreparedTest {
  error?: string;
  name?: string;
  sourceType?: string;
  setup?: (options: AnyRecord) => Promise<AnyRecord | undefined>;
}

/** Find what to roll and return a function that calls the matching system setup method. */
function prepareCheck(
  actor: any,
  check: Dsa5CheckType,
  name: string | undefined,
  tokenId: string | undefined
): PreparedTest {
  const needName = (what: string): PreparedTest => ({
    error: `"name" is required for a ${check} check: ${what}`,
  });

  switch (check) {
    case 'skill': {
      if (!name) return needName('the skill name or item id.');
      const skill = findItem(actor, name, ['skill']);
      if (!skill) {
        return {
          error: `Skill "${name}" not found on ${actor.name}. Skills: ${itemNames(actor, ['skill'])}`,
        };
      }
      return {
        name: skill.name,
        sourceType: 'skill',
        setup: options => actor.setupSkill(skill, options, tokenId),
      };
    }
    case 'attribute': {
      if (!name) return needName(`one of ${characteristicHelp()}.`);
      const key = resolveDsa5Characteristic(name);
      if (!key)
        return { error: `Unknown attribute "${name}". Use one of ${characteristicHelp()}.` };
      return {
        name: key.toUpperCase(),
        sourceType: 'char',
        setup: options => actor.setupCharacteristic(key, options, tokenId),
      };
    }
    case 'attack':
    case 'parry': {
      if (!name) {
        return needName('a weapon, creature trait or combat skill name, or "weaponless".');
      }
      if (WEAPONLESS_NAMES.includes(normalize(name))) {
        return {
          name: 'weaponless',
          sourceType: 'meleeweapon',
          setup: options => actor.setupWeaponless(check, options, tokenId),
        };
      }
      const types = check === 'parry' ? ['meleeweapon', 'combatskill', 'trait'] : ATTACK_ITEM_TYPES;
      const item = findItem(actor, name, types);
      if (!item) {
        return {
          error: `No ${check === 'parry' ? 'melee weapon, trait or combat skill' : 'weapon, trait or combat skill'} "${name}" on ${actor.name}. Available: ${itemNames(actor, types)}; or use "weaponless".`,
        };
      }
      if (item.type === 'trait' && !ATTACK_TRAIT_TYPES.includes(item.system?.traitType?.value)) {
        return { error: `Trait "${item.name}" is not an attack trait and cannot be rolled.` };
      }
      // Ranged combat skills (weapontype 1) and ranged attack traits cannot parry.
      if (
        check === 'parry' &&
        ((item.type === 'combatskill' && Number(item.system?.weapontype?.value) === 1) ||
          (item.type === 'trait' && item.system?.traitType?.value !== 'meleeAttack'))
      ) {
        return { error: `${item.name} is a ranged attack and cannot be used to parry.` };
      }
      return {
        name: item.name,
        sourceType: item.type,
        setup: options => actor.setupWeapon(item, check, options, tokenId),
      };
    }
    case 'dodge':
      return {
        name: 'dodge',
        sourceType: 'dodge',
        setup: options => actor.setupDodge(options, tokenId),
      };
    case 'spell': {
      if (!name) return needName('the spell, liturgy, ritual or ceremony name or item id.');
      const spell = findItem(actor, name, SPELL_TYPES);
      if (!spell) {
        return {
          error: `No spell, liturgy, ritual or ceremony "${name}" on ${actor.name}. Available: ${itemNames(actor, SPELL_TYPES)}`,
        };
      }
      return {
        name: spell.name,
        sourceType: spell.type,
        setup: options => actor.setupSpell(spell, options, tokenId),
      };
    }
    default:
      return {
        error: `Unknown check "${String(check)}". Use one of ${DSA5_CHECK_TYPES.join(', ')}.`,
      };
  }
}

/** Run a prepared test without a dialog and summarize it. */
async function runBypassed(
  actor: any,
  prepared: PreparedTest,
  modifier: number,
  messageMode: string | undefined
): Promise<{ summary?: Dsa5RollSummary; error?: string }> {
  const options: AnyRecord = { bypass: true };
  if (messageMode) options.messageMode = messageMode;
  const setup = await prepared.setup!(options);
  if (!setup?.testData) {
    // The system refused before rolling (e.g. a ranged weapon without ammunition) and has
    // already shown the reason as a notification in Foundry.
    return {
      error: `DSA5 did not start the test for "${prepared.name}" (for example a ranged weapon without ammunition). Check the notification in Foundry.`,
    };
  }
  applyDialogDefaults(setup, modifier);
  const outcome = await actor.basicTest(setup);
  if (!outcome?.result) {
    return {
      error: `DSA5 did not roll "${prepared.name}" (no permission to roll for this actor).`,
    };
  }
  const summary = summarizeDsa5Result(outcome.result, prepared.sourceType);
  // basicTest() has already started or answered the opposed test; report where it stands.
  const opposed = summarizeDsa5Opposed(summary.messageId);
  if (opposed) summary.opposed = opposed;
  return { summary };
}

/**
 * Roll a DSA5 check for an actor as the GM, without a dialog, and post the system's chat card.
 */
export async function rollDsa5Check(
  actor: any,
  params: {
    check: Dsa5CheckType;
    name?: string | undefined;
    modifier?: number | undefined;
    messageMode?: Dsa5MessageMode | undefined;
  }
): Promise<Dsa5RollOutcome> {
  const modifier = parseDsa5Modifier(params.modifier);
  if (modifier === null) {
    return { success: false, error: 'modifier must be a whole number (+ easier, - harder).' };
  }
  if (params.messageMode && !DSA5_MESSAGE_MODES.includes(params.messageMode)) {
    return {
      success: false,
      error: `messageMode must be one of ${DSA5_MESSAGE_MODES.join(', ')}.`,
    };
  }

  const prepared = prepareCheck(actor, params.check, params.name, speakerTokenId(actor));
  if (prepared.error || !prepared.setup) {
    return { success: false, error: prepared.error ?? 'Nothing to roll.' };
  }

  const { summary, error } = await runBypassed(actor, prepared, modifier, params.messageMode);
  if (!summary) return { success: false, error: error ?? 'Roll failed.' };

  const result: Dsa5RollOutcome = {
    success: true,
    actorName: actor.name,
    check: params.check,
    roll: summary,
  };
  if (prepared.name) result.name = prepared.name;
  return result;
}

export interface Dsa5ItemUseResult {
  success: boolean;
  status: 'completed' | 'initiated' | 'posted' | 'consumed' | 'failed';
  action: 'attack' | 'spell' | 'skill' | 'consume' | 'post';
  message: string;
  roll?: Dsa5RollSummary;
  requiresGMInteraction?: boolean;
}

/** What DSA5 does when an item of this type is used from the sheet. */
export function dsa5ItemAction(item: any): Dsa5ItemUseResult['action'] {
  if (item.type === 'trait') {
    return ATTACK_TRAIT_TYPES.includes(item.system?.traitType?.value) ? 'attack' : 'post';
  }
  if (ATTACK_ITEM_TYPES.includes(item.type)) return 'attack';
  if (SPELL_TYPES.includes(item.type)) return 'spell';
  if (item.type === 'skill') return 'skill';
  if (item.type === 'consumable' || item.type === 'plant') return 'consume';
  return 'post';
}

/**
 * Use a DSA5 item the way the character sheet does: weapons and attack traits roll an
 * attack, spells/liturgies/rituals/ceremonies their casting test, skills a skill check,
 * consumables and plants are consumed, anything else is posted to chat.
 */
export async function useDsa5Item(
  actor: any,
  item: any,
  options: { skipDialog?: boolean | undefined } = {}
): Promise<Dsa5ItemUseResult> {
  const action = dsa5ItemAction(item);
  const tokenId = speakerTokenId(actor);

  if (action === 'post') {
    await item.postItem();
    return {
      success: true,
      status: 'posted',
      action,
      message: `${item.name} has no roll or use action in DSA5; it was posted to chat.`,
    };
  }

  if (action === 'consume') {
    // Same availability check the system makes before consuming. Checked here so the
    // caller gets an error instead of a notification only the GM's browser shows.
    const quantity = Number(item.system?.quantity?.value ?? 0);
    const available =
      item.type === 'consumable'
        ? (quantity - 1) * Number(item.system?.maxCharges ?? 1) + Number(item.system?.charges ?? 0)
        : quantity;
    if (available <= 0) {
      return {
        success: false,
        status: 'failed',
        action,
        message: `${item.name} has no uses left.`,
      };
    }
    // The sheet's "Consume" entry calls this; it updates or deletes the item, posts the
    // use card and applies the item's effects to the actor.
    await item.setupEffect(null, {}, tokenId);
    return {
      success: true,
      status: 'consumed',
      action,
      message: `${actor.name} used ${item.name}.`,
    };
  }

  const prepared: PreparedTest = {
    name: item.name,
    sourceType: item.type,
    setup: opts => {
      if (action === 'attack') return actor.setupWeapon(item, 'attack', opts, tokenId);
      if (action === 'spell') return actor.setupSpell(item, opts, tokenId);
      return actor.setupSkill(item, opts, tokenId);
    },
  };

  if (options.skipDialog === false) {
    // Leave the system's dialog open for the GM; don't await it, it blocks until confirmed.
    prepared.setup!({})
      .then(setup => (setup ? actor.basicTest(setup) : undefined))
      .catch((err: unknown) => console.error(`[foundry-mcp-bridge] DSA5 item use failed:`, err));
    return {
      success: true,
      status: 'initiated',
      action,
      message: `The DSA5 ${action} dialog for ${item.name} is open in Foundry VTT; the GM confirms it and the result appears in chat.`,
      requiresGMInteraction: true,
    };
  }

  const { summary, error } = await runBypassed(actor, prepared, 0, undefined);
  if (!summary) {
    return { success: false, status: 'failed', action, message: error ?? 'Roll failed.' };
  }
  return {
    success: true,
    status: 'completed',
    action,
    message: `${actor.name} used ${item.name}: ${summary.description || summary.outcome}.`,
    roll: summary,
  };
}

// ----- Roll requests to players -----

const REQUEST_ROLL_TYPES: Record<string, 'skill' | 'attribute'> = {
  skill: 'skill',
  ability: 'attribute',
};

/**
 * Resolve the actor a roll request is for: a player's assigned (or first owned) character,
 * or an actor by name. Unlike the generic resolver, an offline owner is fine here: DSA5's
 * request card waits for the player and lets the GM roll on their behalf.
 */
function resolveRequestActor(target: string): { actor?: any; error?: string } {
  const wanted = normalize(target);
  const users: any[] = Array.from((game as any).users ?? []).filter((u: any) => !u.isGM);
  const user =
    users.find(u => normalize(u.name) === wanted) ??
    users.find(u => normalize(u.name).includes(wanted));
  if (user) {
    const owned = Array.from((game as any).actors ?? []).filter((a: any) =>
      a.testUserPermission?.(user, 'OWNER')
    );
    const actor =
      user.character ?? owned.find((a: any) => a.type === 'character') ?? owned[0] ?? undefined;
    if (!actor) return { error: `Player "${user.name}" has no character assigned or owned.` };
    return { actor };
  }

  const actors: any[] = Array.from((game as any).actors ?? []);
  const exact = actors.filter(a => normalize(a.name) === wanted);
  const candidates = exact.length ? exact : actors.filter(a => normalize(a.name).includes(wanted));
  const actor = candidates.find(a => a.hasPlayerOwner) ?? candidates[0];
  if (actor) return { actor };

  return {
    error: `No player or character named "${target}" found. Players: ${users.map(u => u.name).join(', ') || 'none'}`,
  };
}

/** Wait for the request card DSA5 creates, without waiting for the players to roll. */
function createRequestCard(service: any, request: AnyRecord): Promise<any> {
  // createRequest() posts the card and then awaits every player's answer (up to two
  // minutes), far longer than a bridge query may take. Resolve as soon as the card exists.
  const hooks = Hooks as any;
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      hooks.off('createChatMessage', hookId);
      clearTimeout(timer);
      fn();
    };
    const hookId = hooks.on('createChatMessage', (message: any) => {
      const state = message?.flags?.dsa5?.rollRequest;
      if (state?.name === request.name && state?.category === request.category) {
        finish(() => resolve(message));
      }
    });
    const timer = setTimeout(
      () => finish(() => reject(new Error('DSA5 did not create the roll request card.'))),
      15000
    );
    Promise.resolve(service.createRequest(request)).then(
      (message: any) => finish(() => resolve(message)),
      (error: unknown) => finish(() => reject(error))
    );
  });
}

/**
 * request-player-rolls in a DSA5 world: post the system's own roll request card for a
 * skill check (rollType "skill") or attribute check (rollType "ability"). The designated
 * player gets the system's roll dialog with the modifier filled in; the result is written
 * back onto the card.
 */
export async function requestDsa5PlayerRoll(data: {
  rollType: string;
  rollTarget: string;
  targetPlayer: string;
  isPublic: boolean;
  rollModifier?: string;
  flavor?: string;
}): Promise<{ success: boolean; message: string; error?: string }> {
  const fail = (error: string) => ({ success: false, message: '', error });

  const category = REQUEST_ROLL_TYPES[data.rollType];
  if (!category) {
    return fail(
      `rollType "${data.rollType}" does not exist in DSA5. Use rollType "skill" for a skill check (Talentprobe, rollTarget = skill name such as "Climbing") or "ability" for an attribute check (Eigenschaftsprobe, rollTarget = ${characteristicHelp()}). rollModifier is a whole number: positive makes the check easier, negative harder. For combat rolls, dodge or spells rolled by the GM use dsa5-roll-check.`
    );
  }

  const modifier = parseDsa5Modifier(data.rollModifier);
  if (modifier === null) {
    return fail(
      `rollModifier "${data.rollModifier}" is not valid in DSA5: use a whole number such as "+2" (easier) or "-3" (harder); dice are not allowed.`
    );
  }

  const service = (game as any).dsa5?.queries?.RollRequestService;
  if (typeof service?.createRequest !== 'function') {
    return fail('This DSA5 version does not provide the roll request service.');
  }

  const { actor, error } = resolveRequestActor(data.targetPlayer);
  if (!actor) return fail(error ?? `Could not find player or character: ${data.targetPlayer}`);

  let name: string;
  if (category === 'skill') {
    const skill = findItem(actor, data.rollTarget, ['skill']);
    if (!skill) {
      return fail(
        `Skill "${data.rollTarget}" not found on ${actor.name}. Skills: ${itemNames(actor, ['skill'], 80)}`
      );
    }
    name = skill.name;
  } else {
    const key = resolveDsa5Characteristic(data.rollTarget);
    if (!key) {
      return fail(`Unknown attribute "${data.rollTarget}". Use one of ${characteristicHelp()}.`);
    }
    // The request card looks the attribute up by its localized name.
    name = localize((game as any).dsa5.config.characteristics[key]);
  }

  const messageMode: Dsa5MessageMode = data.isPublic ? 'public' : 'gm';
  const request: AnyRecord = { category, name, modifier, messageMode, actors: [actor] };
  if (data.flavor) request.label = `${name} (${data.flavor})`;
  if (!data.isPublic) {
    const whisper = Array.from((game as any).users ?? [])
      .filter((u: any) => u.isGM || actor.testUserPermission?.(u, 'OWNER'))
      .map((u: any) => u.id);
    request.whisper = whisper;
  }

  const message = await createRequestCard(service, request);
  const recipient = message?.flags?.dsa5?.rollRequest?.recipients?.[0];
  const designated = recipient?.designatedUserId
    ? (game as any).users?.get(recipient.designatedUserId)
    : undefined;
  const modifierText = modifier ? ` (${modifier > 0 ? '+' : ''}${modifier})` : '';
  const who = designated
    ? `${designated.name} gets the roll dialog for ${actor.name}`
    : `no owner of ${actor.name} is online, so the card waits; the GM can use "Roll on Behalf" on it, or "Resend" once the player is online`;

  return {
    success: true,
    message: `DSA5 roll request posted: ${name}${modifierText} for ${actor.name} (${data.isPublic ? 'public' : 'private'} result); ${who}. The outcome and quality level appear on the request card.`,
  };
}
