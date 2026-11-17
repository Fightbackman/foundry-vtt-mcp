/**
 * DSA5 hooks in get-character and search-character-items.
 *
 * - get-character sends the combat view (`dsa5Combat`) in DSA5 worlds only.
 * - search-character-items read `equipped` / `quantity` where dnd5e stores them; DSA5 keeps
 *   the worn state in `system.worn.value` and the quantity in `system.quantity.value`, so
 *   worn armor showed as unequipped and quantities as `{ value: 1 }`.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { FoundryDataAccess } from './data-access.js';

const ACTOR_ID = 'actor00000000001';

function item(id: string, name: string, type: string, system: Record<string, unknown>) {
  return {
    id,
    name,
    type,
    system,
    effects: [],
    toObject: () => ({ system }),
  };
}

function createActor(items: ReturnType<typeof item>[]) {
  return {
    id: ACTOR_ID,
    name: 'Kriegerin',
    type: 'character',
    system: { status: {}, condition: { encumbered: 2 }, armorEncumbrance: 2 },
    items: Object.assign(items, { get: (id: string) => items.find(i => i.id === id) }),
    effects: [] as any[],
    prepareSheet: vi.fn(() => ({
      armorSum: 4,
      wornArmor: [],
      wornMeleeWeapons: [],
      wornRangedWeapons: [],
      traits: {},
    })),
  };
}

const dsa5Items = () => [
  item('arm1', 'Kettenhemd', 'armor', {
    quantity: { value: 1 },
    worn: { value: true },
    description: { value: '' },
  }),
  item('arm2', 'Lederrüstung', 'armor', { quantity: { value: 1 }, worn: { value: false } }),
  item('sw1', 'Langschwert', 'meleeweapon', { quantity: { value: 1 }, worn: { value: true } }),
  item('am1', 'Kriegspfeile', 'ammunition', { quantity: { value: 20 } }),
  item('sk1', 'Klettern', 'skill', { talentValue: { value: 4 } }),
];

function setup(systemId: string, actor: ReturnType<typeof createActor>) {
  const actors = Object.assign([actor], {
    get: (id: string) => (id === actor.id ? actor : undefined),
    find: (predicate: (a: typeof actor) => boolean) => (predicate(actor) ? actor : undefined),
  });
  vi.stubGlobal('game', {
    ready: true,
    world: { id: 'world-1' },
    user: { id: 'gm', isGM: true },
    system: { id: systemId },
    actors,
    scenes: [],
    dsa5: { entities: { Actordsa5: { armorValue: () => ({ armor: 4 }) } }, apps: {} },
  });
  const access: any = Object.create(FoundryDataAccess.prototype);
  access.findActorByIdentifier = () => actor;
  access.auditLog = () => undefined;
  return access as FoundryDataAccess;
}

describe('get-character DSA5 combat view', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('adds dsa5Combat in DSA5 worlds', async () => {
    const actor = createActor(dsa5Items());
    const result: any = await setup('dsa5', actor).getCharacterInfo(ACTOR_ID);

    expect(actor.prepareSheet).toHaveBeenCalledOnce();
    expect(result.dsa5Combat.armor.protection).toBe(4);
    expect(result.dsa5Combat.encumbrance).toMatchObject({ level: 2, fromArmor: 2 });
  });

  it('leaves other systems untouched', async () => {
    const actor = createActor([]);
    const result: any = await setup('dnd5e', actor).getCharacterInfo(ACTOR_ID);

    expect(actor.prepareSheet).not.toHaveBeenCalled();
    expect(result).not.toHaveProperty('dsa5Combat');
  });
});

describe('search-character-items with DSA5 items', () => {
  afterEach(() => vi.unstubAllGlobals());

  const search = (params: Record<string, unknown>, systemId = 'dsa5') =>
    setup(systemId, createActor(dsa5Items())).searchCharacterItems({
      characterIdentifier: ACTOR_ID,
      ...params,
    });

  it('reports the worn state and a numeric quantity', async () => {
    const result = await search({ type: 'armor' });
    expect(result.matches).toEqual([
      { id: 'arm1', name: 'Kettenhemd', type: 'armor', quantity: 1, equipped: true },
      { id: 'arm2', name: 'Lederrüstung', type: 'armor', quantity: 1, equipped: false },
    ]);

    const ammo = await search({ type: 'ammunition' });
    expect(ammo.matches).toEqual([
      { id: 'am1', name: 'Kriegspfeile', type: 'ammunition', quantity: 20 },
    ]);
  });

  it('returns worn armor and weapons, and nothing else, for category "equipped"', async () => {
    const result = await search({ category: 'equipped' });
    expect(result.matches.map(m => m.name)).toEqual(['Kettenhemd', 'Langschwert']);
  });

  it('keeps the generic behaviour for other systems', async () => {
    const result = await search({ type: 'armor' }, 'dnd5e');
    expect(result.matches[0]).toMatchObject({ quantity: { value: 1 }, equipped: false });
  });
});
