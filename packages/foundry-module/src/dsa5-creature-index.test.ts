/**
 * DSA5 enhanced creature index: what is read from a compendium actor, how the
 * `list-creatures-by-criteria` filters apply to it, and what a result looks like.
 *
 * The actor fixtures mirror prepared DSA5 8.x actors: stored fields plus the values
 * the system derives (`wounds.max`, `dodge.max`, `totalArmor`, …).
 */

import { describe, expect, it } from 'vitest';
import {
  extractDSA5Creature,
  formatDSA5CreatureResult,
  normalizeDSA5Size,
  passesDSA5Criteria,
  type DSA5CreatureIndex,
} from './dsa5-creature-index.js';

const pack = {
  collection: 'world.bestiary',
  metadata: { id: 'world.bestiary', label: 'Bestiary' },
};

const wolfDoc = {
  id: 'wolf1',
  name: 'Grauwolf',
  type: 'creature',
  img: 'wolf.webp',
  system: {
    creatureClass: { value: ' Tier, nicht humanoid ' },
    totalArmor: 1,
    status: {
      wounds: { initial: 18, value: 12, max: 18 },
      astralenergy: { max: 0 },
      karmaenergy: { max: 0 },
      size: { value: 'small' },
      soulpower: { value: -1, max: -1 },
      toughness: { value: 1, max: 1 },
      dodge: { value: 7, modifier: 0, max: 7 },
      speed: { initial: 12, max: 12 },
      initiative: { current: 13, value: 13.13 },
    },
    details: { experience: { total: 0 } },
  },
  items: [
    { name: 'Biss', type: 'trait' },
    { name: 'Fell', type: 'armor' },
  ],
};

const elfDoc = {
  id: 'elf1',
  name: 'Zauberweberin',
  type: 'npc',
  system: {
    status: {
      wounds: { initial: 2, max: 24 },
      astralenergy: { max: 30 },
      karmaenergy: { max: 0 },
      size: { value: 'average' },
    },
    details: {
      species: { value: 'Elf' },
      culture: { value: 'Auelfen' },
      career: { value: 'Zauberweberin' },
      experience: { total: 1300 },
    },
  },
  items: new Map([['s1', { name: 'Fulminictus', type: 'spell' }]]).values(),
};

const wolf = extractDSA5Creature(wolfDoc, pack) as DSA5CreatureIndex;
const elf = extractDSA5Creature(elfDoc, pack) as DSA5CreatureIndex;

describe('extractDSA5Creature', () => {
  it('reads a creature from the prepared actor', () => {
    expect(wolf).toEqual({
      system: 'dsa5',
      id: 'wolf1',
      name: 'Grauwolf',
      type: 'creature',
      pack: 'world.bestiary',
      packLabel: 'Bestiary',
      img: 'wolf.webp',
      creatureClass: 'Tier, nicht humanoid',
      species: '',
      culture: '',
      profession: '',
      size: 'small',
      lifePoints: 18, // the maximum, not the 12 the stored actor currently has
      astralEnergy: 0,
      karmaEnergy: 0,
      hasSpells: false,
      soulPower: -1,
      toughness: 1,
      dodge: 7,
      armor: 1,
      speed: 12,
      initiative: 13,
      experiencePoints: 0,
      traits: ['Biss'],
    });
  });

  it('reads identity, AP and magic of an NPC', () => {
    expect(elf).toMatchObject({
      type: 'npc',
      species: 'Elf',
      culture: 'Auelfen',
      profession: 'Zauberweberin',
      experiencePoints: 1300,
      lifePoints: 24,
      astralEnergy: 30,
      hasSpells: true,
      creatureClass: '',
    });
  });

  it('treats an actor that only owns spell items as a spellcaster', () => {
    const doc = { ...wolfDoc, items: [{ name: 'Blick aufs Wesen', type: 'liturgy' }] };
    expect(extractDSA5Creature(doc, pack)?.hasSpells).toBe(true);
  });

  it('falls back to the stored base LeP and to average size for unprepared data', () => {
    const doc = {
      id: 'x',
      name: 'Raw',
      type: 'creature',
      system: { status: { wounds: { initial: 9 } } },
    };
    expect(extractDSA5Creature(doc, pack)).toMatchObject({ lifePoints: 9, size: 'average' });
  });

  it('skips actor types that are not creatures or people', () => {
    expect(extractDSA5Creature({ id: 'g', name: 'Heldengruppe', type: 'group' }, pack)).toBeNull();
    expect(extractDSA5Creature({ id: 'v', name: 'Kutsche', type: 'vehicle' }, pack)).toBeNull();
  });
});

describe('normalizeDSA5Size', () => {
  it("maps D&D-style and German names onto the system's categories", () => {
    expect(normalizeDSA5Size('medium')).toBe('average');
    expect(normalizeDSA5Size('Large')).toBe('big');
    expect(normalizeDSA5Size('huge')).toBe('giant');
    expect(normalizeDSA5Size('klein')).toBe('small');
    expect(normalizeDSA5Size('giant')).toBe('giant');
  });
});

describe('passesDSA5Criteria', () => {
  it('passes everything without criteria', () => {
    expect(passesDSA5Criteria(wolf, {})).toBe(true);
    expect(passesDSA5Criteria(elf, {})).toBe(true);
  });

  it('filters by actor type', () => {
    expect(passesDSA5Criteria(wolf, { actorType: 'creature' })).toBe(true);
    expect(passesDSA5Criteria(elf, { actorType: 'creature' })).toBe(false);
  });

  it('matches part of the creature class, ignoring case', () => {
    expect(passesDSA5Criteria(wolf, { creatureClass: 'tier' })).toBe(true);
    expect(passesDSA5Criteria(wolf, { creatureClass: 'Dämon' })).toBe(false);
    expect(passesDSA5Criteria(elf, { creatureClass: 'tier' })).toBe(false);
  });

  it('applies the generic creatureType to the class of creatures and the species of people', () => {
    expect(passesDSA5Criteria(wolf, { creatureType: 'Tier' })).toBe(true);
    expect(passesDSA5Criteria(elf, { creatureType: 'elf' })).toBe(true);
    expect(passesDSA5Criteria(elf, { creatureType: 'Tier' })).toBe(false);
  });

  it('filters by species', () => {
    expect(passesDSA5Criteria(elf, { species: 'elf' })).toBe(true);
    expect(passesDSA5Criteria(wolf, { species: 'elf' })).toBe(false);
  });

  it('filters by size, accepting the generic size names', () => {
    expect(passesDSA5Criteria(wolf, { size: 'small' })).toBe(true);
    expect(passesDSA5Criteria(elf, { size: 'medium' })).toBe(true);
    expect(passesDSA5Criteria(elf, { size: 'large' })).toBe(false);
  });

  it('filters by Lebensenergie, exact or as a range', () => {
    expect(passesDSA5Criteria(wolf, { hitPoints: 18 })).toBe(true);
    expect(passesDSA5Criteria(wolf, { hitPoints: 19 })).toBe(false);
    expect(passesDSA5Criteria(wolf, { hitPoints: { min: 10, max: 20 } })).toBe(true);
    expect(passesDSA5Criteria(wolf, { hitPoints: { min: 19 } })).toBe(false);
    expect(passesDSA5Criteria(elf, { hitPoints: { max: 20 } })).toBe(false);
  });

  it('filters by spellcasting', () => {
    expect(passesDSA5Criteria(elf, { hasSpells: true })).toBe(true);
    expect(passesDSA5Criteria(wolf, { hasSpells: true })).toBe(false);
    expect(passesDSA5Criteria(wolf, { hasSpells: false })).toBe(true);
  });

  it('requires every criterion to match', () => {
    expect(passesDSA5Criteria(wolf, { creatureClass: 'tier', size: 'big' })).toBe(false);
  });
});

describe('formatDSA5CreatureResult', () => {
  it('describes a creature by its class', () => {
    const result = formatDSA5CreatureResult(wolf);
    expect(result).toMatchObject({
      id: 'wolf1',
      name: 'Grauwolf',
      pack: 'world.bestiary',
      packLabel: 'Bestiary',
      hasImage: true,
      creatureClass: 'Tier, nicht humanoid',
      size: 'small',
      lifePoints: 18,
      traits: ['Biss'],
      summary: 'creature: Tier, nicht humanoid — small, 18 LeP — from Bestiary',
    });
    expect(result).not.toHaveProperty('species');
    expect(result).not.toHaveProperty('astralEnergy');
  });

  it('describes a person by species and profession and lists their AsP', () => {
    const result = formatDSA5CreatureResult(elf);
    expect(result).toMatchObject({
      species: 'Elf',
      profession: 'Zauberweberin',
      experiencePoints: 1300,
      astralEnergy: 30,
      summary: 'npc: Elf, Zauberweberin — average, 24 LeP — 30 AsP — from Bestiary',
    });
    expect(result).not.toHaveProperty('creatureClass');
    expect(result).not.toHaveProperty('traits');
  });
});
