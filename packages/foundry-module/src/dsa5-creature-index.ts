/**
 * Enhanced creature index for Das Schwarze Auge 5 (dsa5).
 *
 * Extraction and filtering for `list-creatures-by-criteria` in DSA5 worlds. Kept apart
 * from data-access.ts so it can be tested without a Foundry world; data-access.ts only
 * drives the pack loop and persistence, as it does for the other systems.
 *
 * DSA5 has no challenge rating or level for creatures. What a GM filters by instead is
 * the creature class ("Tier, nicht humanoid", "Daimonid, …"), the size category, the
 * Lebensenergie, and whether the actor works magic or miracles.
 *
 * All values are read from the prepared actor (`pack.getDocuments()`), so the numbers
 * the system derives at runtime (maximum LeP, Ausweichen, Rüstungsschutz, …) are the
 * ones the sheet shows.
 */

/** Actor types that go into the index. */
export const DSA5_INDEXED_ACTOR_TYPES = ['creature', 'npc', 'character'] as const;

/** The system's size categories (`DSA5.sizeCategories`). */
export const DSA5_SIZE_CATEGORIES = ['tiny', 'small', 'average', 'big', 'giant'] as const;

/**
 * Names callers use for a size category, mapped onto the system's. Covers the German
 * names and the D&D-style sizes the tool's `size` parameter also accepts.
 */
const SIZE_ALIASES: Record<string, string> = {
  tiny: 'tiny',
  winzig: 'tiny',
  small: 'small',
  klein: 'small',
  average: 'average',
  medium: 'average',
  mittel: 'average',
  big: 'big',
  large: 'big',
  groß: 'big',
  gross: 'big',
  giant: 'giant',
  huge: 'giant',
  gargantuan: 'giant',
  riesig: 'giant',
};

/** Item types that mean an actor casts spells or works liturgies. */
const SPELL_ITEM_TYPES = new Set([
  'spell',
  'ritual',
  'liturgy',
  'ceremony',
  'magictrick',
  'blessing',
]);

export interface DSA5CreatureIndex {
  /** Discriminator within the module's union of per-system index entries. */
  system: 'dsa5';
  id: string;
  name: string;
  type: string; // creature | npc | character
  pack: string;
  packLabel: string;
  img?: string;
  /** Creature class as written on the sheet, e.g. "Tier, nicht humanoid". Creatures only. */
  creatureClass: string;
  /** Species / culture / profession. NPCs and characters only. */
  species: string;
  culture: string;
  profession: string;
  size: string; // one of DSA5_SIZE_CATEGORIES
  lifePoints: number;
  astralEnergy: number;
  karmaEnergy: number;
  hasSpells: boolean;
  soulPower: number;
  toughness: number;
  dodge: number;
  armor: number;
  speed: number;
  initiative: number;
  /** Total Abenteuerpunkte; 0 for creatures, which have none. */
  experiencePoints: number;
  /** Names of the creature's traits (attacks, abilities), for a quick impression. */
  traits: string[];
}

type Range = number | { min?: number; max?: number };

export interface DSA5CreatureCriteria {
  actorType?: string;
  creatureClass?: string;
  creatureType?: string;
  species?: string;
  size?: string;
  hasSpells?: boolean;
  hitPoints?: Range;
}

const number = (value: unknown): number => {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : 0;
};

const text = (value: unknown): string => (typeof value === 'string' ? value.trim() : '');

/** Map a size name onto the system's category; unknown names are returned lowercased. */
export function normalizeDSA5Size(size: unknown): string {
  const key = text(size).toLowerCase();
  return SIZE_ALIASES[key] ?? key;
}

/**
 * Build the index entry for one actor of a compendium pack, or null when the actor
 * type is not indexed (e.g. group, vehicle).
 */
export function extractDSA5Creature(doc: any, pack: any): DSA5CreatureIndex | null {
  if (!(DSA5_INDEXED_ACTOR_TYPES as readonly string[]).includes(doc?.type)) return null;

  const system = doc.system ?? {};
  const status = system.status ?? {};
  const details = system.details ?? {};
  const items: any[] = Array.from(doc.items ?? []);

  const astralEnergy = number(status.astralenergy?.max);
  const karmaEnergy = number(status.karmaenergy?.max);
  const hasSpells =
    astralEnergy > 0 || karmaEnergy > 0 || items.some(item => SPELL_ITEM_TYPES.has(item?.type));

  // Where the system derives a total (`max` = value + modifiers), that is what is rolled.
  const total = (resource: any): number => number(resource?.max ?? resource?.value);

  return {
    system: 'dsa5',
    id: doc.id ?? doc._id,
    name: doc.name,
    type: doc.type,
    pack: pack.collection ?? pack.metadata?.id,
    packLabel: pack.metadata?.label ?? pack.collection,
    ...(doc.img ? { img: doc.img } : {}),
    creatureClass: text(system.creatureClass?.value),
    species: text(details.species?.value),
    culture: text(details.culture?.value),
    profession: text(details.career?.value),
    size: normalizeDSA5Size(status.size?.value) || 'average',
    // `wounds.max` is derived; fall back to the stored base for unprepared data.
    lifePoints: number(status.wounds?.max) || number(status.wounds?.initial),
    astralEnergy,
    karmaEnergy,
    hasSpells,
    soulPower: total(status.soulpower),
    toughness: total(status.toughness),
    dodge: total(status.dodge),
    armor: number(system.totalArmor),
    speed: total(status.speed),
    initiative: Math.round(number(status.initiative?.value)),
    experiencePoints: doc.type === 'creature' ? 0 : number(details.experience?.total),
    traits: items
      .filter(item => item?.type === 'trait')
      .map(item => text(item.name))
      .filter(Boolean),
  };
}

function inRange(value: number, range: Range): boolean {
  if (typeof range === 'number') return value === range;
  if (range.min !== undefined && value < range.min) return false;
  if (range.max !== undefined && value > range.max) return false;
  return true;
}

const contains = (haystack: string, needle: string): boolean =>
  haystack.toLowerCase().includes(needle.trim().toLowerCase());

/**
 * DSA5 criteria:
 * - `actorType`     creature | npc | character
 * - `creatureClass` part of the creature class of a creature
 * - `creatureType`  the tool's generic type filter: part of the creature class, or of
 *                   the species for NPCs and characters
 * - `species`       part of the species of an NPC or character
 * - `size`          tiny | small | average | big | giant (D&D-style and German names are mapped)
 * - `hitPoints`     Lebensenergie, exact or {min, max}
 * - `hasSpells`     has AsP or KaP, or owns spells / liturgies
 */
export function passesDSA5Criteria(
  creature: DSA5CreatureIndex,
  criteria: DSA5CreatureCriteria
): boolean {
  if (criteria.actorType && creature.type !== criteria.actorType.toLowerCase()) return false;

  if (criteria.creatureClass && !contains(creature.creatureClass, criteria.creatureClass)) {
    return false;
  }

  if (criteria.creatureType) {
    const described = creature.type === 'creature' ? creature.creatureClass : creature.species;
    if (!contains(described, criteria.creatureType)) return false;
  }

  if (criteria.species && !contains(creature.species, criteria.species)) return false;

  if (criteria.size && creature.size !== normalizeDSA5Size(criteria.size)) return false;

  if (criteria.hasSpells !== undefined && creature.hasSpells !== criteria.hasSpells) return false;

  if (criteria.hitPoints !== undefined && !inRange(creature.lifePoints, criteria.hitPoints)) {
    return false;
  }

  return true;
}

/** Shape one index entry for the `list-creatures-by-criteria` result. */
export function formatDSA5CreatureResult(creature: DSA5CreatureIndex): Record<string, unknown> {
  const isCreature = creature.type === 'creature';
  const described = isCreature
    ? creature.creatureClass
    : [creature.species, creature.profession].filter(Boolean).join(', ');

  const summary = [
    `${creature.type}${described ? `: ${described}` : ''}`,
    `${creature.size}, ${creature.lifePoints} LeP`,
    ...(creature.astralEnergy > 0 ? [`${creature.astralEnergy} AsP`] : []),
    ...(creature.karmaEnergy > 0 ? [`${creature.karmaEnergy} KaP`] : []),
    `from ${creature.packLabel}`,
  ].join(' — ');

  return {
    id: creature.id,
    name: creature.name,
    type: creature.type,
    pack: creature.pack,
    packLabel: creature.packLabel,
    hasImage: !!creature.img,
    summary,
    ...(isCreature
      ? { creatureClass: creature.creatureClass }
      : {
          species: creature.species,
          culture: creature.culture,
          profession: creature.profession,
          experiencePoints: creature.experiencePoints,
        }),
    size: creature.size,
    lifePoints: creature.lifePoints,
    ...(creature.astralEnergy > 0 ? { astralEnergy: creature.astralEnergy } : {}),
    ...(creature.karmaEnergy > 0 ? { karmaEnergy: creature.karmaEnergy } : {}),
    hasSpells: creature.hasSpells,
    soulPower: creature.soulPower,
    toughness: creature.toughness,
    dodge: creature.dodge,
    armor: creature.armor,
    speed: creature.speed,
    initiative: creature.initiative,
    ...(creature.traits.length > 0 ? { traits: creature.traits } : {}),
  };
}
