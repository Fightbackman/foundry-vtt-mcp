/**
 * DSA5 combat view sent with get-character.
 *
 * The values come from the system's own sheet preparation (`actor.prepareSheet`),
 * `Actordsa5.armorValue` and `DSA5Payment._actorsMoney`; these tests stub those with the
 * shapes they return in DSA5 8.x and check what is picked out of them.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildDSA5CombatSummary } from './dsa5-combat.js';
import { dsa5EquipmentFields } from './dsa5-items.js';

const coin = (name: string, quantity: number, price: number) => ({
  name,
  type: 'money',
  system: { quantity: { value: quantity }, price: { value: price } },
});

function stubSystem(options: { armorValue?: number; coins?: any[] } = {}) {
  const coins = options.coins ?? [
    coin('Dukaten', 3, 10),
    coin('Silber', 5, 1),
    coin('Heller', 0, 0.1),
  ];
  vi.stubGlobal('game', {
    system: { id: 'dsa5' },
    dsa5: {
      entities: { Actordsa5: { armorValue: vi.fn(() => ({ armor: options.armorValue ?? 4 })) } },
      apps: {
        RuleChaos: { isShield: (item: any) => item.system.combatskill.value === 'Schilde' },
        DSA5Payment: {
          _actorsMoney: vi.fn(() => ({
            money: coins,
            sum: coins.reduce((t, c) => t + c.system.quantity.value * c.system.price.value, 0),
          })),
        },
      },
    },
  });
}

// What prepareSheet returns for a hero with sword, shield, bow and chain mail (trimmed).
const heroSheet = () => ({
  armorSum: 4,
  spellArmor: 0,
  liturgyArmor: 0,
  brawling: { attack: 7, parry: 5 },
  wornArmor: [
    {
      _id: 'arm1',
      name: 'Kettenhemd',
      system: { protection: { value: 4 }, encumbrance: { value: 2 }, calculatedEncumbrance: 2 },
    },
  ],
  wornMeleeWeapons: [
    {
      _id: 'sh1',
      name: 'Holzschild',
      attack: 4,
      parry: 8,
      damagedie: '1d6',
      damageAdd: '',
      wieldedTwoHand: false,
      system: {
        combatskill: { value: 'Schilde' },
        reach: { value: 'short' },
        worn: { value: true, offHand: true },
      },
    },
    {
      _id: 'sw1',
      name: 'Langschwert',
      attack: 11,
      parry: 7,
      damagedie: '1d6',
      damageAdd: '+4',
      wieldedTwoHand: false,
      system: {
        combatskill: { value: 'Schwerter' },
        reach: { value: 'medium' },
        worn: { value: true, offHand: false },
      },
    },
    {
      // no matching combat skill: the system returns the item without attack / parry
      _id: 'x1',
      name: 'Seltsame Waffe',
      system: {
        combatskill: { value: 'Unbekannt' },
        damage: { value: '1d6+2' },
        reach: { value: 'medium' },
        worn: { value: true },
      },
    },
  ],
  wornRangedWeapons: [
    {
      _id: 'bow1',
      name: 'Kurzbogen',
      attack: 9,
      damagedie: '1d6',
      damageAdd: '+5',
      calculatedRange: '10/50/80',
      LZ: 1,
      ammo: [{ _id: 'am1', name: 'Kriegspfeile', system: { quantity: { value: 20 } } }],
      system: {
        combatskill: { value: 'Bögen' },
        reach: { value: '10/50/80' },
        currentAmmo: { value: 'am1' },
        worn: { value: true },
      },
    },
  ],
  traits: { meleeAttack: [], rangeAttack: [], armor: [] },
});

const hero = (sheet: any = heroSheet()) => ({
  type: 'character',
  system: {
    condition: { encumbered: 2 },
    armorEncumbrance: 2,
    totalWeight: 4.5,
    carrycapacity: 30,
  },
  prepareSheet: vi.fn(() => sheet),
});

describe('buildDSA5CombatSummary', () => {
  beforeEach(() => stubSystem());
  afterEach(() => vi.unstubAllGlobals());

  it('reports armor, Belastung and worn weapons as the sheet computes them', () => {
    const actor = hero();
    const summary = buildDSA5CombatSummary(actor)!;

    expect(actor.prepareSheet).toHaveBeenCalledWith({ details: [] });
    expect(summary.armor).toEqual({
      protection: 4,
      worn: [{ id: 'arm1', name: 'Kettenhemd', protection: 4, encumbrance: 2 }],
    });
    expect(summary.encumbrance).toEqual({
      level: 2,
      fromArmor: 2,
      carriedWeight: 4.5,
      carryCapacity: 30,
    });
    expect(summary.brawling).toEqual({ attack: 7, parry: 5 });
    expect(summary.meleeWeapons).toEqual([
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
      {
        id: 'sw1',
        name: 'Langschwert',
        combatSkill: 'Schwerter',
        attack: 11,
        parry: 7,
        damage: '1d6+4',
        reach: 'medium',
      },
      {
        id: 'x1',
        name: 'Seltsame Waffe',
        combatSkill: 'Unbekannt',
        damage: '1d6+2',
        reach: 'medium',
        combatSkillMissing: true,
      },
    ]);
    expect(summary.rangedWeapons).toEqual([
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
    ]);
    expect(summary.traitAttacks).toEqual([]);
  });

  it('reports the currency total and the coins carried', () => {
    expect(buildDSA5CombatSummary(hero())!.money).toEqual({
      total: 35,
      coins: [
        { name: 'Dukaten', quantity: 3, value: 10 },
        { name: 'Silber', quantity: 5, value: 1 },
      ],
    });
  });

  it("uses armorValue, which also counts a creature's armor traits", () => {
    stubSystem({ armorValue: 2, coins: [] });
    const wolfSheet = {
      armorSum: 0,
      brawling: { attack: 0, parry: 0 },
      wornArmor: [],
      wornMeleeWeapons: [],
      wornRangedWeapons: [],
      traits: {
        meleeAttack: [
          {
            _id: 't1',
            name: 'Biss',
            attack: 12,
            damagedie: '1d6',
            damageAdd: '+3',
            system: { reach: { value: 'short' } },
          },
          {
            _id: 't2',
            name: 'Krallen',
            attack: 10,
            parry: 6,
            damagedie: '1d6',
            damageAdd: '+1',
            system: { reach: { value: 'short' } },
          },
        ],
        rangeAttack: [
          {
            _id: 't3',
            name: 'Stachelschuss',
            attack: 9,
            LZ: 2,
            damagedie: '1d6',
            damageAdd: '+2',
            system: { reach: { value: '5/10/20' } },
          },
        ],
      },
    };
    const wolf = { type: 'creature', system: { condition: {} }, prepareSheet: () => wolfSheet };
    const summary = buildDSA5CombatSummary(wolf)!;

    expect(summary.armor.protection).toBe(2);
    expect(summary.brawling).toBeUndefined();
    expect(summary.money).toBeUndefined();
    expect(summary.traitAttacks).toEqual([
      { id: 't1', name: 'Biss', kind: 'melee', attack: 12, damage: '1d6+3', reach: 'short' },
      {
        id: 't2',
        name: 'Krallen',
        kind: 'melee',
        attack: 10,
        parry: 6,
        damage: '1d6+1',
        reach: 'short',
      },
      {
        id: 't3',
        name: 'Stachelschuss',
        kind: 'ranged',
        attack: 9,
        damage: '1d6+2',
        reach: '5/10/20',
        reloadTime: 2,
      },
    ]);
  });

  it('leaves vehicles, groups and failing preparations out', () => {
    expect(buildDSA5CombatSummary({ type: 'vehicle', prepareSheet: vi.fn() })).toBeUndefined();
    expect(buildDSA5CombatSummary({ type: 'group', prepareSheet: vi.fn() })).toBeUndefined();
    expect(buildDSA5CombatSummary({ type: 'character' })).toBeUndefined();
    const broken = {
      type: 'character',
      prepareSheet: () => {
        throw new Error('boom');
      },
    };
    expect(buildDSA5CombatSummary(broken)).toBeUndefined();
  });
});

describe('dsa5EquipmentFields', () => {
  it('reads quantity.value and worn.value for weapons and armor', () => {
    expect(
      dsa5EquipmentFields({
        type: 'armor',
        system: { quantity: { value: 1 }, worn: { value: true } },
      })
    ).toEqual({ quantity: 1, equipped: true });
    expect(
      dsa5EquipmentFields({
        type: 'meleeweapon',
        system: { quantity: { value: 2 }, worn: { value: false } },
      })
    ).toEqual({ quantity: 2, equipped: false });
  });

  it('reports no worn state for items that cannot be worn', () => {
    expect(
      dsa5EquipmentFields({ type: 'ammunition', system: { quantity: { value: 20 } } })
    ).toEqual({ quantity: 20 });
    expect(
      dsa5EquipmentFields({
        type: 'equipment',
        system: { quantity: { value: 1 }, worn: { value: false, wearable: false } },
      })
    ).toEqual({ quantity: 1 });
    expect(
      dsa5EquipmentFields({
        type: 'equipment',
        system: { quantity: { value: 1 }, worn: { value: true, wearable: true } },
      })
    ).toEqual({ quantity: 1, equipped: true });
  });

  it('ignores non-equipment items', () => {
    expect(dsa5EquipmentFields({ type: 'skill', system: {} })).toBeUndefined();
  });
});
