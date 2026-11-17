/**
 * Formats the DSA5 combat view for get-character.
 *
 * The values are computed in Foundry by the bridge module (`dsa5Combat` in the
 * character payload, see packages/foundry-module/src/dsa5-combat.ts) with the system's
 * own sheet preparation; this file only shapes them for the response. Older bridge
 * modules do not send `dsa5Combat`; then only Rüstungsschutz is estimated from the
 * stored item data.
 */

const num = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) ? value : undefined;

const str = (value: unknown): string | undefined =>
  typeof value === 'string' && value !== '' ? value : undefined;

const list = (value: unknown): any[] => (Array.isArray(value) ? value : []);

/** Copy the listed keys whose values are set, in order. */
function pick(source: any, keys: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of keys) {
    const value = source?.[key];
    if (value !== undefined && value !== null && value !== '') out[key] = value;
  }
  return out;
}

export interface DSA5CombatStats {
  armor: number;
  encumbrance?: number;
  combat: Record<string, unknown>;
  money?: { total: number; unit: string; coins: Record<string, number> };
}

/**
 * Shape the module's `dsa5Combat` block, or undefined when the payload has none.
 */
export function formatDSA5Combat(raw: any): DSA5CombatStats | undefined {
  if (!raw || typeof raw !== 'object' || !raw.armor) return undefined;

  const armor: Record<string, unknown> = {
    protection: num(raw.armor.protection) ?? 0,
    ...pick(raw.armor, ['spellArmor', 'liturgyArmor']),
  };
  const worn = list(raw.armor.worn).map(a => pick(a, ['id', 'name', 'protection', 'encumbrance']));
  if (worn.length > 0) armor.worn = worn;

  const combat: Record<string, unknown> = {
    armor,
    encumbrance: pick(raw.encumbrance, ['level', 'fromArmor', 'carriedWeight', 'carryCapacity']),
  };

  const melee = list(raw.meleeWeapons).map(w =>
    pick(w, [
      'id',
      'name',
      'combatSkill',
      'attack',
      'parry',
      'damage',
      'reach',
      'shield',
      'offHand',
      'twoHanded',
      'combatSkillMissing',
    ])
  );
  if (melee.length > 0) combat.meleeWeapons = melee;

  const ranged = list(raw.rangedWeapons).map(w =>
    pick(w, [
      'id',
      'name',
      'combatSkill',
      'attack',
      'damage',
      'range',
      'reloadTime',
      'ammunition',
      'combatSkillMissing',
    ])
  );
  if (ranged.length > 0) combat.rangedWeapons = ranged;

  const attacks = list(raw.traitAttacks).map(t =>
    pick(t, ['id', 'name', 'kind', 'attack', 'parry', 'damage', 'reach', 'reloadTime'])
  );
  if (attacks.length > 0) combat.naturalAttacks = attacks;

  if (raw.brawling) combat.brawling = pick(raw.brawling, ['attack', 'parry']);

  const result: DSA5CombatStats = { armor: num(raw.armor.protection) ?? 0, combat };
  const level = num(raw.encumbrance?.level);
  if (level !== undefined) result.encumbrance = level;

  if (raw.money && num(raw.money.total) !== undefined) {
    const coins: Record<string, number> = {};
    for (const coin of list(raw.money.coins)) {
      const name = str(coin?.name);
      const quantity = num(coin?.quantity);
      if (name && quantity) coins[name] = quantity;
    }
    result.money = { total: raw.money.total, unit: 'Silbertaler', coins };
  }

  return result;
}

/**
 * Rüstungsschutz from the stored data, for bridge modules that do not send `dsa5Combat`:
 * worn armor plus creature armor traits plus the effect bonus in `system.totalArmor`,
 * mirroring `Actordsa5.armorValue` without the wear modifier.
 */
export function estimateDSA5Armor(actorData: any): number {
  let total = num(actorData?.system?.totalArmor) ?? 0;
  for (const item of list(actorData?.items)) {
    const system = item?.system ?? {};
    if (item.type === 'armor' && system.worn?.value) {
      total += Number(system.protection?.value) || 0;
    } else if (item.type === 'trait' && system.traitType?.value === 'armor') {
      total += Number(system.at?.value) || 0;
    }
  }
  return total;
}
