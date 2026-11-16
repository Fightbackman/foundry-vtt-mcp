/**
 * Tests for DSA5Adapter.normalizePayload
 *
 * Caller-friendly DSA5 shorthands (uppercase Eigenschaft keys, naked numbers,
 * lifePoints, identity.*, …) have to end up on fields the DSA5 data model really
 * stores. Many values the sheet shows (Eigenschaft `value`, pool `max`, dodge,
 * hero initiative) are derived at runtime, so they can only be reached through
 * the stored parts they are computed from.
 */

import { describe, it, expect } from 'vitest';
import { DSA5Adapter } from './adapter.js';

const adapter = new DSA5Adapter();
const hero = { actorType: 'character', isNew: true };
const creature = { actorType: 'creature', isNew: true };

describe('DSA5Adapter.normalizePayload', () => {
  describe('Eigenschaften', () => {
    it('turns a naked number into initial with no advances, under the lowercase key', () => {
      const result = adapter.normalizePayload({ characteristics: { MU: 13, kl: 12 } });
      expect(result.characteristics).toEqual({
        mu: { initial: 13, advances: 0 },
        kl: { initial: 12, advances: 0 },
      });
    });

    it('never writes the derived `value`', () => {
      const result = adapter.normalizePayload({
        characteristics: { mu: { value: 14 }, ge: { value: 13, initial: 11 } },
      });
      expect(result.characteristics.mu).toEqual({ initial: 14, advances: 0 });
      // the wanted value is reached through advances on top of the given initial
      expect(result.characteristics.ge).toEqual({ initial: 11, advances: 2 });
    });

    it('passes the stored parts through unchanged', () => {
      const result = adapter.normalizePayload({
        characteristics: { ko: { initial: 8, advances: 5, modifier: 1 } },
      });
      expect(result.characteristics.ko).toEqual({ initial: 8, advances: 5, modifier: 1 });
    });

    it('does not invent an initial for a partial update', () => {
      const result = adapter.normalizePayload({ characteristics: { kk: { advances: 4 } } });
      expect(result.characteristics.kk).toEqual({ advances: 4 });
    });

    it('accepts system.eigenschaften and ignores unknown keys', () => {
      const result = adapter.normalizePayload({ eigenschaften: { MU: 14, XX: 3 } });
      expect(result.characteristics).toEqual({ mu: { initial: 14, advances: 0 } });
      expect(result.eigenschaften).toBeUndefined();
    });
  });

  describe('LeP', () => {
    it('writes the current LeP to wounds.value', () => {
      const result = adapter.normalizePayload({ lifePoints: { current: 20 } });
      expect(result.status.wounds).toEqual({ value: 20 });
      expect(result.lifePoints).toBeUndefined();
    });

    it('accepts value as a synonym for current, and status.lifePoints as a source', () => {
      expect(adapter.normalizePayload({ lifePoints: { value: 15 } }).status.wounds).toEqual({
        value: 15,
      });
      const result = adapter.normalizePayload({ status: { lifePoints: { current: 12 } } });
      expect(result.status.wounds).toEqual({ value: 12 });
      expect(result.status.lifePoints).toBeUndefined();
    });

    it('reaches a hero maximum through wounds.initial = max − 2×KO', () => {
      const result = adapter.normalizePayload(
        {
          characteristics: { KO: { initial: 10, advances: 3 } },
          lifePoints: { current: 25, max: 33 },
        },
        hero
      );
      expect(result.status.wounds).toEqual({ initial: 7, value: 25 });
    });

    it('assumes the default KO of 8 on a new hero', () => {
      const result = adapter.normalizePayload({ lifePoints: 30 }, hero);
      expect(result.status.wounds).toEqual({ initial: 14, value: 30 });
    });

    it('cannot set a hero maximum on update without KO, and leaves the current LeP alone', () => {
      const result = adapter.normalizePayload({ lifePoints: { max: 33 } });
      expect(result.status?.wounds).toBeUndefined();
    });

    it('stores a creature maximum in wounds.initial', () => {
      const result = adapter.normalizePayload({ lifePoints: 18 }, creature);
      expect(result.status.wounds).toEqual({ initial: 18, value: 18 });
    });

    it('starts a new actor at full LeP when only max is given', () => {
      const result = adapter.normalizePayload({ lifePoints: { max: 18 } }, creature);
      expect(result.status.wounds).toEqual({ initial: 18, value: 18 });
    });

    it('lets real wounds fields win over the shorthand', () => {
      const result = adapter.normalizePayload({
        status: { wounds: { value: 5, advances: 2 } },
        lifePoints: { current: 99 },
      });
      expect(result.status.wounds).toEqual({ value: 5, advances: 2 });
    });

    it('treats {current, max} under status.wounds as a shorthand too', () => {
      const result = adapter.normalizePayload(
        { status: { wounds: { current: 5, max: 10, advances: 1 } } },
        creature
      );
      expect(result.status.wounds).toEqual({ initial: 10, value: 5, advances: 1 });
    });
  });

  describe('AsP / KaP / Schicksalspunkte', () => {
    it('writes current AsP / KaP to value and a creature maximum to initial', () => {
      const result = adapter.normalizePayload(
        { astralEnergy: { current: 5, max: 12 }, karmaEnergy: 20 },
        creature
      );
      expect(result.status.astralenergy).toEqual({ initial: 12, value: 5 });
      expect(result.status.karmaenergy).toEqual({ initial: 20, value: 20 });
      expect(result.astralEnergy).toBeUndefined();
    });

    it('only writes the current points for a hero, whose maximum comes from the tradition', () => {
      const result = adapter.normalizePayload({ astralEnergy: { value: 10, max: 20 } }, hero);
      expect(result.status.astralenergy).toEqual({ value: 10 });
    });

    it('maps fatePoints: a number is what is left, {current, max} sets both', () => {
      expect(adapter.normalizePayload({ fatePoints: 2 }).status.fatePoints).toEqual({ value: 2 });
      expect(
        adapter.normalizePayload({ fatePoints: { current: 1, max: 4 } }).status.fatePoints
      ).toEqual({ value: 1, current: 4 });
    });
  });

  describe('Details', () => {
    it('maps string species/culture/career to {value} objects', () => {
      const result = adapter.normalizePayload({
        species: 'Mensch',
        culture: 'Bornland',
        career: 'Krieger',
      });
      expect(result.details).toEqual({
        species: { value: 'Mensch' },
        culture: { value: 'Bornland' },
        career: { value: 'Krieger' },
      });
      expect(result.species).toBeUndefined();
    });

    it('maps profession and identity.* onto the real detail fields', () => {
      const result = adapter.normalizePayload({
        profession: 'Magier',
        identity: { species: 'Elf', culture: 'Firnelfen' },
      });
      expect(result.details).toEqual({
        career: { value: 'Magier' },
        species: { value: 'Elf' },
        culture: { value: 'Firnelfen' },
      });
      expect(result.identity).toBeUndefined();
      expect(adapter.normalizePayload({ identity: { profession: 'Geweihter' } }).details).toEqual({
        career: { value: 'Geweihter' },
      });
    });

    it('fixes string shorthands given inside details', () => {
      const result = adapter.normalizePayload({
        details: { species: 'Zwerg', profession: 'Schmied', culture: { value: 'Ambosszwerge' } },
      });
      expect(result.details).toEqual({
        species: { value: 'Zwerg' },
        career: { value: 'Schmied' },
        culture: { value: 'Ambosszwerge' },
      });
    });

    it('stores a numeric socialstate as a number', () => {
      expect(adapter.normalizePayload({ socialstate: '3' }).details.socialstate).toEqual({
        value: 3,
      });
      expect(adapter.normalizePayload({ socialstate: 'Frei' }).details.socialstate).toEqual({
        value: 'Frei',
      });
    });

    it('writes total and spent AP; available AP are derived', () => {
      expect(
        adapter.normalizePayload({ experience: { total: 1500, spent: 800, available: 700 } })
          .details.experience
      ).toEqual({ total: 1500, spent: 800 });
      expect(
        adapter.normalizePayload({ experience: { total: 1500, available: 100 } }).details.experience
      ).toEqual({ total: 1500, spent: 1400 });
    });
  });

  describe('Status / Kampf', () => {
    it('writes speed to the stored base and initiative to the creature base', () => {
      const result = adapter.normalizePayload({ speed: 12, initiative: 13 }, creature);
      expect(result.status.speed).toEqual({ initial: 12 });
      expect(result.status.initiative).toEqual({ current: 13 });
      expect(result.speed).toBeUndefined();
    });

    it('turns dodge into the modifier on top of GE / 2', () => {
      const withGe = adapter.normalizePayload({ characteristics: { GE: 13 }, dodge: 9 });
      expect(withGe.status.dodge).toEqual({ modifier: 2 }); // round(13 / 2) = 7
      const fresh = adapter.normalizePayload({ dodge: 7 }, creature);
      expect(fresh.status.dodge).toEqual({ modifier: 3 }); // default GE 8
    });

    it('drops dodge on an update that does not say what GE is', () => {
      const result = adapter.normalizePayload({ dodge: 7 });
      expect(result.status?.dodge).toBeUndefined();
      expect(result.dodge).toBeUndefined();
    });

    it('writes soulpower / toughness values', () => {
      const result = adapter.normalizePayload({ soulpower: -1, toughness: 1 }, creature);
      expect(result.status.soulpower).toEqual({ value: -1 });
      expect(result.status.toughness).toEqual({ value: 1 });
    });

    it('does not write an armor value: Rüstungsschutz comes from armor items', () => {
      const result = adapter.normalizePayload({ speed: 8 });
      expect(result.status.armour).toBeUndefined();
    });

    it("maps size names onto the system's categories", () => {
      expect(adapter.normalizePayload({ size: 'mittel' }).status.size).toEqual({
        value: 'average',
      });
      expect(adapter.normalizePayload({ size: 'Large' }).status.size).toEqual({ value: 'big' });
      expect(adapter.normalizePayload({ status: { size: 'giant' } }).status.size).toEqual({
        value: 'giant',
      });
    });
  });

  describe('Tradition and unknown keys', () => {
    it('passes tradition through', () => {
      const result = adapter.normalizePayload({
        tradition: { magical: 'Gildenmagier', clerical: 'Rondra' },
      });
      expect(result.tradition).toEqual({ magical: 'Gildenmagier', clerical: 'Rondra' });
    });

    it('preserves unknown keys unchanged', () => {
      const result = adapter.normalizePayload({
        someUnknownKey: 'hello',
        status: { regeneration: { LePTemp: 1 } },
      });
      expect(result.someUnknownKey).toBe('hello');
      expect(result.status).toEqual({ regeneration: { LePTemp: 1 } });
    });
  });

  it('normalises a mixed hero payload', () => {
    const result = adapter.normalizePayload(
      {
        characteristics: {
          MU: 13,
          KL: { value: 12, initial: 10 },
          KO: { initial: 8, advances: 4 },
        },
        lifePoints: { current: 25, max: 30 },
        species: 'Mensch',
        profession: 'Krieger',
        size: 'medium',
        unknownField: 'preserved',
      },
      hero
    );

    expect(result).toEqual({
      characteristics: {
        mu: { initial: 13, advances: 0 },
        kl: { initial: 10, advances: 2 },
        ko: { initial: 8, advances: 4 },
      },
      status: { wounds: { initial: 6, value: 25 }, size: { value: 'average' } },
      details: { species: { value: 'Mensch' }, career: { value: 'Krieger' } },
      unknownField: 'preserved',
    });
  });
});
