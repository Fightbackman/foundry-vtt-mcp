import { afterEach, describe, expect, it, vi } from 'vitest';
import { dsa5AddItems } from './dsa5-add-items.js';

let nextId = 1;

function makeItem(data: any) {
  return {
    id: data.id ?? `item-${nextId++}`,
    uuid: data.uuid ?? `Item.${data.name}`,
    name: data.name,
    type: data.type,
    system: data.system ?? {},
    effects: (data.effects ?? []).map((e: any) => ({ ...e })),
    flags: data.flags ?? {},
    toObject() {
      return JSON.parse(
        JSON.stringify({
          _id: this.id,
          name: this.name,
          type: this.type,
          system: this.system,
          effects: this.effects,
          flags: this.flags,
        })
      );
    },
    documentName: 'Item',
  };
}

function makeCollection(list: any[]) {
  return Object.assign(list, {
    get: (id: string) => list.find(i => i.id === id),
    getName: (name: string) => list.find(i => i.name === name),
  });
}

/** A DSA5-like actor whose AP functions behave like Actordsa5's. */
function makeActor(options: { free?: number; total?: number; type?: string } = {}) {
  const items = makeCollection([] as any[]);
  const total = options.total ?? 1000;
  const actor: any = {
    id: 'actor-1',
    name: 'Alrike',
    type: options.type ?? 'character',
    canAdvance: (options.type ?? 'character') === 'character',
    items,
    effects: makeCollection([] as any[]),
    system: { details: { experience: { total, spent: total - (options.free ?? 100) } } },
  };
  actor.createEmbeddedDocuments = vi.fn(async (_type: string, docs: any[]) =>
    docs.map(d => {
      const created = makeItem({ ...d, id: undefined });
      items.push(created);
      return created;
    })
  );
  actor.updateEmbeddedDocuments = vi.fn(async (_type: string, updates: any[]) => {
    for (const u of updates) Object.assign(items.get(u._id).system, u.system);
  });
  // Prototype-style methods, so the guard's instance overrides can be detected and removed.
  const proto = {
    get hasPlayerOwner() {
      return true;
    },
    checkEnoughXP: vi.fn(async (cost: number) => {
      const exp = actor.system.details.experience;
      return exp.total - exp.spent >= cost;
    }),
    _updateAPs: vi.fn(async (ap: number) => {
      actor.system.details.experience.spent += ap;
    }),
  };
  Object.setPrototypeOf(actor, proto);
  actor.sheet = {
    _addLoot: vi.fn(async (item: any) => {
      const same = items.find((i: any) => i.type === item.type && i.name === item.name);
      if (same) same.system.quantity.value += item.system.quantity.value;
      else await actor.createEmbeddedDocuments('Item', [item]);
    }),
    _addMoney: vi.fn(),
    _addSpellOrLiturgy: vi.fn(async (item: any) => {
      if (await actor.checkEnoughXP(3)) {
        await actor._updateAPs(3);
        await actor.createEmbeddedDocuments('Item', [item]);
      }
    }),
    _cleverDeleteItem: vi.fn(async (id: string) => {
      const index = items.findIndex((i: any) => i.id === id);
      const [removed] = items.splice(index, 1);
      if (removed.type === 'advantage')
        await actor._updateAPs(-Number(removed.system.APValue.value));
    }),
  };
  return { actor, proto };
}

/** Mimics AdvantageRulesDSA5._vantageReturnFunction (AP check, adoption naming, create). */
function makeRules(actor: any) {
  return vi.fn(async (_actor: any, item: any, _type: string, adoption: any) => {
    if (adoption) item.name = `${item.name.replace(' ()', '')} (${adoption.name})`;
    const cost = Number(item.system.APValue.value) * (item.system.step?.value ?? 1);
    if (await actor.checkEnoughXP(cost)) {
      await actor._updateAPs(cost);
      await actor.createEmbeddedDocuments('Item', [item]);
    }
  });
}

function setup(worldItems: any[], options: { free?: number; total?: number } = {}) {
  const { actor, proto } = makeActor(options);
  const vantage = makeRules(actor);
  const world = makeCollection(worldItems.map(makeItem));
  const byUuid = new Map(world.map((i: any) => [i.uuid, i]));
  vi.stubGlobal('fromUuid', async (uuid: string) => byUuid.get(uuid));
  vi.stubGlobal('game', {
    items: world,
    packs: [],
    user: { isGM: true },
    journal: [],
    settings: { get: () => false },
    dsa5: {
      apps: { AdvantageRulesDSA5: { _vantageReturnFunction: vantage } },
      config: {
        vantagesNeedingAdaption: { 'Begabung ()': { items: ['skill'] } },
        AbilitiesNeedingAdaption: {},
        equipmentCategories: new Set(['equipment', 'meleeweapon']),
      },
    },
  });
  return { actor, proto, vantage };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('dsa5AddItems', () => {
  it('adds an advantage through the system rule with its AP cost and effects', async () => {
    const { actor, vantage } = setup([
      {
        name: 'Zäher Hund',
        type: 'advantage',
        system: { APValue: { value: '20' }, max: { value: 1 }, step: { value: 1 } },
        effects: [{ id: 'e1', name: 'Zäher Hund' }],
        flags: { core: { marker: 1 } },
      },
    ]);
    const result = await dsa5AddItems(actor, { items: [{ name: 'zäher hund' }] });
    const [entry] = result.results;
    expect(entry.success).toBe(true);
    expect(entry.created[0]).toMatchObject({ name: 'Zäher Hund', effects: ['Zäher Hund'] });
    expect(entry.ap).toEqual({ charged: 20, freeBefore: 100, freeAfter: 80 });
    // The full document (effects + flags) is handed to the system.
    expect(vantage.mock.calls[0][1]).toMatchObject({ flags: { core: { marker: 1 } } });
    expect(vantage.mock.calls[0][1].effects).toHaveLength(1);
  });

  it('refuses a missing adoption with the valid choices, then uses the given one', async () => {
    const { actor, vantage } = setup([
      {
        name: 'Begabung ()',
        type: 'advantage',
        system: { APValue: { value: '6' }, max: { value: 1 }, step: { value: 1 } },
      },
    ]);
    actor.items.push(
      makeItem({ name: 'Klettern', type: 'skill', system: { StF: { value: 'B' } } })
    );

    const missing = await dsa5AddItems(actor, { items: [{ name: 'Begabung' }] });
    expect(missing.results[0].success).toBe(false);
    expect(missing.results[0].choices).toEqual(['Klettern']);
    expect(vantage).not.toHaveBeenCalled();

    const ok = await dsa5AddItems(actor, { items: [{ name: 'Begabung', adoption: 'klettern' }] });
    expect(ok.results[0].created[0].name).toBe('Begabung (Klettern)');
    expect(vantage.mock.calls[0][3]).toMatchObject({ name: 'Klettern' });
  });

  it('refuses without enough AP and never reaches the system dialog', async () => {
    const { actor, proto } = setup(
      [
        {
          name: 'Zäher Hund',
          type: 'advantage',
          system: { APValue: { value: '20' }, max: { value: 1 }, step: { value: 1 } },
        },
      ],
      { free: 0, total: 0 }
    );
    const result = await dsa5AddItems(actor, { items: [{ name: 'Zäher Hund' }] });
    expect(result.results[0].success).toBe(false);
    expect(result.results[0].error).toMatch(/Not enough AP: 20 needed, 0 free/);
    expect(proto.checkEnoughXP).not.toHaveBeenCalled();
    expect(actor.items).toHaveLength(0);
  });

  it('free adds without booking AP or tracking and restores the actor afterwards', async () => {
    const { actor, proto } = setup(
      [
        {
          name: 'Zäher Hund',
          type: 'advantage',
          system: { APValue: { value: '20' }, max: { value: 1 }, step: { value: 1 } },
        },
      ],
      { free: 0 }
    );
    const result = await dsa5AddItems(actor, { free: true, items: [{ name: 'Zäher Hund' }] });
    expect(result.results[0]).toMatchObject({
      success: true,
      ap: { charged: 0, waived: 20 },
      tracker: 'not tracked (free)',
    });
    expect(proto._updateAPs).not.toHaveBeenCalled();
    expect(Object.prototype.hasOwnProperty.call(actor, 'checkEnoughXP')).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(actor, '_updateAPs')).toBe(false);
    expect(actor.hasPlayerOwner).toBe(true);
  });

  it('stacks equipment through the sheet and sets the quantity', async () => {
    const { actor } = setup([
      { name: 'Fackel', type: 'equipment', system: { quantity: { value: 1 } } },
    ]);
    await dsa5AddItems(actor, { items: [{ name: 'Fackel' }] });
    const second = await dsa5AddItems(actor, { items: [{ name: 'Fackel', quantity: 4 }] });
    expect(second.results[0].changed[0]).toMatchObject({
      stacked: true,
      quantity: { before: 1, after: 5 },
    });
    expect(actor.sheet._addLoot).toHaveBeenCalledTimes(2);
  });

  it('reports ambiguous and unknown names per entry without failing the call', async () => {
    const { actor } = setup([
      { name: 'Fackel', type: 'equipment', system: { quantity: { value: 1 } }, uuid: 'Item.a' },
      { name: 'Fackel', type: 'equipment', system: { quantity: { value: 1 } }, uuid: 'Item.b' },
      { name: 'Ignifaxius', type: 'spell', system: { StF: { value: 'C' } } },
    ]);
    const result = await dsa5AddItems(actor, {
      items: [{ name: 'Fackel' }, { name: 'Gibtsnicht' }, { name: 'Ignifaxius' }],
    });
    expect(result.success).toBe(true);
    expect(result.results[0].candidates.map((c: any) => c.uuid)).toEqual(['Item.a', 'Item.b']);
    expect(result.results[1].error).toMatch(/No item named "Gibtsnicht"/);
    expect(result.results[2]).toMatchObject({ success: true, ap: { charged: 3 } });
  });

  it('refuses wizard types and unadoptable templates', async () => {
    const { actor } = setup([
      { name: 'Mittelreicher', type: 'culture' },
      {
        name: 'Waffenbegabung ()',
        type: 'advantage',
        system: { APValue: { value: '5' }, max: { value: 1 }, step: { value: 1 } },
      },
    ]);
    const result = await dsa5AddItems(actor, {
      items: [{ name: 'Mittelreicher' }, { name: 'Waffenbegabung' }],
    });
    expect(result.success).toBe(false);
    expect(result.results[0].error).toMatch(/wizard/);
    expect(result.results[1].error).toMatch(/no adoption rule/);
  });

  it('removes through the sheet delete path and reports the refund', async () => {
    const { actor } = setup([]);
    actor.items.push(
      makeItem({ name: 'Zäher Hund', type: 'advantage', system: { APValue: { value: '20' } } })
    );
    const result = await dsa5AddItems(actor, { action: 'remove', items: [{ name: 'Zäher Hund' }] });
    expect(result.results[0]).toMatchObject({
      success: true,
      removed: [{ name: 'Zäher Hund', type: 'advantage' }],
      ap: { refunded: 20 },
    });
  });
});
