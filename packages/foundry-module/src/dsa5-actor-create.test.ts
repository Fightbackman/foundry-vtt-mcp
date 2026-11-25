/**
 * DSA5 actor creation through the system's own path.
 *
 * DSA5 adds default skills, combat skills, coins, fate points and starting LeP in the
 * static Actordsa5.create, which the core Actor.create / Actor.createDocuments never
 * call. manage-actors therefore produced heroes without any Talente and at 0 LeP.
 * These tests stub the configured document class the way Actordsa5.create behaves.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { assertDsa5ActorFields, createDsa5Actor, createDsa5Actors } from './dsa5-actor-create.js';
import { FoundryDataAccess } from './data-access.js';

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value));

function getProperty(obj: any, path: string): any {
  return path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
}

function setProperty(obj: any, path: string, value: unknown): void {
  const keys = path.split('.');
  let target = obj;
  for (const key of keys.slice(0, -1)) target = target[key] ??= {};
  target[keys[keys.length - 1]] = value;
}

function expandObject(obj: Record<string, any>): Record<string, any> {
  const out: Record<string, any> = {};
  for (const [k, v] of Object.entries(obj)) {
    setProperty(out, k, v && typeof v === 'object' && !Array.isArray(v) ? expandObject(v) : v);
  }
  return out;
}

function mergeObject(a: any, b: any, _opts?: unknown): any {
  const out = clone(a);
  for (const [k, v] of Object.entries(b)) {
    out[k] =
      v && typeof v === 'object' && !Array.isArray(v) && out[k] && typeof out[k] === 'object'
        ? mergeObject(out[k], v)
        : clone(v);
  }
  return out;
}

const DEFAULT_ITEMS = [
  { name: 'Klettern', type: 'skill', system: { talentValue: { value: 0 } } },
  { name: 'Schwerter', type: 'combatskill', system: { talentValue: { value: 6 } } },
  { name: 'Dukat', type: 'money', system: { quantity: { value: 0 } } },
];

/** Derived max LeP as DSA5 computes it for character/npc (2*KO + initial) or creature. */
function maxWounds(source: any): number {
  const ko = getProperty(source, 'system.characteristics.ko.initial') ?? 8;
  const initial = getProperty(source, 'system.status.wounds.initial') ?? 0;
  const bonus = (source.items ?? []).some((i: any) => i.name === 'Hohe Lebenskraft') ? 1 : 0;
  return source.type === 'creature' ? initial : 2 * ko + initial + bonus;
}

let created: any[];
let createCalls: any[];

class FakeActorClass {
  _source: any;
  items: any[];
  system: any;
  type: string;
  name: string;
  id: string;
  delete = vi.fn(async () => {
    created = created.filter(a => a !== this);
  });
  update = vi.fn(async (update: Record<string, any>) => {
    for (const [k, v] of Object.entries(update)) setProperty(this._source, k, v);
    this.prepare();
  });
  updateEmbeddedDocuments = vi.fn(async (_type: string, updates: any[]) => {
    for (const u of updates) {
      const item = this.items.find(i => i.id === u._id);
      Object.assign(item, mergeObject(item, u));
    }
  });
  createEmbeddedDocuments = vi.fn(async (_type: string, docs: any[]) => {
    for (const d of docs) this.items.push({ ...clone(d), id: `item-${this.items.length}` });
    this._source.items = this.items;
    this.prepare();
  });

  constructor(data: any) {
    this._source = clone(data);
    this.type = data.type;
    this.name = data.name;
    this.id = `actor-${Math.random().toString(36).slice(2, 8)}`;
    this.items = (data.items ?? []).map((i: any, n: number) => ({ ...clone(i), id: `item-${n}` }));
    this.prepare();
  }

  prepare() {
    this.system = mergeObject(this._source.system ?? {}, {
      status: { wounds: { max: maxWounds({ ...this._source, items: this.items }) } },
    });
  }

  /** Mirrors Actordsa5.create: defaults only when no items were given. */
  static async create(data: any) {
    createCalls.push(clone(data));
    if (!data.items) {
      data.items = clone(DEFAULT_ITEMS);
      if (data.type !== 'character') setProperty(data, 'system.status.fatePoints.value', 0);
      const w = getProperty(data, 'system.status.wounds.value');
      if (data.type !== 'creature' && [undefined, 0].includes(w)) {
        setProperty(data, 'system.status.wounds.value', 16);
      }
    }
    const actor = new FakeActorClass(data);
    created.push(actor);
    return actor;
  }
}

beforeEach(() => {
  created = [];
  createCalls = [];
  vi.stubGlobal('foundry', {
    utils: { deepClone: clone, getProperty, setProperty, expandObject, mergeObject },
  });
  vi.stubGlobal('CONFIG', { Actor: { documentClass: FakeActorClass } });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const woundsValue = (actor: any) => getProperty(actor._source, 'system.status.wounds.value');

describe('createDsa5Actor', () => {
  it('creates through the configured document class without items so defaults apply', async () => {
    const actor = await createDsa5Actor({ name: 'Held', type: 'character', folder: 'f1' });

    expect(createCalls[0]).not.toHaveProperty('items');
    expect(createCalls[0].folder).toBe('f1');
    expect(actor.items.map((i: any) => i.name)).toEqual(['Klettern', 'Schwerter', 'Dukat']);
    expect(woundsValue(actor)).toBe(16);
    expect(actor.update).not.toHaveBeenCalled();
  });

  it('starts a hero at the derived maximum LeP instead of the fixed 16', async () => {
    const actor = await createDsa5Actor({
      name: 'Held',
      type: 'character',
      system: { characteristics: { ko: { initial: 14 } }, status: { wounds: { initial: 5 } } },
    });

    // Set before creation, so the system never sees a wounded hero.
    expect(getProperty(createCalls[0], 'system.status.wounds.value')).toBe(33);
    expect(woundsValue(actor)).toBe(33);
  });

  it('starts a creature at its derived maximum LeP', async () => {
    const actor = await createDsa5Actor({
      name: 'Wolf',
      type: 'creature',
      system: { status: { wounds: { initial: 30 } } },
    });
    expect(woundsValue(actor)).toBe(30);
  });

  it('keeps a creature without LeP at 0 like the system does', async () => {
    const actor = await createDsa5Actor({ name: 'Wolf', type: 'creature' });
    // Nothing is written; the data model's default (0) stays in place.
    expect(woundsValue(actor)).toBeUndefined();
    expect(actor.update).not.toHaveBeenCalled();
  });

  it('keeps an explicit current LeP, including dotted keys and 0', async () => {
    const a = await createDsa5Actor({
      name: 'A',
      type: 'npc',
      system: { status: { wounds: { value: 10 } } },
    });
    const b = await createDsa5Actor({
      name: 'B',
      type: 'npc',
      system: { 'status.wounds.value': 7 },
    });
    // Actordsa5.create turns an explicit 0 into 16; the caller's value is restored.
    const c = await createDsa5Actor({
      name: 'C',
      type: 'character',
      system: { status: { wounds: { value: 0 } } },
    });
    expect(woundsValue(a)).toBe(10);
    expect(woundsValue(b)).toBe(7);
    expect(woundsValue(c)).toBe(0);
  });

  it("merges caller items into same-name defaults and adds the rest; caller's value wins", async () => {
    const actor = await createDsa5Actor({ name: 'Held', type: 'character' }, [
      { _id: 'foreign', name: 'klettern ', type: 'skill', system: { talentValue: { value: 7 } } },
      { name: 'Dukat', type: 'money', system: { quantity: { value: 5 } } },
      { name: 'Seil', type: 'equipment', system: { quantity: { value: 1 } } },
      // A same-name item of a non-default type is not merged.
      { name: 'Klettern', type: 'specialability', system: {} },
    ]);

    expect(createCalls[0]).not.toHaveProperty('items');
    const byName = (name: string, type: string) =>
      actor.items.filter((i: any) => i.name === name && i.type === type);
    expect(byName('Klettern', 'skill')).toHaveLength(1);
    expect(byName('Klettern', 'skill')[0].system.talentValue.value).toBe(7);
    expect(byName('Dukat', 'money')[0].system.quantity.value).toBe(5);
    expect(byName('Seil', 'equipment')).toHaveLength(1);
    expect(byName('Klettern', 'specialability')).toHaveLength(1);
    expect(actor.items).toHaveLength(5);
    expect(actor.createEmbeddedDocuments.mock.calls[0][1][0]).not.toHaveProperty('_id');
  });

  it('accounts for caller items that change the LeP maximum', async () => {
    const actor = await createDsa5Actor({ name: 'Held', type: 'character' }, [
      { name: 'Hohe Lebenskraft', type: 'advantage', system: {} },
    ]);
    expect(woundsValue(actor)).toBe(17);
  });

  it('deletes the actor again when adding items fails', async () => {
    const spy = vi.spyOn(FakeActorClass, 'create').mockImplementationOnce(async (data: any) => {
      const actor = new FakeActorClass({ ...data, items: clone(DEFAULT_ITEMS) });
      actor.createEmbeddedDocuments.mockRejectedValueOnce(new Error('bad item'));
      created.push(actor);
      return actor;
    });

    await expect(
      createDsa5Actor({ name: 'Held', type: 'character' }, [{ name: 'X', type: 'weird' }])
    ).rejects.toThrow('bad item');
    expect(created).toHaveLength(0);
    spy.mockRestore();
  });
});

describe('createDsa5Actors', () => {
  it('rolls back the actors already created when a later one fails', async () => {
    let calls = 0;
    const realCreate = FakeActorClass.create.bind(FakeActorClass);
    vi.spyOn(FakeActorClass, 'create').mockImplementation(async (data: any) => {
      calls += 1;
      if (calls === 2) throw new Error('second failed');
      return realCreate(data);
    });

    await expect(
      createDsa5Actors([{ data: { name: 'A', type: 'npc' } }, { data: { name: 'B', type: 'npc' } }])
    ).rejects.toThrow('second failed');
    expect(created).toHaveLength(0);
  });
});

function stubGame(systemId: string) {
  vi.stubGlobal('game', {
    ready: true,
    world: { id: 'world-1' },
    user: { id: 'gm', name: 'GM', isGM: true },
    system: { id: systemId },
    settings: { get: () => true },
    actors: [],
  });
}

describe('FoundryDataAccess.createActors routing', () => {
  function access() {
    const da = Object.create(FoundryDataAccess.prototype) as FoundryDataAccess;
    (da as any).getOrCreateFolder = vi.fn(async () => 'folder-1');
    return da;
  }

  it('creates DSA5 actors through the system path, with folder and items', async () => {
    stubGame('dsa5');
    const createDocuments = vi.fn();
    vi.stubGlobal('Actor', { createDocuments });

    const result = await access().createActors({
      actors: [
        {
          name: 'Held',
          type: 'character',
          items: [{ name: 'Klettern', type: 'skill', system: { talentValue: { value: 4 } } }],
        },
        { name: 'Wolf', type: 'creature' },
      ],
      folder: 'Mine',
    });

    expect(createDocuments).not.toHaveBeenCalled();
    expect(createCalls.map(c => c.folder)).toEqual(['folder-1', 'folder-1']);
    expect(result.total).toBe(2);
    expect(result.created.map(c => [c.name, c.type])).toEqual([
      ['Held', 'character'],
      ['Wolf', 'creature'],
    ]);
    const klettern = created[0].items.find((i: any) => i.name === 'Klettern');
    expect(klettern.system.talentValue.value).toBe(4);
  });

  it('keeps the batch Actor.createDocuments call for other systems and ignores items', async () => {
    stubGame('dnd5e');
    const createDocuments = vi.fn(async (docs: any[]) =>
      docs.map((d, i) => ({ id: `id-${i}`, name: d.name, type: d.type }))
    );
    vi.stubGlobal('Actor', { createDocuments });

    const result = await access().createActors({
      actors: [{ name: 'Goblin', type: 'npc', system: { hp: 7 }, items: [{ name: 'x' }] }],
    });

    expect(createDocuments).toHaveBeenCalledWith([
      { name: 'Goblin', type: 'npc', system: { hp: 7 }, folder: 'folder-1' },
    ]);
    expect(createCalls).toHaveLength(0);
    expect(result).toEqual({ created: [{ id: 'id-0', name: 'Goblin', type: 'npc' }], total: 1 });
  });
});

describe('FoundryDataAccess.createActorFromData applySystemDefaults', () => {
  function access() {
    const da = Object.create(FoundryDataAccess.prototype) as FoundryDataAccess;
    (da as any).getOrCreateFolder = vi.fn(async () => 'folder-1');
    (da as any).auditLog = vi.fn();
    return da;
  }

  it('builds a mapped DSA5 import like a new actor and merges its items', async () => {
    stubGame('dsa5');
    const coreCreate = vi.fn();
    vi.stubGlobal('Actor', { create: coreCreate });

    const result = await access().createActorFromData({
      actorData: {
        name: 'Optolith Held',
        type: 'character',
        system: { characteristics: { ko: { initial: 13 } } },
        items: [{ name: 'Klettern', type: 'skill', system: { talentValue: { value: 9 } } }],
      },
      applySystemDefaults: true,
    });

    expect(coreCreate).not.toHaveBeenCalled();
    expect(result.actor?.name).toBe('Optolith Held');
    const actor = created[0];
    expect(actor.items).toHaveLength(3);
    expect(actor.items[0].system.talentValue.value).toBe(9);
    expect(woundsValue(actor)).toBe(26);
  });

  it('keeps the plain Actor.create path without the flag', async () => {
    stubGame('dsa5');
    const coreCreate = vi.fn(async (data: any) => ({
      ...data,
      id: 'raw-1',
      createEmbeddedDocuments: vi.fn(),
    }));
    vi.stubGlobal('Actor', { create: coreCreate });

    await access().createActorFromData({ actorData: { name: 'Raw', type: 'character' } });

    expect(coreCreate).toHaveBeenCalledOnce();
    expect(createCalls).toHaveLength(0);
  });
});

describe('assertDsa5ActorFields', () => {
  afterEach(() => vi.unstubAllGlobals());

  const model = (fields: string[]) => ({
    schema: { fields: Object.fromEntries(fields.map(field => [field, {}])) },
  });

  it('accepts tradition fields where the data model has them (DSA5 8.1)', () => {
    vi.stubGlobal('CONFIG', {
      Actor: { dataModels: { character: model(['status', 'tradition', 'guidevalue']) } },
    });
    expect(() =>
      assertDsa5ActorFields('character', { tradition: { magical: 'Gildenmagier' } })
    ).not.toThrow();
  });

  it('refuses tradition fields DSA5 8.2 removed from the actor', () => {
    vi.stubGlobal('CONFIG', { Actor: { dataModels: { character: model(['status']) } } });
    expect(() =>
      assertDsa5ActorFields('character', { tradition: { magical: 'X' }, guidevalue: {} })
    ).toThrow(/tradition, guidevalue.*Tradition special ability/);
    expect(() => assertDsa5ActorFields('character', { status: {} })).not.toThrow();
  });

  it('does nothing without data models', () => {
    vi.stubGlobal('CONFIG', { Actor: {} });
    expect(() => assertDsa5ActorFields('character', { tradition: {} })).not.toThrow();
  });
});
