/**
 * manage-combat, browser side.
 *
 * The manager must drive encounters only through the Combat document methods, since
 * systems override them (DSA5 resets defense counts in nextRound, skips minion groups and
 * defeated combatants in nextTurn, and deals burning damage from an updateCombat hook).
 * These tests stub a world and check which methods are called, what is reported, and
 * where it refuses.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CombatManager } from './combat-manager.js';

class FakeCollection<T extends { id: string }> extends Array<T> {
  get(id: string) {
    return this.find(x => x.id === id);
  }
  has(id: string) {
    return this.some(x => x.id === id);
  }
  get size() {
    return this.length;
  }
  get contents() {
    return [...this];
  }
}

function collection<T extends { id: string }>(items: T[] = []) {
  const c = new FakeCollection<T>();
  c.push(...items);
  return c;
}

function makeActor(lep = 20, effects: any[] = []) {
  const actor: any = {
    effects: collection(effects),
    system: { status: { wounds: { value: lep, max: 30 }, initiative: { value: 12.12 } } },
    get statuses() {
      return new Set(actor.effects.flatMap((e: any) => [...(e.statuses ?? [])]));
    },
    toggleStatusEffect: vi.fn(),
  };
  return actor;
}

function makeCombatant(id: string, name: string, extra: any = {}) {
  const c: any = {
    id,
    name,
    tokenId: `tok-${id}`,
    actorId: `act-${id}`,
    initiative: null,
    hidden: false,
    defeated: false,
    isNPC: true,
    token: { name, disposition: -1 },
    actor: makeActor(),
    system: { defenseCount: 0, actionsUsed: 0 },
    flags: {} as any,
    get isDefeated() {
      return c.defeated || c.actor?.statuses.has('dead');
    },
    getFlag: vi.fn((scope: string, key: string) => c.flags[scope]?.[key]),
    unsetFlag: vi.fn(async (scope: string, key: string) => {
      delete c.flags[scope]?.[key];
    }),
    update: vi.fn(async (data: any) => Object.assign(c, data)),
    ...extra,
  };
  return c;
}

function makeCombat(id: string, scene: any, combatants: any[], extra: any = {}) {
  const combat: any = {
    id,
    name: '',
    scene,
    active: true,
    round: 0,
    turn: null,
    combatants: collection(combatants),
    system: {},
    get started() {
      return combat.round > 0;
    },
    get turns() {
      return [...combat.combatants].sort(
        (a: any, b: any) => (b.initiative ?? -Infinity) - (a.initiative ?? -Infinity)
      );
    },
    get combatant() {
      return combat.turn == null ? undefined : combat.turns[combat.turn];
    },
    activate: vi.fn(async () => {
      combat.active = true;
    }),
    createEmbeddedDocuments: vi.fn(async (_type: string, data: any[]) => {
      const created = data.map((d, i) =>
        makeCombatant(`new${i}`, d.tokenId, { tokenId: d.tokenId })
      );
      combat.combatants.push(...created);
      return created;
    }),
    deleteEmbeddedDocuments: vi.fn(async (_type: string, ids: string[]) => {
      const keep = combat.combatants.filter((c: any) => !ids.includes(c.id));
      combat.combatants = collection(keep);
    }),
    rollInitiative: vi.fn(async (ids: string[]) => {
      for (const cid of ids) combat.combatants.get(cid).initiative = 15;
    }),
    rollAll: vi.fn(async () => undefined),
    rollNPC: vi.fn(async () => undefined),
    setInitiative: vi.fn(async (cid: string, value: number) => {
      combat.combatants.get(cid).initiative = value;
    }),
    startCombat: vi.fn(async () => {
      combat.round = 1;
      combat.turn = 0;
    }),
    nextTurn: vi.fn(async () => {
      combat.turn += 1;
    }),
    previousTurn: vi.fn(async () => {
      combat.turn -= 1;
    }),
    nextRound: vi.fn(async () => {
      combat.round += 1;
      combat.turn = 0;
    }),
    previousRound: vi.fn(async () => undefined),
    delete: vi.fn(async () => {
      const combats = (globalThis as any).game.combats;
      const i = combats.findIndex((c: any) => c.id === combat.id);
      if (i >= 0) combats.splice(i, 1);
    }),
    ...extra,
  };
  return combat;
}

interface World {
  scene: any;
  combats: FakeCollection<any>;
  settings: Record<string, unknown>;
  tracker: any;
  CombatCls: any;
}

function stubWorld(
  opts: { systemId?: string; tokens?: any[]; combats?: any[]; generation?: number } = {}
): World {
  const scene: any = {
    id: 'scene1',
    name: 'Battlefield',
    tokens: collection(opts.tokens ?? []),
  };
  const combats = collection<any>(opts.combats ?? []);
  const settings: Record<string, unknown> = { allowWriteOperations: true };
  const hookIds = { n: 0 };
  vi.stubGlobal('Hooks', { on: vi.fn(() => ++hookIds.n), off: vi.fn() });
  const tracker = {
    _onToggleDefeatedStatus: vi.fn(async (c: any) => {
      c.defeated = !c.defeated;
    }),
  };
  vi.stubGlobal('ui', { combat: tracker });
  const CombatCls = {
    create: vi.fn(async (data: any) => {
      const combat = makeCombat('new-combat', scene, [], { name: data.name ?? '', active: false });
      combats.push(combat);
      return combat;
    }),
  };
  vi.stubGlobal('CONFIG', {
    Combat: { documentClass: CombatCls },
    specialStatusEffects: { DEFEATED: 'dead' },
  });
  vi.stubGlobal('game', {
    ready: true,
    world: { id: 'w' },
    user: { id: 'gm', isGM: true },
    system: { id: opts.systemId ?? 'dnd5e' },
    release: { generation: opts.generation ?? 14 },
    settings: { get: (_m: string, key: string) => settings[key] },
    scenes: Object.assign(collection([scene]), { current: scene }),
    combats,
    messages: collection([]),
  });
  for (const c of combats) c.scene = scene;
  return { scene, combats, settings, tracker, CombatCls };
}

function manager() {
  const m = new CombatManager();
  m.settleQuietMs = 0;
  m.settleMaxMs = 5;
  m.roundSettleMs = 0;
  return m;
}

function token(id: string, name: string, disposition = -1) {
  return { id, name, actorId: `actor-${id}`, hidden: false, disposition, actor: {} };
}

describe('CombatManager', () => {
  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  describe('permissions', () => {
    it('reads the state with write operations disabled', async () => {
      const a = makeCombatant('a', 'Goblin', { initiative: 12 });
      const world = stubWorld({ combats: [makeCombat('c1', null, [a])] });
      world.settings.allowWriteOperations = false;

      const result = await manager().handle({ action: 'state' });

      expect(result.success).toBe(true);
      expect(result.combatants.map((c: any) => c.name)).toEqual(['Goblin']);
    });

    it('refuses every change with write operations disabled', async () => {
      const combat = makeCombat('c1', null, [makeCombatant('a', 'Goblin')], { round: 1, turn: 0 });
      const world = stubWorld({ combats: [combat] });
      world.settings.allowWriteOperations = false;

      await expect(manager().handle({ action: 'next-turn' })).rejects.toThrow(/disabled/);
      expect(combat.nextTurn).not.toHaveBeenCalled();
    });
  });

  describe('encounter lookup', () => {
    it('says so when the scene has no encounter', async () => {
      stubWorld();
      await expect(manager().handle({ action: 'state' })).rejects.toThrow(/No encounter on scene/);
    });

    it('finds an encounter by name and lists the others on the scene', async () => {
      const one = makeCombat('c1', null, [], { name: 'Wolves', active: true });
      const two = makeCombat('c2', null, [], { name: 'Ogre', active: false });
      stubWorld({ combats: [one, two] });

      const result = await manager().handle({ action: 'state', combat: 'ogre' });

      expect(result.encounter.id).toBe('c2');
      expect(result.otherEncounters).toEqual([
        expect.objectContaining({ id: 'c1', name: 'Wolves', active: true }),
      ]);
    });

    it('asks for an id when a combatant name is ambiguous', () => {
      const combat = makeCombat('c1', null, [
        makeCombatant('a', 'Wolf'),
        makeCombatant('b', 'Wolf'),
      ]);
      stubWorld({ combats: [combat] });

      const { found, errors } = manager().resolveCombatants(combat, ['wolf', 'tok-b', 'Bear']);

      expect(found.map(c => c.id)).toEqual(['b']);
      expect(errors[0].reason).toMatch(/several combatants/);
      expect(errors[1].reason).toMatch(/not a combatant/);
    });
  });

  describe('create', () => {
    it('creates and activates an encounter, reporting each token', async () => {
      const world = stubWorld({
        tokens: [token('t1', 'Wolf'), token('t2', 'Wolf'), token('t3', 'Hero', 1)],
      });

      const result = await manager().handle({
        action: 'create',
        name: 'Ambush',
        tokens: ['Wolf', 't3', 'Nobody'],
      });

      expect(world.CombatCls.create).toHaveBeenCalledWith({ scene: 'scene1', name: 'Ambush' });
      const combat = world.combats[0];
      expect(combat.activate).toHaveBeenCalled();
      expect(combat.createEmbeddedDocuments).toHaveBeenCalledWith('Combatant', [
        { tokenId: 't1', sceneId: 'scene1', actorId: 'actor-t1', hidden: false },
        { tokenId: 't2', sceneId: 'scene1', actorId: 'actor-t2', hidden: false },
        { tokenId: 't3', sceneId: 'scene1', actorId: 'actor-t3', hidden: false },
      ]);
      expect(result.tokens.map((t: any) => [t.ref, t.status])).toEqual([
        ['Wolf', 'added'],
        ['Wolf', 'added'],
        ['t3', 'added'],
        ['Nobody', 'skipped'],
      ]);
    });

    it('creates nothing when no token is on the scene', async () => {
      const world = stubWorld({ tokens: [token('t1', 'Wolf')] });

      const result = await manager().handle({ action: 'create', tokens: ['Ghost'] });

      expect(result.success).toBe(false);
      expect(world.CombatCls.create).not.toHaveBeenCalled();
    });

    it('leaves out neutral tokens for the hostile-and-friendly set', async () => {
      const world = stubWorld({
        tokens: [token('t1', 'Wolf', -1), token('t2', 'Farmer', 0), token('t3', 'Hero', 1)],
      });

      await manager().handle({ action: 'create', tokenSet: 'hostile-and-friendly' });

      const data = world.combats[0].createEmbeddedDocuments.mock.calls[0][1];
      expect(data.map((d: any) => d.tokenId)).toEqual(['t1', 't3']);
    });

    it('rolls initiative and begins the encounter when asked', async () => {
      const world = stubWorld({ tokens: [token('t1', 'Wolf')] });

      const result = await manager().handle({
        action: 'create',
        tokens: ['t1'],
        rollInitiative: 'all',
        begin: true,
      });

      const combat = world.combats[0];
      expect(combat.rollInitiative).toHaveBeenCalled();
      expect(combat.startCombat).toHaveBeenCalled();
      expect(result.encounter.started).toBe(true);
      expect(result.initiative.rolled[0].initiative).toBe(15);
    });
  });

  describe('add', () => {
    it('refuses tokens that are already combatants, adding the rest', async () => {
      const existing = makeCombatant('a', 'Wolf', { tokenId: 't1' });
      const combat = makeCombat('c1', null, [existing]);
      stubWorld({ tokens: [token('t1', 'Wolf'), token('t2', 'Ogre')], combats: [combat] });

      const result = await manager().handle({ action: 'add', tokens: ['t1', 'Ogre'] });

      expect(result.tokens.map((t: any) => [t.ref, t.status])).toEqual([
        ['t1', 'skipped'],
        ['Ogre', 'added'],
      ]);
      expect(result.tokens[0].reason).toMatch(/already a combatant/);
    });

    it('reports a token the game system refused', async () => {
      const combat = makeCombat('c1', null, []);
      combat.createEmbeddedDocuments = vi.fn(async () => []);
      stubWorld({ tokens: [token('t1', 'Ship')], combats: [combat] });

      const result = await manager().handle({ action: 'add', tokens: ['Ship'] });

      expect(result.tokens[0]).toMatchObject({
        status: 'skipped',
        reason: 'refused by the game system',
      });
    });
  });

  describe('initiative', () => {
    let combat: any;
    beforeEach(() => {
      combat = makeCombat('c1', null, [
        makeCombatant('a', 'Wolf', { initiative: 10 }),
        makeCombatant('b', 'Hero'),
      ]);
    });

    it.each([
      ['missing', 'rollAll'],
      ['npcs', 'rollNPC'],
    ] as const)('mode %s uses Combat#%s', async (mode, method) => {
      stubWorld({ combats: [combat] });
      await manager().handle({ action: 'initiative', mode });
      expect(combat[method]).toHaveBeenCalledWith({});
    });

    it('rerolls everyone for mode all, passing the message mode on Foundry 14', async () => {
      stubWorld({ combats: [combat] });
      await manager().handle({ action: 'initiative', mode: 'all', messageMode: 'gm' });
      expect(combat.rollInitiative).toHaveBeenCalledWith(['a', 'b'], { messageMode: 'gm' });
    });

    it('passes a roll mode instead on Foundry 13', async () => {
      stubWorld({ combats: [combat], generation: 13 });
      await manager().handle({ action: 'initiative', combatants: ['Hero'], messageMode: 'blind' });
      expect(combat.rollInitiative).toHaveBeenCalledWith(['b'], {
        messageOptions: { rollMode: 'blindroll' },
      });
    });

    it('sets a value by hand through Combat#setInitiative', async () => {
      stubWorld({ combats: [combat] });
      const result = await manager().handle({
        action: 'initiative',
        set: [{ combatant: 'Hero', value: 17 }],
      });
      expect(combat.setInitiative).toHaveBeenCalledWith('b', 17);
      expect(combat.rollAll).not.toHaveBeenCalled();
      expect(result.combatants[0]).toMatchObject({ name: 'Hero', initiative: 17 });
    });

    it('drops the stale DSA5 die record before a value set by hand', async () => {
      const hero = combat.combatants.get('b');
      hero.flags = { dsa5: { baseRoll: 2 } };
      stubWorld({ systemId: 'dsa5', combats: [combat] });
      await manager().handle({ action: 'initiative', set: [{ combatant: 'b', value: 17 }] });
      expect(hero.unsetFlag).toHaveBeenCalledWith('dsa5', 'baseRoll');
      expect(hero.unsetFlag.mock.invocationCallOrder[0]).toBeLessThan(
        combat.setInitiative.mock.invocationCallOrder[0]
      );
    });
  });

  describe('turns', () => {
    it('refuses to advance an encounter that has not started', async () => {
      const combat = makeCombat('c1', null, [makeCombatant('a', 'Wolf')]);
      stubWorld({ combats: [combat] });
      await expect(manager().handle({ action: 'next-turn' })).rejects.toThrow(/not started/);
    });

    it('reports who is up and what changed on the combatants', async () => {
      const a = makeCombatant('a', 'Wolf', { initiative: 20 });
      const b = makeCombatant('b', 'Dead Wolf', { initiative: 15, defeated: true });
      const c = makeCombatant('c', 'Hero', { initiative: 10 });
      const combat = makeCombat('c1', null, [a, b, c], { round: 1, turn: 0 });
      // The system skips the defeated wolf and a timed effect on the hero runs out.
      combat.nextTurn = vi.fn(async () => {
        combat.turn = 2;
        c.actor.effects = collection([]);
      });
      c.actor.effects = collection([{ id: 'e1', name: 'Blessing', statuses: new Set() }]);
      stubWorld({ combats: [combat] });

      const result = await manager().handle({ action: 'next-turn' });

      expect(combat.nextTurn).toHaveBeenCalled();
      expect(result.current.name).toBe('Hero');
      expect(result.passedOver).toEqual([{ name: 'Dead Wolf', reason: 'defeated' }]);
      expect(result.changes).toEqual([
        {
          combatant: 'Hero',
          combatantId: 'c',
          changes: [{ what: 'effect "Blessing"', from: 'active', to: 'none' }],
        },
      ]);
    });

    it('reports DSA5 round-start damage and the defense count reset', async () => {
      const hero = makeCombatant('a', 'Hero', { initiative: 10 });
      hero.system.defenseCount = 2;
      const combat = makeCombat('c1', null, [hero], { round: 1, turn: 0 });
      combat.nextRound = vi.fn(async () => {
        combat.round = 2;
        hero.system.defenseCount = 0;
        hero.actor.system.status.wounds.value = 17;
      });
      stubWorld({ systemId: 'dsa5', combats: [combat] });

      const result = await manager().handle({ action: 'next-round' });

      expect(result.roundChanged).toBe(true);
      expect(result.changes[0].changes).toEqual(
        expect.arrayContaining([
          { what: 'LeP', from: 20, to: 17 },
          { what: 'defenses this round', from: 2, to: 0 },
        ])
      );
    });

    it('warns that DSA5 skips round-start effects outside the active encounter', async () => {
      const combat = makeCombat('c1', null, [makeCombatant('a', 'Hero')], {
        round: 1,
        turn: 0,
        active: false,
      });
      stubWorld({ systemId: 'dsa5', combats: [combat] });

      const result = await manager().handle({ action: 'next-round' });

      expect(result.warnings[0]).toMatch(/not the active one/);
    });
  });

  describe('combatants', () => {
    it('marks a combatant defeated through the tracker toggle and warns without the status', async () => {
      const wolf = makeCombatant('a', 'Wolf');
      const combat = makeCombat('c1', null, [wolf]);
      const world = stubWorld({ combats: [combat] });

      const result = await manager().handle({
        action: 'update-combatant',
        combatants: ['Wolf'],
        defeated: true,
      });

      expect(world.tracker._onToggleDefeatedStatus).toHaveBeenCalledWith(wolf);
      expect(result.updated[0].defeated).toBe(true);
      expect(result.warnings[0]).toMatch(/did not add its "dead" status/);
    });

    it('does not toggle a combatant that is already in the asked state', async () => {
      const wolf = makeCombatant('a', 'Wolf', { defeated: true });
      const world = stubWorld({ combats: [makeCombat('c1', null, [wolf])] });

      await manager().handle({ action: 'update-combatant', combatants: ['a'], defeated: true });

      expect(world.tracker._onToggleDefeatedStatus).not.toHaveBeenCalled();
    });

    it('hides and removes combatants', async () => {
      const wolf = makeCombatant('a', 'Wolf');
      const hero = makeCombatant('b', 'Hero');
      const combat = makeCombat('c1', null, [wolf, hero]);
      stubWorld({ combats: [combat] });

      await manager().handle({ action: 'update-combatant', combatants: ['Wolf'], hidden: true });
      expect(wolf.update).toHaveBeenCalledWith({ hidden: true });

      const result = await manager().handle({ action: 'remove-combatant', combatants: ['Hero'] });
      expect(combat.deleteEmbeddedDocuments).toHaveBeenCalledWith('Combatant', ['b']);
      expect(result.removed).toEqual([{ combatant: 'Hero', combatantId: 'b' }]);
    });
  });

  describe('end', () => {
    it('deletes the encounter without the confirmation dialog', async () => {
      const combat = makeCombat('c1', null, [makeCombatant('a', 'Wolf')], { name: 'Ambush' });
      const world = stubWorld({ combats: [combat] });

      const result = await manager().handle({ action: 'end' });

      expect(combat.delete).toHaveBeenCalled();
      expect(result.success).toBe(true);
      expect(result.ended).toMatchObject({ id: 'c1', name: 'Ambush', combatants: ['Wolf'] });
      expect(world.combats.length).toBe(0);
    });

    it('reports an encounter the system kept', async () => {
      const combat = makeCombat('c1', null, []);
      combat.delete = vi.fn(async () => undefined);
      stubWorld({ combats: [combat] });

      const result = await manager().handle({ action: 'end' });

      expect(result.success).toBe(false);
      expect(result.error).toMatch(/kept the encounter/);
    });

    it('refuses a DSA5 brawl, which asks in a dialog how to settle Prügelpunkte', async () => {
      const combat = makeCombat('c1', null, [], { system: { isBrawling: true } });
      stubWorld({ systemId: 'dsa5', combats: [combat] });

      const result = await manager().handle({ action: 'end' });

      expect(result.success).toBe(false);
      expect(result.error).toMatch(/brawling/);
      expect(combat.delete).not.toHaveBeenCalled();
    });
  });
});
