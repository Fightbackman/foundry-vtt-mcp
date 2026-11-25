/**
 * Tests for how the DSA5 adapter reads an actor.
 *
 * The fixtures mirror what the bridge sends for a DSA5 8.x actor: the prepared
 * `system` data (with the values the system derives) and the actor's items.
 */

import { describe, it, expect } from 'vitest';
import { DSA5Adapter } from './adapter.js';
import { EXPERIENCE_LEVELS, getExperienceLevel } from './constants.js';

const adapter = new DSA5Adapter();

const characteristic = (initial: number, advances = 0) => ({
  initial,
  advances,
  species: 0,
  modifier: 0,
  gearmodifier: 0,
  value: initial + advances,
});

const hero = {
  name: 'Alrike',
  type: 'character',
  system: {
    characteristics: {
      mu: characteristic(8, 4),
      kl: characteristic(8),
      in: characteristic(8),
      ch: characteristic(8),
      ff: characteristic(8),
      ge: characteristic(8),
      ko: characteristic(8, 3),
      kk: characteristic(8),
    },
    status: {
      // `current` is the derived base (initial + 2×KO), not the current LeP
      wounds: { initial: 0, value: 20, advances: 0, modifier: 0, current: 22, max: 22 },
      astralenergy: { initial: 0, value: 0, current: 0, max: 0 },
      karmaenergy: { initial: 0, value: 0, current: 0, max: 0 },
      fatePoints: { value: 2, modifier: 0, current: 3, max: 3 },
      soulpower: { initial: 0, value: 5, modifier: 1, max: 6 },
      toughness: { initial: 0, value: 5, modifier: 0, max: 5 },
      dodge: { value: 4, modifier: 1, max: 5 },
      speed: { initial: 8, value: 0, max: 8 },
      initiative: { value: 10.1, current: 0 },
      size: { value: 'average' },
    },
    details: {
      species: { value: 'Mensch' },
      culture: { value: 'Mittelreich' },
      career: { value: 'Kriegerin' },
      experience: { total: 1250, spent: 1100, current: 150 },
    },
    totalArmor: 3,
    tradition: { magical: '', clerical: '' },
  },
  items: [
    {
      name: 'Geography',
      type: 'skill',
      system: {
        talentValue: { value: 7 },
        characteristic1: { value: 'kl' },
        characteristic2: { value: 'kl' },
        characteristic3: { value: 'in' },
      },
    },
    { name: 'Climbing', type: 'skill', system: { talentValue: { value: 0 } } },
    { name: 'Swords', type: 'combatskill', system: { talentValue: { value: 12 } } },
    { name: 'Bows', type: 'combatskill', system: { talentValue: { value: 6 } } },
    { name: 'Sword', type: 'meleeweapon', system: {} },
  ],
};

describe('getExperienceLevel', () => {
  it("uses the system's AP thresholds", () => {
    const names = (ap: number) => getExperienceLevel(ap).name;
    expect(names(0)).toBe('Unerfahren');
    expect(names(999)).toBe('Unerfahren');
    expect(names(1000)).toBe('Durchschnittlich');
    expect(names(1100)).toBe('Erfahren');
    expect(names(1200)).toBe('Kompetent');
    expect(names(1399)).toBe('Kompetent');
    expect(names(1400)).toBe('Meisterlich');
    expect(names(1700)).toBe('Brillant');
    expect(names(2100)).toBe('Legendär');
    expect(names(99999)).toBe('Legendär');
  });

  it('has contiguous ranges numbered 1-7', () => {
    EXPERIENCE_LEVELS.forEach((level, index) => {
      expect(level.level).toBe(index + 1);
      if (index > 0) expect(level.min).toBe(EXPERIENCE_LEVELS[index - 1].max + 1);
    });
  });
});

describe('DSA5Adapter.extractCharacterStats', () => {
  const stats = adapter.extractCharacterStats(hero);

  it('reads the current LeP from wounds.value', () => {
    expect(stats.lifePoints).toEqual({ current: 20, max: 22 });
  });

  it('reports the Erfahrungsgrad for the total AP', () => {
    expect(stats.experience).toEqual({
      total: 1250,
      spent: 1100,
      available: 150,
      level: 4,
      levelName: 'Kompetent',
      levelNameEn: 'Competent',
    });
  });

  it('reports the derived Eigenschaft values with their names', () => {
    expect(stats.characteristics.MU).toEqual({
      value: 12,
      initial: 8,
      advances: 4,
      name: 'Mut',
      nameEn: 'Courage',
    });
    expect(Object.keys(stats.characteristics)).toHaveLength(8);
  });

  it('falls back to the stored parts when the value is not derived yet', () => {
    const source = structuredClone(hero);
    delete (source.system.characteristics.mu as any).value;
    expect(adapter.extractCharacterStats(source).characteristics.MU.value).toBe(12);
  });

  it('reports the derived totals including modifiers', () => {
    expect(stats.soulPower).toBe(6);
    expect(stats.toughness).toBe(5);
    expect(stats.dodge).toBe(5);
    expect(stats.speed).toBe(8);
    expect(stats.initiative).toBe(10.1);
    expect(stats.armor).toBe(3);
    expect(stats.fatePoints).toEqual({ current: 2, max: 3 });
  });

  it('leaves out pools and spellcasting the actor does not have', () => {
    expect(stats.astralEnergy).toBeUndefined();
    expect(stats.karmaEnergy).toBeUndefined();
    expect(stats.tradition).toBeUndefined();
    expect(stats.spellcasting).toBeUndefined();
  });

  it('reads the tradition from the Tradition special ability on DSA5 8.2', () => {
    const priest = structuredClone(hero) as any;
    delete priest.system.tradition;
    priest.items = [
      ...priest.items,
      {
        name: 'Tradition (Praioskirche)',
        type: 'specialability',
        system: { isTradition: true, category: { value: 'clerical' }, guidevalue: 'kl' },
      },
      // Two magical traditions: ambiguous, so the system (and we) ignore them.
      ...['A', 'B'].map(name => ({
        name,
        type: 'specialability',
        system: { isTradition: true, category: { value: 'magical' } },
      })),
      {
        name: 'Not a tradition',
        type: 'specialability',
        system: { category: { value: 'magical' } },
      },
    ];
    const priestStats = adapter.extractCharacterStats(priest);
    expect(priestStats.tradition).toEqual({ clerical: 'Tradition (Praioskirche)' });
    expect(priestStats.spellcasting).toMatchObject({ hasSpells: true });
  });

  it('reports AsP and tradition for a spellcaster', () => {
    const mage = structuredClone(hero);
    mage.system.status.astralenergy = { initial: 20, value: 17, current: 34, max: 34 };
    mage.system.tradition.magical = 'Gildenmagier';
    const mageStats = adapter.extractCharacterStats(mage);
    expect(mageStats.astralEnergy).toEqual({ current: 17, max: 34 });
    expect(mageStats.tradition).toEqual({ magical: 'Gildenmagier' });
    expect(mageStats.spellcasting).toEqual({
      hasSpells: true,
      hasAstralEnergy: true,
      hasKarmaEnergy: false,
    });
  });

  it('lists trained Talente with their check and raised Kampftechniken', () => {
    expect(stats.skills).toEqual({ Geography: { value: 7, check: 'KL/KL/IN' } });
    expect(stats.combatSkills).toEqual({ Swords: 12 });
  });

  it('reads identity and size', () => {
    expect(stats.identity).toEqual({
      species: 'Mensch',
      culture: 'Mittelreich',
      profession: 'Kriegerin',
    });
    expect(stats.size).toBe('average');
  });

  it('describes a creature by its class', () => {
    const wolf = {
      name: 'Wolf',
      type: 'creature',
      system: {
        status: { wounds: { initial: 18, value: 18, current: 18, max: 18 } },
        creatureClass: { value: 'Tier, nicht humanoid' },
      },
    };
    const wolfStats = adapter.extractCharacterStats(wolf);
    expect(wolfStats.lifePoints).toEqual({ current: 18, max: 18 });
    expect(wolfStats.creatureClass).toBe('Tier, nicht humanoid');
    expect(wolfStats.experience).toBeUndefined();
  });
});

describe('DSA5Adapter combat view', () => {
  // What the bridge computes with the system's sheet code (dsa5Combat)
  const dsa5Combat = {
    armor: {
      protection: 4,
      worn: [{ id: 'arm1', name: 'Kettenhemd', protection: 4, encumbrance: 2 }],
    },
    encumbrance: { level: 2, fromArmor: 2, carriedWeight: 4.5, carryCapacity: 30 },
    brawling: { attack: 7, parry: 5 },
    meleeWeapons: [
      {
        id: 'sh1',
        name: 'Holzschild',
        combatSkill: 'Schilde',
        attack: 4,
        parry: 8,
        damage: '1d6',
        reach: 'short',
        shield: true,
        offHand: true,
      },
    ],
    rangedWeapons: [
      {
        id: 'bow1',
        name: 'Kurzbogen',
        combatSkill: 'Bögen',
        attack: 9,
        damage: '1d6+5',
        range: '10/50/80',
        reloadTime: 1,
        ammunition: { name: 'Kriegspfeile', quantity: 20 },
      },
    ],
    traitAttacks: [],
    money: {
      total: 35.79,
      coins: [
        { name: 'Dukaten', quantity: 3, value: 10 },
        { name: 'Kreuzer', quantity: 9, value: 0.01 },
      ],
    },
  };
  const armed = { ...structuredClone(hero), dsa5Combat };

  it('reports Rüstungsschutz, Belastung, weapons and money from dsa5Combat', () => {
    const stats = adapter.extractCharacterStats(armed);
    expect(stats.armor).toBe(4);
    expect(stats.encumbrance).toBe(2);
    expect(stats.combat.armor).toEqual(dsa5Combat.armor);
    expect(stats.combat.encumbrance).toEqual(dsa5Combat.encumbrance);
    expect(stats.combat.meleeWeapons).toEqual(dsa5Combat.meleeWeapons);
    expect(stats.combat.rangedWeapons).toEqual(dsa5Combat.rangedWeapons);
    expect(stats.combat.brawling).toEqual({ attack: 7, parry: 5 });
    expect(stats.combat.naturalAttacks).toBeUndefined();
    expect(stats.money).toEqual({
      total: 35.79,
      unit: 'Silbertaler',
      coins: { Dukaten: 3, Kreuzer: 9 },
    });
  });

  it("lists a creature's natural attacks", () => {
    const wolf = {
      name: 'Wolf',
      type: 'creature',
      system: { status: {} },
      dsa5Combat: {
        armor: { protection: 2, worn: [] },
        encumbrance: { level: 0, fromArmor: 0 },
        meleeWeapons: [],
        rangedWeapons: [],
        traitAttacks: [
          { id: 't1', name: 'Biss', kind: 'melee', attack: 12, damage: '1d6+3', reach: 'short' },
        ],
      },
    };
    const stats = adapter.extractCharacterStats(wolf);
    expect(stats.armor).toBe(2);
    expect(stats.combat.armor).toEqual({ protection: 2 });
    expect(stats.combat.naturalAttacks).toEqual(wolf.dsa5Combat.traitAttacks);
    expect(stats.money).toBeUndefined();
  });

  it('adds Rüstungsschutz and Belastung to basicInfo', () => {
    expect(adapter.extractBasicInfo(armed)).toMatchObject({ armor: 4, encumbrance: 2 });
  });

  it('estimates Rüstungsschutz from worn armor when the bridge sends no combat view', () => {
    const older = structuredClone(hero);
    older.system.totalArmor = 0;
    older.items.push(
      {
        name: 'Kettenhemd',
        type: 'armor',
        system: { worn: { value: true }, protection: { value: 4 } },
      } as any,
      {
        name: 'Leder',
        type: 'armor',
        system: { worn: { value: false }, protection: { value: 3 } },
      } as any,
      {
        name: 'Fell',
        type: 'trait',
        system: { traitType: { value: 'armor' }, at: { value: '1' } },
      } as any
    );
    const stats = adapter.extractCharacterStats(older);
    expect(stats.armor).toBe(5);
    expect(stats.combat).toBeUndefined();
  });
});

describe('DSA5Adapter.extractBasicInfo', () => {
  it('summarises pools, Erfahrungsgrad and identity', () => {
    expect(adapter.extractBasicInfo(hero)).toEqual({
      lifePoints: { current: 20, max: 22 },
      fatePoints: { current: 2, max: 3 },
      experienceLevel: 'Kompetent',
      experienceLevelEn: 'Competent',
      adventurePoints: { total: 1250, available: 150 },
      species: 'Mensch',
      culture: 'Mittelreich',
      profession: 'Kriegerin',
      size: 'average',
    });
  });

  it('copes with an actor that has no system data', () => {
    expect(adapter.extractBasicInfo({ name: 'Empty', type: 'npc' })).toEqual({});
  });
});

describe('DSA5Adapter.describeActorSchema', () => {
  it('points callers at the stored fields, not the derived ones', () => {
    const text = adapter.describeActorSchema();
    expect(text).toContain('wounds.value = CURRENT LeP');
    expect(text).not.toContain('wounds.current');
    expect(text).not.toContain('status.armour');
  });
});
