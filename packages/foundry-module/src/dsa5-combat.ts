/**
 * DSA5 combat view for get-character.
 *
 * DSA5 derives the numbers a GM needs in a fight (Rüstungsschutz, Belastung, AT / PA / FK
 * and damage per weapon) at render time; most of them are not stored on the actor or its
 * items (`system.totalArmor`, for instance, only holds the bonus from effects). The MCP
 * server only sees what this module sends, so the values are computed here with the
 * system's own code: `Actor#prepareSheet` (what the character sheet renders, incl. shield
 * parry, off-hand modifiers, damage over the Schadensschwelle and ammunition), the static
 * `Actordsa5.armorValue` (what damage application uses, incl. creature armor traits) and
 * `DSA5Payment._actorsMoney` (the currency the payment functions use).
 */

/** A worn melee weapon as the sheet shows it. */
export interface DSA5MeleeWeapon {
  id: string;
  name: string;
  combatSkill: string;
  attack?: number;
  parry?: number;
  damage: string;
  reach?: string;
  shield?: true;
  offHand?: true;
  twoHanded?: true;
  /** The combat skill named on the weapon is not on the actor, so the system computed no AT / PA. */
  combatSkillMissing?: true;
}

/** A worn ranged weapon as the sheet shows it. */
export interface DSA5RangedWeapon {
  id: string;
  name: string;
  combatSkill: string;
  attack?: number;
  damage: string;
  range?: string;
  reloadTime?: number;
  ammunition?: { name: string; quantity: number };
  combatSkillMissing?: true;
}

/** A creature's natural attack (trait item of type meleeAttack / rangeAttack). */
export interface DSA5TraitAttack {
  id: string;
  name: string;
  kind: 'melee' | 'ranged';
  attack: number;
  parry?: number;
  damage: string;
  reach?: string;
  reloadTime?: number;
}

export interface DSA5CombatSummary {
  armor: {
    /** Total Rüstungsschutz: worn armor (after wear), armor traits and effect bonuses. */
    protection: number;
    worn: Array<{ id: string; name: string; protection: number; encumbrance: number }>;
    spellArmor?: number;
    liturgyArmor?: number;
  };
  encumbrance: {
    /** Active Belastung condition level (armor plus carried weight), 0–4. */
    level: number;
    /** Belastung caused by worn armor alone. */
    fromArmor: number;
    carriedWeight?: number;
    carryCapacity?: number;
  };
  brawling?: { attack: number; parry: number };
  meleeWeapons: DSA5MeleeWeapon[];
  rangedWeapons: DSA5RangedWeapon[];
  traitAttacks: DSA5TraitAttack[];
  money?: {
    /** In Silbertaler; currency only (Mammon is not counted, as in the system's payment code). */
    total: number;
    coins: Array<{ name: string; quantity: number; value: number }>;
  };
}

/** Actor types the sheet prepares with weapons and armor; vehicles and groups are left out. */
const COMBAT_ACTOR_TYPES = new Set(['character', 'npc', 'creature']);

const num = (value: unknown): number | undefined => {
  const n = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
  return typeof n === 'number' && Number.isFinite(n) ? n : undefined;
};

/** Damage as the sheet prints it: the die plus the added flat damage (e.g. "1d6+5"). */
const damageOf = (prepared: any): string =>
  `${prepared?.damagedie ?? ''}${prepared?.damageAdd ?? ''}` ||
  String(prepared?.system?.damage?.value ?? '');

const round2 = (value: number): number => Math.round(value * 100) / 100;

function meleeWeapon(prepared: any): DSA5MeleeWeapon {
  const system = prepared.system ?? {};
  const weapon: DSA5MeleeWeapon = {
    id: prepared._id,
    name: prepared.name,
    combatSkill: String(system.combatskill?.value ?? ''),
    damage: damageOf(prepared),
  };
  const attack = num(prepared.attack);
  if (attack === undefined) {
    weapon.combatSkillMissing = true;
  } else {
    weapon.attack = attack;
    const parry = num(prepared.parry);
    if (parry !== undefined) weapon.parry = parry;
  }
  if (system.reach?.value) weapon.reach = String(system.reach.value);
  const rules = (globalThis as any).game?.dsa5?.apps?.RuleChaos;
  if (rules?.isShield?.(prepared)) weapon.shield = true;
  if (system.worn?.offHand) weapon.offHand = true;
  if (prepared.wieldedTwoHand) weapon.twoHanded = true;
  return weapon;
}

function rangedWeapon(prepared: any): DSA5RangedWeapon {
  const system = prepared.system ?? {};
  const weapon: DSA5RangedWeapon = {
    id: prepared._id,
    name: prepared.name,
    combatSkill: String(system.combatskill?.value ?? ''),
    damage: damageOf(prepared),
  };
  const attack = num(prepared.attack);
  if (attack === undefined) weapon.combatSkillMissing = true;
  else weapon.attack = attack;
  const range = prepared.calculatedRange ?? system.reach?.value;
  if (range) weapon.range = String(range);
  const reload = num(prepared.LZ);
  if (reload !== undefined) weapon.reloadTime = reload;
  const currentAmmoId = system.currentAmmo?.value;
  const ammo = currentAmmoId
    ? (prepared.ammo ?? []).find((a: any) => a._id === currentAmmoId)
    : undefined;
  if (ammo) {
    weapon.ammunition = { name: ammo.name, quantity: num(ammo.system?.quantity?.value) ?? 0 };
  }
  return weapon;
}

function traitAttack(prepared: any, kind: 'melee' | 'ranged'): DSA5TraitAttack {
  const system = prepared.system ?? {};
  const attack: DSA5TraitAttack = {
    id: prepared._id,
    name: prepared.name,
    kind,
    attack: num(prepared.attack) ?? 0,
    damage: damageOf(prepared),
  };
  const parry = num(prepared.parry);
  if (kind === 'melee' && parry !== undefined && parry !== 0) attack.parry = parry;
  if (system.reach?.value) attack.reach = String(system.reach.value);
  const reload = num(prepared.LZ);
  if (kind === 'ranged' && reload !== undefined) attack.reloadTime = reload;
  return attack;
}

function money(actor: any): DSA5CombatSummary['money'] {
  const payment = (globalThis as any).game?.dsa5?.apps?.DSA5Payment;
  if (typeof payment?._actorsMoney !== 'function') return undefined;
  const { money: coins, sum } = payment._actorsMoney(actor);
  if (!Array.isArray(coins) || coins.length === 0) return undefined;
  return {
    total: round2(Number(sum) || 0),
    coins: coins
      .map((coin: any) => ({
        name: coin.name,
        quantity: num(coin.system?.quantity?.value) ?? 0,
        value: num(coin.system?.price?.value) ?? 0,
      }))
      .filter((coin: { quantity: number }) => coin.quantity !== 0)
      .sort((a: { value: number }, b: { value: number }) => b.value - a.value),
  };
}

/**
 * The combat view for a DSA5 actor, or undefined when the actor type has none or the
 * system's preparation is unavailable / throws (get-character then works as before).
 */
export function buildDSA5CombatSummary(actor: any): DSA5CombatSummary | undefined {
  if (!actor || !COMBAT_ACTOR_TYPES.has(actor.type)) return undefined;
  if (typeof actor.prepareSheet !== 'function') return undefined;

  let sheet: any;
  try {
    // Pure computation on copies of the items (toObject(false)); it writes nothing.
    sheet = actor.prepareSheet({ details: [] });
  } catch {
    return undefined;
  }

  const system = actor.system ?? {};
  const actorClass = (globalThis as any).game?.dsa5?.entities?.Actordsa5;
  let protection = num(sheet.armorSum) ?? 0;
  try {
    // armorValue also counts creature armor traits, which the sheet total leaves out.
    const value = num(actorClass?.armorValue?.(actor)?.armor);
    if (value !== undefined) protection = value;
  } catch {
    // keep the sheet total
  }

  const summary: DSA5CombatSummary = {
    armor: {
      protection,
      worn: (sheet.wornArmor ?? []).map((armor: any) => ({
        id: armor._id,
        name: armor.name,
        protection: num(armor.system?.protection?.value) ?? 0,
        encumbrance:
          num(armor.system?.calculatedEncumbrance) ?? num(armor.system?.encumbrance?.value) ?? 0,
      })),
    },
    encumbrance: {
      level: num(system.condition?.encumbered) ?? 0,
      fromArmor: num(system.armorEncumbrance) ?? 0,
    },
    meleeWeapons: (sheet.wornMeleeWeapons ?? []).map(meleeWeapon),
    rangedWeapons: (sheet.wornRangedWeapons ?? []).map(rangedWeapon),
    traitAttacks: [
      ...(sheet.traits?.meleeAttack ?? []).map((t: any) => traitAttack(t, 'melee')),
      ...(sheet.traits?.rangeAttack ?? []).map((t: any) => traitAttack(t, 'ranged')),
    ],
  };

  const spellArmor = num(sheet.spellArmor);
  if (spellArmor) summary.armor.spellArmor = spellArmor;
  const liturgyArmor = num(sheet.liturgyArmor);
  if (liturgyArmor) summary.armor.liturgyArmor = liturgyArmor;

  const carriedWeight = num(system.totalWeight);
  if (carriedWeight !== undefined) summary.encumbrance.carriedWeight = round2(carriedWeight);
  const carryCapacity = num(system.carrycapacity);
  if (carryCapacity !== undefined) summary.encumbrance.carryCapacity = carryCapacity;

  // Creatures without a Raufen skill have no weaponless values worth reporting.
  const brawlAttack = num(sheet.brawling?.attack);
  if (brawlAttack) {
    summary.brawling = { attack: brawlAttack, parry: num(sheet.brawling?.parry) ?? 0 };
  }

  try {
    const purse = money(actor);
    if (purse) summary.money = purse;
  } catch {
    // money is optional
  }

  return summary;
}
