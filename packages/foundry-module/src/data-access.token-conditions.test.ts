/**
 * toggle-token-condition and get-available-conditions across systems.
 *
 * - PF2e replaces CONFIG.statusEffects with a plain object keyed by slug, so the array
 *   methods both tools used threw in PF2e worlds.
 * - PF2e conditions are Items; a hand-built ActiveEffect did nothing.
 * - dnd5e removal deleted any effect whose statuses merely contained the id, so removing
 *   Incapacitated deleted a compound Paralyzed effect.
 *
 * Both tools now read the list either way, and add/remove goes through
 * Actor#toggleStatusEffect, which systems override. DSA5 uses its own
 * addCondition/removeCondition instead (see dsa5-conditions.ts), because its
 * toggleStatusEffect adds a level per call.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FoundryDataAccess } from './data-access.js';

function makeActor() {
  return {
    name: 'Goblin',
    effects: { contents: [] as any[] },
    toggleStatusEffect: vi.fn().mockResolvedValue(undefined),
    createEmbeddedDocuments: vi.fn().mockResolvedValue([]),
    deleteEmbeddedDocuments: vi.fn().mockResolvedValue([]),
  };
}

function stubWorld(systemId: string, statusEffects: unknown, actor: any) {
  const token = { id: 'tok1', name: 'Goblin Token', actor };
  vi.stubGlobal('game', {
    ready: true,
    world: { id: 'world-1' },
    user: { id: 'gm', name: 'GM', isGM: true },
    system: { id: systemId },
    settings: { get: () => true },
    i18n: { localize: (key: string) => (key === 'CONDITION.prone' ? 'Liegend' : key) },
    scenes: { current: { tokens: { get: (id: string) => (id === 'tok1' ? token : undefined) } } },
  });
  vi.stubGlobal('CONFIG', { statusEffects });
}

const access = () => Object.create(FoundryDataAccess.prototype) as FoundryDataAccess;

// PF2e's shape: a plain object keyed by slug.
const pf2eStatuses = {
  frightened: { id: 'frightened', name: 'Frightened', img: 'f.webp' },
  prone: { id: 'prone', name: 'Prone', img: 'p.webp' },
  'persistent-damage': { id: 'persistent-damage', name: 'Persistent Damage', img: 'pd.webp' },
};

// Core/dnd5e shape: an array.
const coreStatuses = [
  { id: 'incapacitated', name: 'Incapacitated', img: 'i.svg' },
  { id: 'paralyzed', name: 'Paralyzed', img: 'pz.svg' },
];

describe('condition tools', () => {
  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  describe('PF2e', () => {
    it('lists conditions from its object-shaped CONFIG.statusEffects', async () => {
      stubWorld('pf2e', pf2eStatuses, makeActor());

      const result = await access().getAvailableConditions();

      expect(result.conditions.map((c: any) => c.id)).toEqual([
        'frightened',
        'prone',
        'persistent-damage',
      ]);
    });

    it('adds a condition through the actor instead of a hand-built effect', async () => {
      const actor = makeActor();
      stubWorld('pf2e', pf2eStatuses, actor);

      await access().toggleTokenCondition({
        tokenId: 'tok1',
        conditionId: 'frightened',
        active: true,
      });

      expect(actor.toggleStatusEffect).toHaveBeenCalledWith('frightened', { active: true });
      expect(actor.createEmbeddedDocuments).not.toHaveBeenCalled();
    });

    it('removes a condition through the actor', async () => {
      const actor = makeActor();
      stubWorld('pf2e', pf2eStatuses, actor);

      await access().toggleTokenCondition({ tokenId: 'tok1', conditionId: 'prone', active: false });

      expect(actor.toggleStatusEffect).toHaveBeenCalledWith('prone', { active: false });
      expect(actor.deleteEmbeddedDocuments).not.toHaveBeenCalled();
    });

    it('resolves a condition by name', async () => {
      const actor = makeActor();
      stubWorld('pf2e', pf2eStatuses, actor);

      await access().toggleTokenCondition({
        tokenId: 'tok1',
        conditionId: 'Frightened',
        active: true,
      });

      expect(actor.toggleStatusEffect).toHaveBeenCalledWith('frightened', { active: true });
    });

    it('refuses persistent damage, which PF2e only applies through a dialog', async () => {
      const actor = makeActor();
      stubWorld('pf2e', pf2eStatuses, actor);

      await expect(
        access().toggleTokenCondition({
          tokenId: 'tok1',
          conditionId: 'persistent-damage',
          active: true,
        })
      ).rejects.toThrow(/Persistent damage/);
      expect(actor.toggleStatusEffect).not.toHaveBeenCalled();
    });
  });

  describe('dnd5e', () => {
    it('removes a status through the actor rather than deleting matching effects itself', async () => {
      const actor = makeActor();
      // A compound effect carrying incapacitated among other statuses.
      actor.effects.contents = [
        { id: 'para', name: 'Paralyzed', statuses: new Set(['paralyzed', 'incapacitated']) },
      ];
      stubWorld('dnd5e', coreStatuses, actor);

      await access().toggleTokenCondition({
        tokenId: 'tok1',
        conditionId: 'incapacitated',
        active: false,
      });

      expect(actor.toggleStatusEffect).toHaveBeenCalledWith('incapacitated', { active: false });
      expect(actor.deleteEmbeddedDocuments).not.toHaveBeenCalled();
    });

    it('adds a status through the actor', async () => {
      const actor = makeActor();
      stubWorld('dnd5e', coreStatuses, actor);

      await access().toggleTokenCondition({
        tokenId: 'tok1',
        conditionId: 'paralyzed',
        active: true,
      });

      expect(actor.toggleStatusEffect).toHaveBeenCalledWith('paralyzed', { active: true });
      expect(actor.createEmbeddedDocuments).not.toHaveBeenCalled();
    });
  });

  describe('DSA5', () => {
    const dsaStatuses = [
      {
        id: 'prone',
        name: 'CONDITION.prone',
        img: 'l.svg',
        description: 'CONDITIONDESCRIPTION.prone',
      },
      {
        id: 'feared',
        name: 'CONDITION.feared',
        img: 'f.svg',
        description: 'CONDITIONDESCRIPTION.feared',
        system: { condition: { value: 1, max: 4 } },
      },
    ];

    function makeDsaActor() {
      const actor: any = makeActor();
      actor.effects = [];
      actor.addCondition = vi.fn(async (id: string) => {
        actor.effects.push({ id: 'e1', statuses: new Set([id]), system: { condition: {} } });
        return actor.effects;
      });
      actor.removeCondition = vi.fn(async () => {
        actor.effects.length = 0;
      });
      return actor;
    }

    it('adds through the system API, found by localized name', async () => {
      const actor = makeDsaActor();
      stubWorld('dsa5', dsaStatuses, actor);

      const result = await access().toggleTokenCondition({
        tokenId: 'tok1',
        conditionId: 'liegend',
        active: true,
      });

      expect(actor.addCondition).toHaveBeenCalledWith('prone', 1, false, false);
      expect(actor.toggleStatusEffect).not.toHaveBeenCalled();
      expect(actor.createEmbeddedDocuments).not.toHaveBeenCalled();
      expect(result).toMatchObject({
        success: true,
        conditionId: 'prone',
        conditionName: 'Liegend',
        isActive: true,
      });
    });

    it('sets a level on a leveled condition', async () => {
      const actor = makeDsaActor();
      stubWorld('dsa5', dsaStatuses, actor);

      await access().toggleTokenCondition({ tokenId: 'tok1', conditionId: 'feared', level: 3 });

      expect(actor.addCondition).toHaveBeenCalledWith('feared', 3, true, false);
    });

    it('removes through the system API', async () => {
      const actor = makeDsaActor();
      actor.effects.push({ id: 'e1', statuses: new Set(['prone']), system: { condition: {} } });
      stubWorld('dsa5', dsaStatuses, actor);

      const result = await access().toggleTokenCondition({
        tokenId: 'tok1',
        conditionId: 'prone',
        active: false,
      });

      expect(actor.removeCondition).toHaveBeenCalledWith('prone');
      expect(actor.deleteEmbeddedDocuments).not.toHaveBeenCalled();
      expect(result.isActive).toBe(false);
    });

    it('lists conditions with localized names and the maximum level', async () => {
      stubWorld('dsa5', dsaStatuses, makeDsaActor());

      const result = await access().getAvailableConditions();

      expect(result.conditions).toEqual([
        {
          id: 'prone',
          name: 'Liegend',
          icon: 'l.svg',
          description: 'CONDITIONDESCRIPTION.prone',
        },
        {
          id: 'feared',
          name: 'CONDITION.feared',
          icon: 'f.svg',
          description: 'CONDITIONDESCRIPTION.feared',
          maxLevel: 4,
        },
      ]);
    });
  });

  it('rejects a level outside DSA5 instead of ignoring it', async () => {
    const actor = makeActor();
    stubWorld('dnd5e', coreStatuses, actor);

    await expect(
      access().toggleTokenCondition({ tokenId: 'tok1', conditionId: 'paralyzed', level: 2 })
    ).rejects.toThrow(/only supported in DSA5/);
    expect(actor.toggleStatusEffect).not.toHaveBeenCalled();
  });

  it('keeps the list output of other systems unchanged', async () => {
    stubWorld('dnd5e', coreStatuses, makeActor());

    const result = await access().getAvailableConditions();

    expect(result.conditions[0]).toEqual({
      id: 'incapacitated',
      name: 'Incapacitated',
      icon: 'i.svg',
      description: '',
    });
  });

  it('still reports an unknown condition', async () => {
    stubWorld('dnd5e', coreStatuses, makeActor());

    await expect(
      access().toggleTokenCondition({ tokenId: 'tok1', conditionId: 'nonsense', active: true })
    ).rejects.toThrow(/Condition not found: nonsense/);
  });
});
