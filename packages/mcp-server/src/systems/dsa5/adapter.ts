/**
 * DSA5 System Adapter
 *
 * Implements SystemAdapter interface for DSA5 (Das Schwarze Auge 5) support.
 * Handles creature indexing, filtering, formatting, and data extraction.
 */

import type {
  SystemAdapter,
  SystemMetadata,
  SystemCreatureIndex,
  DSA5CreatureIndex,
} from '../types.js';
import {
  DSA5FiltersSchema,
  matchesDSA5Filters,
  describeDSA5Filters,
  type DSA5Filters,
} from './filters.js';
import {
  FIELD_PATHS,
  getExperienceLevel,
  EIGENSCHAFT_NAMES,
  SIZE_CATEGORY_ALIASES,
} from './constants.js';

/**
 * DSA5 system adapter
 */
export class DSA5Adapter implements SystemAdapter {
  getMetadata(): SystemMetadata {
    return {
      id: 'dsa5',
      name: 'dsa5',
      displayName: 'Das Schwarze Auge 5',
      version: '1.0.0',
      description:
        'Support for DSA5 (Das Schwarze Auge 5. Edition) with Eigenschaften, Talente, Erfahrungsgrade, and LeP/AsP/KaP resources',
      supportedFeatures: {
        creatureIndex: true,
        characterStats: true,
        spellcasting: true,
        powerLevel: true, // Uses Experience Level (Erfahrungsgrad 1-7)
      },
    };
  }

  canHandle(systemId: string): boolean {
    return systemId.toLowerCase() === 'dsa5';
  }

  /**
   * Extract creature data from Foundry document for indexing
   * This is called by the index builder in Foundry's browser context
   */
  extractCreatureData(
    doc: any,
    pack: any
  ): { creature: SystemCreatureIndex; errors: number } | null {
    // Implementation is in index-builder.ts since it runs in browser
    // This method is here for type compliance but delegates to IndexBuilder
    throw new Error('extractCreatureData should be called from DSA5IndexBuilder, not the adapter');
  }

  getFilterSchema() {
    return DSA5FiltersSchema;
  }

  matchesFilters(creature: SystemCreatureIndex, filters: Record<string, any>): boolean {
    // Validate filters match DSA5 schema
    const validated = DSA5FiltersSchema.safeParse(filters);
    if (!validated.success) {
      return false;
    }

    return matchesDSA5Filters(creature, validated.data as DSA5Filters);
  }

  getDataPaths(): Record<string, string | null> {
    return {
      // DSA5 specific paths
      level: FIELD_PATHS.DETAILS_EXPERIENCE_TOTAL, // Level is calculated from AP
      species: FIELD_PATHS.DETAILS_SPECIES,
      culture: FIELD_PATHS.DETAILS_CULTURE,
      profession: FIELD_PATHS.DETAILS_CAREER, // IMPORTANT: 'career' not 'profession'
      size: FIELD_PATHS.STATUS_SIZE,

      // Characteristics (Eigenschaften)
      characteristics: FIELD_PATHS.CHARACTERISTICS,
      mu: FIELD_PATHS.CHAR_MU,
      kl: FIELD_PATHS.CHAR_KL,
      in: FIELD_PATHS.CHAR_IN,
      ch: FIELD_PATHS.CHAR_CH,
      ff: FIELD_PATHS.CHAR_FF,
      ge: FIELD_PATHS.CHAR_GE,
      ko: FIELD_PATHS.CHAR_KO,
      kk: FIELD_PATHS.CHAR_KK,

      // Status values
      wounds: FIELD_PATHS.STATUS_WOUNDS,
      lifePoints: FIELD_PATHS.STATUS_WOUNDS_VALUE, // wounds.value holds the current LeP
      astralenergy: FIELD_PATHS.STATUS_ASTRAL,
      karmaenergy: FIELD_PATHS.STATUS_KARMA,
      speed: FIELD_PATHS.STATUS_SPEED,
      initiative: FIELD_PATHS.STATUS_INITIATIVE,
      dodge: FIELD_PATHS.STATUS_DODGE,
      armor: FIELD_PATHS.TOTAL_ARMOR, // derived from worn armor; not stored on the actor

      // Tradition
      tradition: FIELD_PATHS.TRADITION,

      // D&D5e-specific paths don't exist in DSA5
      challengeRating: null,
      creatureType: null,
      alignment: null,
      hitPoints: null,
      armorClass: null,
      legendaryActions: null,
      legendaryResistances: null,

      // PF2e-specific paths don't exist in DSA5
      perception: null,
      saves: null,
      rarity: null,
    };
  }

  formatCreatureForList(creature: SystemCreatureIndex): any {
    const dsa5Creature = creature as DSA5CreatureIndex;
    const formatted: any = {
      id: creature.id,
      name: creature.name,
      type: creature.type,
      pack: {
        id: creature.packName,
        label: creature.packLabel,
      },
    };

    // Add DSA5 specific stats
    if (dsa5Creature.systemData) {
      const stats: any = {};

      if (dsa5Creature.systemData.level !== undefined) {
        stats.level = dsa5Creature.systemData.level;

        // Add experience level name (e.g., "Erfahren")
        const expLevel = getExperienceLevel(dsa5Creature.systemData.experiencePoints ?? 0);
        stats.experienceLevel = expLevel.name;
      }

      if (dsa5Creature.systemData.species) {
        stats.species = dsa5Creature.systemData.species;
      }

      if (dsa5Creature.systemData.culture) {
        stats.culture = dsa5Creature.systemData.culture;
      }

      if (dsa5Creature.systemData.size) {
        stats.size = dsa5Creature.systemData.size;
      }

      if (dsa5Creature.systemData.lifePoints) {
        stats.lifePoints = dsa5Creature.systemData.lifePoints;
      }

      if (dsa5Creature.systemData.meleeDefense) {
        stats.meleeDefense = dsa5Creature.systemData.meleeDefense;
      }

      if (dsa5Creature.systemData.hasSpells) {
        stats.spellcaster = true;
      }

      if (Object.keys(stats).length > 0) {
        formatted.stats = stats;
      }
    }

    if (creature.img) {
      formatted.hasImage = true;
    }

    return formatted;
  }

  formatCreatureForDetails(creature: SystemCreatureIndex): any {
    const dsa5Creature = creature as DSA5CreatureIndex;
    const formatted = this.formatCreatureForList(creature);

    // Add additional details
    if (dsa5Creature.systemData) {
      const expLevel = getExperienceLevel(dsa5Creature.systemData.experiencePoints ?? 0);

      formatted.detailedStats = {
        level: dsa5Creature.systemData.level,
        experienceLevel: {
          name: expLevel.name,
          nameEn: expLevel.nameEn,
          level: expLevel.level,
          apRange: `${expLevel.min}-${expLevel.max === Infinity ? '∞' : expLevel.max}`,
        },
        experiencePoints: dsa5Creature.systemData.experiencePoints,
        species: dsa5Creature.systemData.species,
        culture: dsa5Creature.systemData.culture,
        profession: dsa5Creature.systemData.profession,
        size: dsa5Creature.systemData.size,
        lifePoints: dsa5Creature.systemData.lifePoints,
        meleeDefense: dsa5Creature.systemData.meleeDefense,
        rangedDefense: dsa5Creature.systemData.rangedDefense,
        armor: dsa5Creature.systemData.armor,
        hasSpells: dsa5Creature.systemData.hasSpells,
        hasAstralEnergy: dsa5Creature.systemData.hasAstralEnergy,
        hasKarmaEnergy: dsa5Creature.systemData.hasKarmaEnergy,
        traits: dsa5Creature.systemData.traits || [],
        rarity: dsa5Creature.systemData.rarity,
      };
    }

    if (creature.img) {
      formatted.img = creature.img;
    }

    return formatted;
  }

  describeFilters(filters: Record<string, any>): string {
    const validated = DSA5FiltersSchema.safeParse(filters);
    if (!validated.success) {
      return 'ungültige Filter';
    }

    return describeDSA5Filters(validated.data as DSA5Filters);
  }

  getPowerLevel(creature: SystemCreatureIndex): number | undefined {
    const dsa5Creature = creature as DSA5CreatureIndex;

    // DSA5: Use Experience Level (Erfahrungsgrad 1-7)
    if (dsa5Creature.systemData?.level !== undefined) {
      return dsa5Creature.systemData.level;
    }

    return undefined;
  }

  /**
   * Effective value of an Eigenschaft. The system derives `value` at runtime
   * (initial + advances + modifier + gear); source data only stores the parts.
   */
  private static characteristicValue(characteristic: any): number {
    if (typeof characteristic?.value === 'number') return characteristic.value;
    return (
      (characteristic?.initial ?? 8) +
      (characteristic?.advances ?? 0) +
      (characteristic?.modifier ?? 0)
    );
  }

  /**
   * A pool the actor has: its current points and derived maximum.
   * LeP, AsP and KaP all keep the current points in `value`; `current` is an
   * intermediate base value the system computes, not the current points.
   */
  private static pool(resource: any): { current: number; max: number } | undefined {
    if (!resource) return undefined;
    return { current: resource.value ?? 0, max: resource.max ?? 0 };
  }

  private static experience(system: any) {
    const total = system.details?.experience?.total ?? 0;
    const spent = system.details?.experience?.spent ?? 0;
    const grade = getExperienceLevel(total);
    return {
      total,
      spent,
      available: total - spent,
      level: grade.level,
      levelName: grade.name,
      levelNameEn: grade.nameEn,
    };
  }

  /** Magical / clerical tradition names, leaving out the empty defaults. */
  private static tradition(system: any): Record<string, string> {
    const tradition: Record<string, string> = {};
    for (const kind of ['magical', 'clerical'] as const) {
      const name = system.tradition?.[kind];
      if (typeof name === 'string' && name.trim()) tradition[kind] = name;
    }
    return tradition;
  }

  /**
   * Extract character statistics from actor data
   */
  extractCharacterStats(actorData: any): any {
    const system = actorData.system || {};
    const status = system.status || {};
    const stats: any = {};

    // Basic info
    stats.name = actorData.name;
    stats.type = actorData.type;

    // Experience and Erfahrungsgrad (creatures have no AP)
    if (system.details?.experience && actorData.type !== 'creature') {
      stats.experience = DSA5Adapter.experience(system);
    }

    // LeP (Lebensenergie): wounds.value is the current LeP, wounds.max the derived maximum
    const lifePoints = DSA5Adapter.pool(status.wounds);
    if (lifePoints) stats.lifePoints = lifePoints;

    // AsP / KaP, only for actors that have them
    const astral = DSA5Adapter.pool(status.astralenergy);
    if (astral && astral.max > 0) stats.astralEnergy = astral;

    const karma = DSA5Adapter.pool(status.karmaenergy);
    if (karma && karma.max > 0) stats.karmaEnergy = karma;

    // Schicksalspunkte: `value` is what is left, `max` is derived (falls back to the base)
    if (status.fatePoints) {
      stats.fatePoints = {
        current: status.fatePoints.value ?? 0,
        max: status.fatePoints.max ?? status.fatePoints.current ?? 0,
      };
    }

    // Eigenschaften (Characteristics: MU, KL, IN, CH, FF, GE, KO, KK)
    if (system.characteristics) {
      stats.characteristics = {};
      for (const [key, eigenschaft] of Object.entries(system.characteristics)) {
        const eigenschaftData = eigenschaft as any;
        const upperKey = key.toUpperCase();
        stats.characteristics[upperKey] = {
          value: DSA5Adapter.characteristicValue(eigenschaftData),
          initial: eigenschaftData.initial ?? 8,
          advances: eigenschaftData.advances ?? 0,
          name: EIGENSCHAFT_NAMES[upperKey]?.german,
          nameEn: EIGENSCHAFT_NAMES[upperKey]?.english,
        };
      }
    }

    // Derived values. Where the system computes a `max` (value + modifiers), that is
    // the number rolled against, so prefer it.
    const derived = (resource: any): number | undefined => {
      if (typeof resource === 'number') return resource;
      return resource?.max ?? resource?.value;
    };

    const initiative = status.initiative?.value ?? status.initiative;
    if (typeof initiative === 'number') stats.initiative = initiative;

    for (const [key, resource] of [
      ['speed', status.speed],
      ['dodge', status.dodge],
      ['soulPower', status.soulpower],
      ['toughness', status.toughness],
    ] as const) {
      const value = derived(resource);
      if (value !== undefined) stats[key] = value;
    }

    // Rüstungsschutz is derived from worn armor
    if (typeof system.totalArmor === 'number' && system.totalArmor > 0) {
      stats.armor = system.totalArmor;
    }

    // Identity info
    if (system.details) {
      const identity: any = {};

      const species = system.details.species?.value;
      if (species) {
        identity.species = species;
      }

      const culture = system.details.culture?.value;
      if (culture) {
        identity.culture = culture;
      }

      const career = system.details.career?.value;
      if (career) {
        identity.profession = career;
      }

      if (Object.keys(identity).length > 0) {
        stats.identity = identity;
      }
    }

    // Creatures describe themselves by class instead of species/culture/profession
    const creatureClass = system.creatureClass?.value;
    if (creatureClass) stats.creatureClass = creatureClass;

    // Size category (tiny, small, average, big, giant)
    const size = status.size?.value;
    if (size) {
      stats.size = size;
    }

    // Tradition (magical/clerical)
    const tradition = DSA5Adapter.tradition(system);
    if (Object.keys(tradition).length > 0) {
      stats.tradition = tradition;
    }

    // Spellcasting: the actor has AsP/KaP or a tradition
    const hasAstralEnergy = !!astral && astral.max > 0;
    const hasKarmaEnergy = !!karma && karma.max > 0;
    if (hasAstralEnergy || hasKarmaEnergy || Object.keys(tradition).length > 0) {
      stats.spellcasting = { hasSpells: true, hasAstralEnergy, hasKarmaEnergy };
    }

    // Talente and Kampftechniken are items on the actor
    const skills: Record<string, { value: number; check: string }> = {};
    const combatSkills: Record<string, number> = {};
    for (const item of Array.isArray(actorData.items) ? actorData.items : []) {
      const value = item?.system?.talentValue?.value;
      if (typeof value !== 'number') continue;
      if (item.type === 'combatskill') {
        // Every Kampftechnik starts at 6; only raised ones are worth listing.
        if (value > 6) combatSkills[item.name] = value;
      } else if (item.type === 'skill' && value > 0) {
        const check = [1, 2, 3]
          .map(index => String(item.system[`characteristic${index}`]?.value ?? '').toUpperCase())
          .filter(Boolean)
          .join('/');
        skills[item.name] = { value, check };
      }
    }
    // Only trained Talente are listed; every hero owns all of them at 0 (Kampftechniken at 6).
    if (Object.keys(skills).length > 0) stats.skills = skills;
    if (Object.keys(combatSkills).length > 0) stats.combatSkills = combatSkills;

    return stats;
  }

  /**
   * The values a GM looks at first: pools, Erfahrungsgrad, and who the actor is.
   */
  extractBasicInfo(actorData: any): any {
    const system = actorData.system || {};
    const status = system.status || {};
    const basicInfo: any = {};

    const lifePoints = DSA5Adapter.pool(status.wounds);
    if (lifePoints) basicInfo.lifePoints = lifePoints;

    const astral = DSA5Adapter.pool(status.astralenergy);
    if (astral && astral.max > 0) basicInfo.astralEnergy = astral;

    const karma = DSA5Adapter.pool(status.karmaenergy);
    if (karma && karma.max > 0) basicInfo.karmaEnergy = karma;

    if (status.fatePoints) {
      basicInfo.fatePoints = {
        current: status.fatePoints.value ?? 0,
        max: status.fatePoints.max ?? status.fatePoints.current ?? 0,
      };
    }

    if (system.details?.experience && actorData.type !== 'creature') {
      const experience = DSA5Adapter.experience(system);
      basicInfo.experienceLevel = experience.levelName;
      basicInfo.experienceLevelEn = experience.levelNameEn;
      basicInfo.adventurePoints = { total: experience.total, available: experience.available };
    }

    for (const [key, value] of [
      ['species', system.details?.species?.value],
      ['culture', system.details?.culture?.value],
      ['profession', system.details?.career?.value],
      ['creatureClass', system.creatureClass?.value],
      ['size', status.size?.value],
    ] as const) {
      if (value) basicInfo[key] = value;
    }

    return basicInfo;
  }

  describeActorSchema(): string {
    return [
      '=== DSA5 Actor Schema Reference ===',
      '',
      'ACTOR TYPES: character (Held), npc (NSC), creature (Tier/Kreatur)',
      '',
      'EIGENSCHAFTEN (characteristics) — system.characteristics.<mu|kl|in|ch|ff|ge|ko|kk>:',
      '  Stored parts: initial (default 8), advances, modifier, species. The effective value is',
      '  derived by the system: initial + advances + modifier (+ gear); there is no stored `value`.',
      '  Shorthand: { MU:13, KL:12, ... } (any case) sets the value: initial=13, advances=0.',
      '  Full:      { mu:{initial:8, advances:5}, ... } to keep purchased advances separate.',
      '',
      'LEBENSENERGIE / ENERGIE — system.status:',
      '  wounds.value = CURRENT LeP; astralenergy.value = current AsP; karmaenergy.value = current KaP.',
      '  The maxima are derived and cannot be written directly:',
      '    character/npc: LeP max = wounds.initial + 2×KO + wounds.advances + wounds.modifier',
      '                   AsP/KaP max = initial + guide characteristic × factor + advances + modifier',
      '    creature:      max = initial + advances + modifier',
      '  Shorthand: lifePoints / astralEnergy / karmaEnergy as a number or {current, max}.',
      '    `current` → <pool>.value. `max` → <pool>.initial for creatures; for character/npc LeP',
      '    it becomes wounds.initial = max − 2×KO when KO is in the same payload, and is',
      '    otherwise ignored (set wounds.initial / advances / modifier yourself).',
      '  fatePoints {current, max}: current → status.fatePoints.value, max → status.fatePoints.current.',
      '',
      'DETAILS — system.details:',
      '  species / culture / career take a string or {value}: { species:"Mensch", culture:"Mittelreich", profession:"Krieger" }',
      '  `profession` → details.career.value. socialstate is 0-5. experience: {total, spent}',
      '  (available AP = total − spent, derived).',
      '',
      'KAMPF / STATUS —',
      '  size: tiny | small | average | big | giant (medium/large/huge and German names are mapped)',
      '  speed → status.speed.initial (base GS).',
      '  initiative → status.initiative.current, the base INI of a creature (heroes derive INI from MU and GE).',
      '  dodge is always derived (GE / 2 + status.dodge.modifier); a `dodge` number is turned into that',
      '  modifier on create, and on update when GE is in the same payload.',
      '  soulpower / toughness → status.<key>.value for creatures; derived for character/npc, where only',
      '  status.<key>.initial or .modifier have an effect.',
      '  Rüstungsschutz is derived from equipped armor items; there is no armor field on the actor.',
      '  tradition → system.tradition {magical, clerical}; guidevalue {magical, clerical} names the',
      '  Leiteigenschaft (mu…kk) that AsP/KaP are computed from.',
      '',
      'ITEMS: skill (Talent), combatskill, spell, liturgy, ritual, ceremony, advantage, disadvantage,',
      '  specialability, meleeweapon, rangeweapon, armor, equipment, trait (creatures), …',
      '  Talent / Kampftechnik values live on the item: system.talentValue.value.',
    ].join('\n');
  }

  // ─────────────────────────────────────────────────────────────────────────
  // normalizePayload – map caller-friendly DSA5 shorthands onto the fields the
  // DSA5 data model actually stores. Receives ONLY the `system` sub-object and
  // returns a normalised `system` object. Unknown keys are left untouched.
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Valid Eigenschaft keys in lowercase (the canonical Foundry form).
   */
  private static readonly EIGENSCHAFT_KEYS = [
    'mu',
    'kl',
    'in',
    'ch',
    'ff',
    'ge',
    'ko',
    'kk',
  ] as const;

  /**
   * Normalise one Eigenschaft to the stored parts.
   *   - naked number n (or {value: n} alone) → { initial: n, advances: 0 }, so the
   *     derived value becomes n
   *   - an object with initial / advances / modifier / species is passed through
   * `value` itself is never written: the data model has no such field.
   */
  private normalizeEigenschaft(raw: any): Record<string, number> | undefined {
    if (typeof raw === 'number') {
      return { initial: raw, advances: 0 };
    }
    if (raw && typeof raw === 'object') {
      const result: Record<string, number> = {};
      for (const part of ['initial', 'advances', 'modifier', 'species'] as const) {
        if (typeof raw[part] === 'number') result[part] = raw[part];
      }
      if (typeof raw.value === 'number') {
        // `value` names the wanted effective value; express it through the stored parts.
        if (result.initial === undefined) {
          if (result.advances === undefined) return { ...result, initial: raw.value, advances: 0 };
        } else if (result.advances === undefined) {
          result.advances = raw.value - result.initial;
        }
      }
      return Object.keys(result).length > 0 ? result : undefined;
    }
    return undefined;
  }

  /**
   * Normalise a pool shorthand (LeP / AsP / KaP): a number, or {current|value, max}.
   * Current points go to `value`. The maximum is derived by the system, so `max` can
   * only be expressed through `initial`:
   *   - creatures: max = initial (+ advances + modifier)
   *   - character / npc LeP: max = initial + 2×KO (+ …), solvable when KO is known
   */
  private normalizePool(
    raw: any,
    options: { isCreature: boolean; isNew: boolean; perKo?: number | undefined }
  ): Record<string, number> | undefined {
    if (raw === undefined || raw === null) return undefined;
    const source = typeof raw === 'number' ? { current: raw, max: raw } : raw;
    if (typeof source !== 'object') return undefined;

    const result: Record<string, number> = {};
    const current = source.current ?? source.value;
    const max = source.max;

    if (typeof max === 'number') {
      if (options.isCreature) result.initial = max;
      else if (options.perKo !== undefined) result.initial = max - options.perKo;
    }
    if (typeof current === 'number') result.value = current;
    else if (typeof max === 'number' && options.isNew) result.value = max; // start at full points

    for (const part of ['initial', 'advances', 'modifier'] as const) {
      if (typeof source[part] === 'number') result[part] = source[part];
    }
    return Object.keys(result).length > 0 ? result : undefined;
  }

  /**
   * Helper: normalise a detail field that may arrive as a string or {value}.
   * Always returns {value: string}.
   */
  private normalizeDetail(raw: any): { value: string } | undefined {
    if (raw === undefined || raw === null) return undefined;
    if (typeof raw === 'string') return { value: raw };
    if (typeof raw === 'object' && raw.value !== undefined) {
      return { value: String(raw.value) };
    }
    return undefined;
  }

  /**
   * Deep-merge helper: copy values from `src` into `dst` for keys that exist
   * in `src`, creating intermediate objects as needed.  Does not overwrite
   * keys that already exist in `dst` with higher priority — src wins for
   * keys it explicitly provides.
   */
  private static mergeInto(dst: Record<string, any>, src: Record<string, any> | undefined): void {
    if (!src) return;
    for (const [key, val] of Object.entries(src)) {
      if (val && typeof val === 'object' && !Array.isArray(val)) {
        if (typeof dst[key] !== 'object' || dst[key] === null || Array.isArray(dst[key])) {
          dst[key] = {};
        }
        DSA5Adapter.mergeInto(dst[key], val);
      } else {
        dst[key] = val;
      }
    }
  }

  normalizePayload(
    system: Record<string, any>,
    context?: { actorType?: string | undefined; isNew?: boolean | undefined }
  ): Record<string, any> {
    // Collect changes in a separate object and merge at the end to avoid
    // intermediate corruption.
    const out: Record<string, any> = {};
    const status: Record<string, any> = {};
    const isCreature = context?.actorType === 'creature';

    // ── 1. Eigenschaften (characteristics) ──────────────────────────────
    // Accept MU/KL/... (uppercase) or mu/kl/... (lowercase) keys.
    const charSource = system.characteristics ?? system.eigenschaften;
    if (charSource && typeof charSource === 'object') {
      const normalized: Record<string, any> = {};
      for (const [key, raw] of Object.entries(charSource)) {
        const lower = key.toLowerCase();
        if (!DSA5Adapter.EIGENSCHAFT_KEYS.includes(lower as any)) continue;
        const eigenschaft = this.normalizeEigenschaft(raw);
        if (eigenschaft) normalized[lower] = eigenschaft;
      }
      // Replace the caller's block: uppercase keys and `value` are not part of the model.
      system.characteristics = {};
      delete system.eigenschaften;
      if (Object.keys(normalized).length > 0) {
        out.characteristics = normalized;
      }
    }

    // ── 2. LeP / AsP / KaP (the current points live in `<pool>.value`) ──
    // Hero LeP = wounds.initial + 2×KO, so a wanted maximum needs KO: from the payload,
    // or the model's default of 8 on a new actor.
    const ko = out.characteristics?.ko;
    const koValue =
      typeof ko?.initial === 'number'
        ? ko.initial + (ko.advances ?? 0)
        : context?.isNew
          ? 8
          : undefined;

    for (const [target, shorthand, perKo] of [
      ['wounds', 'lifePoints', koValue === undefined ? undefined : koValue * 2],
      ['astralenergy', 'astralEnergy', undefined],
      ['karmaenergy', 'karmaEnergy', undefined],
    ] as const) {
      const explicit = system.status?.[target];
      // A block under the real key that names `current` or `max` is a shorthand as well:
      // both are derived by the system and writing them has no effect.
      const explicitShorthand =
        explicit && typeof explicit === 'object' && ('current' in explicit || 'max' in explicit)
          ? { ...explicit }
          : undefined;
      // Real fields the caller set explicitly win over the top-level shorthand.
      if (explicit && !explicitShorthand) continue;

      const raw = explicitShorthand ?? system[shorthand] ?? system.status?.[shorthand];
      const pool = this.normalizePool(raw, { isCreature, isNew: !!context?.isNew, perKo });
      if (explicitShorthand) {
        delete explicit.current;
        delete explicit.max;
      }
      if (pool) status[target] = pool;
    }

    // ── 3. Schicksalspunkte ─────────────────────────────────────────────
    const fate = system.fatePoints ?? system.status?.fatePoints;
    if (typeof fate === 'number') {
      status.fatePoints = { value: fate };
    } else if (fate && typeof fate === 'object' && system.fatePoints) {
      // Shorthand {current, max}: `value` is what is left, `current` the base maximum.
      const fatePoints: Record<string, number> = {};
      const left = fate.current ?? fate.value;
      if (typeof left === 'number') fatePoints.value = left;
      if (typeof fate.max === 'number') fatePoints.current = fate.max;
      if (Object.keys(fatePoints).length > 0) status.fatePoints = fatePoints;
    }

    // ── 4. Details (species / culture / career / socialstate / experience) ─
    const details: Record<string, any> = {};

    // Direct system.details.* (may already be correct or use string shorthand)
    const srcDetails = system.details;
    const species = this.normalizeDetail(
      srcDetails?.species ?? system.species ?? system.identity?.species
    );
    if (species) details.species = species;

    const culture = this.normalizeDetail(
      srcDetails?.culture ?? system.culture ?? system.identity?.culture
    );
    if (culture) details.culture = culture;

    // career — accept career, profession, or identity.profession
    const career = this.normalizeDetail(
      srcDetails?.career ??
        srcDetails?.profession ??
        system.career ??
        system.profession ??
        system.identity?.profession
    );
    if (career) details.career = career;

    // Social status is a number 0-5; a name is left for the system's own migration.
    const social = srcDetails?.socialstate ?? system.socialstate;
    const socialValue = social && typeof social === 'object' ? social.value : social;
    if (socialValue !== undefined && socialValue !== null) {
      const numeric = Number(socialValue);
      details.socialstate = {
        value: socialValue !== '' && Number.isFinite(numeric) ? numeric : socialValue,
      };
    }

    // Experience (AP): available = total − spent is derived
    const exp = srcDetails?.experience ?? system.experience;
    if (exp && typeof exp === 'object') {
      const experience: Record<string, number> = {};
      if (exp.total !== undefined) experience.total = exp.total;
      if (exp.spent !== undefined) experience.spent = exp.spent;
      else if (exp.total !== undefined && exp.available !== undefined) {
        experience.spent = exp.total - exp.available;
      }
      if (srcDetails?.experience) delete srcDetails.experience.available;
      if (Object.keys(experience).length > 0) details.experience = experience;
    }

    if (Object.keys(details).length > 0) {
      out.details = details;
    }

    // ── 5. Status / Kampf values ────────────────────────────────────────
    // Speed: the stored base is `initial`; `value` is derived from it.
    const speed = system.speed ?? system.status?.speed;
    if (typeof speed === 'number') status.speed = { initial: speed };

    // Initiative: creatures store their base in `current`; heroes derive it from MU and GE,
    // where the field is unused.
    const initiative = system.initiative ?? system.status?.initiative;
    if (typeof initiative === 'number') status.initiative = { current: initiative };

    // Ausweichen is derived from GE for every actor type (GE / 2 + modifier), so a wanted
    // total can only be reached through the modifier, and only when GE is known.
    const dodge = system.dodge ?? system.status?.dodge;
    if (typeof dodge === 'number') {
      const ge = out.characteristics?.ge;
      const geValue =
        typeof ge?.initial === 'number'
          ? ge.initial + (ge.advances ?? 0)
          : context?.isNew
            ? 8 // the model's default for an Eigenschaft the payload doesn't set
            : undefined;
      if (geValue !== undefined) status.dodge = { modifier: dodge - Math.round(geValue / 2) };
    }

    // Seelenkraft / Zähigkeit: plain values on creatures; derived for heroes, where a
    // written `value` is recomputed by the system.
    for (const key of ['soulpower', 'toughness'] as const) {
      const raw = system[key] ?? system.status?.[key];
      if (typeof raw === 'number') status[key] = { value: raw };
    }

    const size = system.size ?? system.status?.size;
    const sizeValue = size && typeof size === 'object' ? size.value : size;
    if (typeof sizeValue === 'string') {
      const category = SIZE_CATEGORY_ALIASES[sizeValue.trim().toLowerCase()];
      status.size = { value: category ?? sizeValue };
    }

    if (Object.keys(status).length > 0) {
      out.status = status;
    }

    // ── 6. Tradition ────────────────────────────────────────────────────
    if (system.tradition) {
      out.tradition = system.tradition;
    }

    // Top-level shorthands have been mapped onto their real paths; drop them so the
    // update doesn't carry keys the data model doesn't know.
    for (const key of [
      'lifePoints',
      'astralEnergy',
      'karmaEnergy',
      'fatePoints',
      'species',
      'culture',
      'career',
      'profession',
      'identity',
      'socialstate',
      'experience',
      'initiative',
      'speed',
      'dodge',
      'soulpower',
      'toughness',
      'size',
    ]) {
      delete system[key];
    }
    if (system.status) {
      for (const key of ['lifePoints', 'astralEnergy', 'karmaEnergy']) delete system.status[key];
      for (const key of ['initiative', 'speed', 'dodge', 'soulpower', 'toughness']) {
        if (typeof system.status[key] === 'number') delete system.status[key];
      }
      if (typeof system.status.size === 'string') delete system.status.size;
    }
    if (system.details) {
      delete system.details.profession;
      for (const key of ['species', 'culture', 'career']) {
        if (typeof system.details[key] === 'string') delete system.details[key];
      }
    }

    // ── Merge normalised paths back into the original system object ──────
    DSA5Adapter.mergeInto(system, out);

    return system;
  }
}
