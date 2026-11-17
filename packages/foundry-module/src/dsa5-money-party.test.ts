import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  amountToCoinText,
  amountToPaymentInput,
  dsa5Money,
  dsa5Party,
  moneyHtmlToText,
  resolveDsa5Actor,
  resolveDsa5Party,
} from './dsa5-money-party.js';

const COINS: Array<[string, number]> = [
  ['Dukaten', 10],
  ['Silber', 1],
  ['Heller', 0.1],
  ['Kreuzer', 0.01],
];

function coinItems(counts: number[] = [0, 0, 0, 0]): any[] {
  return COINS.map(([name, value], i) => ({
    id: `coin-${name}`,
    name,
    type: 'money',
    system: { price: { value }, quantity: { value: counts[i] }, subcategory: 0 },
  }));
}

function sumOf(actor: any): number {
  return actor.items
    .filter((i: any) => i.type === 'money')
    .reduce((s: number, i: any) => s + i.system.quantity.value * i.system.price.value, 0);
}

function makeActor(id: string, name: string, opts: Record<string, any> = {}): any {
  const actor: any = {
    id,
    name,
    uuid: `Actor.${id}`,
    type: opts.type ?? 'character',
    hasPlayerOwner: opts.hasPlayerOwner ?? false,
    items: opts.items ?? coinItems(opts.coins),
    statuses: new Set(opts.statuses ?? []),
    system: {
      status: {
        wounds: { value: 20, max: 30 },
        astralenergy: { value: 0, max: 0 },
        karmaenergy: { value: 10, max: 20 },
        fatePoints: { value: opts.fate ?? 3, max: 3, current: 3 },
      },
      condition: opts.condition ?? {},
      ...(opts.system ?? {}),
    },
    update: vi.fn(async (data: Record<string, any>) => {
      if ('system.status.fatePoints.value' in data) {
        actor.system.status.fatePoints.value = data['system.status.fatePoints.value'];
      }
    }),
    createEmbeddedDocuments: vi.fn(async (_type: string, items: any[]) => {
      actor.items.push(...items.map((i, n) => ({ ...i, id: `new-${n}` })));
    }),
  };
  return actor;
}

function setup(actors: any[], settings: Record<string, any> = {}) {
  const store: Record<string, any> = {
    'dsa5.primaryParty': '',
    'dsa5.trackedActors': { actors: [] },
    'dsa5.groupschips': '2/4',
    'dsa5.enableMoneyTracking': false,
    ...settings,
  };
  // Simplified DSA5Payment: amounts in Silbertaler, the whole purse is rewritten as Silber.
  const executePayment = vi.fn(async (actor: any, mode: string, money: number) => {
    const sum = sumOf(actor);
    if (mode === 'pay' && sum < money) return { success: false, msg: 'cannot pay' };
    const next = mode === 'pay' ? sum - money : sum + money;
    for (const item of actor.items) {
      if (item.type === 'money') item.system.quantity.value = item.name === 'Silber' ? next : 0;
    }
    return { success: true, msg: `<b>${actor.name}</b> ok`, money };
  });
  const DSA5Payment = {
    executePayment,
    evaluatePaymentAmount: vi.fn(async (input: any) => {
      const n = Number(String(input).replace(',', '.'));
      return n > 0 ? { money: n, roll: { isDeterministic: true } } : false;
    }),
    canPay: vi.fn(async (actor: any, money: number) => {
      const sum = sumOf(actor);
      return {
        success: sum >= money,
        msg: sum >= money ? 'ok' : `<b>${actor.name}</b> kann nicht bezahlen`,
        actorsMoney: { sum },
      };
    }),
  };
  const setTrackedHeros = vi.fn(async (ids: string[]) => {
    store['dsa5.trackedActors'] = { actors: ids };
  });
  const actorList = Object.assign([...actors], {
    get: (id: string) => actors.find(a => a.id === id),
    has: (id: string) => actors.some(a => a.id === id),
  });
  vi.stubGlobal('game', {
    actors: actorList,
    scenes: [],
    journal: [],
    i18n: { localize: (k: string) => (k === 'CONDITION.inpain' ? 'Schmerz' : k) },
    settings: {
      get: (ns: string, key: string) => store[`${ns}.${key}`],
      set: vi.fn(async (ns: string, key: string, value: any) => {
        store[`${ns}.${key}`] = value;
      }),
    },
    dsa5: {
      apps: {
        DSA5Payment,
        DSA5_Utility: { allMoneyItems: vi.fn(async () => coinItems()) },
        gameMasterMenu: { setTrackedHeros, rendered: false },
      },
    },
  });
  vi.stubGlobal('foundry', { utils: { deepClone: (x: any) => JSON.parse(JSON.stringify(x)) } });
  vi.stubGlobal('CONFIG', { statusEffects: [{ id: 'inpain', name: 'CONDITION.inpain' }] });
  vi.stubGlobal('fromUuidSync', (uuid: string) => actors.find(a => a.uuid === uuid));
  return { store, DSA5Payment, setTrackedHeros };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('amount helpers', () => {
  it('converts per-coin amounts to Silbertaler and validates input', () => {
    expect(amountToPaymentInput({ dukaten: 1, heller: 3 })).toEqual({ input: 10.3 });
    expect(amountToPaymentInput(2.5)).toEqual({ input: 2.5 });
    expect(amountToPaymentInput(' 1W6*10 ')).toEqual({ input: '1W6*10' });
    expect(amountToPaymentInput({ kreuzer: 0 }).error).toBeDefined();
    expect(amountToPaymentInput({ taler: 1 } as any).error).toContain('Unknown coin');
    expect(amountToPaymentInput({ heller: 1.5 }).error).toBeDefined();
    expect(amountToPaymentInput(-1).error).toBeDefined();
    expect(amountToPaymentInput(undefined).error).toBeDefined();
  });

  it('prints amounts in whole coins without floating point drift', () => {
    expect(amountToCoinText(0.3)).toBe('3 Heller');
    expect(
      amountToCoinText(12.05, [
        { name: 'Silber', value: 1 },
        { name: 'Kreuzer', value: 0.01 },
      ])
    ).toBe('12 Silber 5 Kreuzer');
  });

  it('keeps coin names from the system message icons', () => {
    const html =
      '<b>Alrike</b> zahlt <span class="nobr">3 <span data-tooltip="Heller" class="chatmoney"></span></span>.';
    expect(moneyHtmlToText(html)).toBe('Alrike zahlt 3 Heller.');
  });
});

describe('actor and party resolution', () => {
  it('refuses ambiguous names instead of picking the first match', () => {
    setup([makeActor('a1', 'Probe A'), makeActor('a2', 'Probe B')]);
    expect(resolveDsa5Actor('Probe').error).toContain('several actors');
    expect(resolveDsa5Actor('probe a').actor?.id).toBe('a1');
    expect(resolveDsa5Actor('a2').actor?.name).toBe('Probe B');
  });

  it('uses primary party members, then GM menu heroes, then player-owned actors', () => {
    const a = makeActor('a1', 'A', { hasPlayerOwner: true });
    const b = makeActor('b1', 'B');
    const group = makeActor('g1', 'Gruppe', { type: 'group', system: { actors: new Set([b]) } });
    setup([a, b, group]);
    expect(resolveDsa5Party()).toMatchObject({ source: 'playerOwned', actors: [a] });

    setup([a, b, group], { 'dsa5.trackedActors': { actors: ['b1', 'a1'] } });
    expect(resolveDsa5Party()).toMatchObject({ source: 'gmMenu', actors: [b, a] });

    setup([a, b, group], { 'dsa5.primaryParty': 'Actor.g1' });
    expect(resolveDsa5Party()).toMatchObject({ source: 'primaryParty', actors: [b] });
  });
});

describe('dsa5Money', () => {
  let rich: any;
  let poor: any;
  beforeEach(() => {
    rich = makeActor('r1', 'Reich', { coins: [1, 0, 0, 0], hasPlayerOwner: true });
    poor = makeActor('p1', 'Arm', { coins: [0, 0, 2, 0], hasPlayerOwner: true });
  });

  it('refuses a party payment entirely when one member cannot afford it', async () => {
    const { DSA5Payment } = setup([rich, poor]);
    const result = await dsa5Money({ action: 'pay', party: true, amount: 1 });
    expect(result.success).toBe(false);
    expect(result.refused).toEqual([
      expect.objectContaining({ name: 'Arm', available: 0.2, missing: 0.8 }),
    ]);
    expect(DSA5Payment.executePayment).not.toHaveBeenCalled();
  });

  it("pays through the system's executePayment with tracking and optional chat", async () => {
    const { DSA5Payment } = setup([rich, poor]);
    const result = await dsa5Money({
      action: 'pay',
      actors: ['Reich'],
      amount: { heller: 3 },
      postToChat: true,
      description: 'Brot',
    });
    expect(result.success).toBe(true);
    expect(DSA5Payment.executePayment).toHaveBeenCalledWith(
      rich,
      'pay',
      0.3,
      expect.objectContaining({ track: true, showChatMessage: true, description: 'Brot' })
    );
    expect(result.actors[0]).toMatchObject({
      before: { total: 10 },
      after: { total: 9.7 },
      amountText: '3 Heller',
      tracker: { status: 'disabled' },
      message: 'Reich ok',
    });
  });

  it('gives an actor without coin items the standard coins before receiving', async () => {
    const bare = makeActor('n1', 'Ohne', { items: [] });
    setup([bare]);
    const result = await dsa5Money({ action: 'receive', actors: ['Ohne'], amount: 2 });
    expect(result.success).toBe(true);
    expect(bare.createEmbeddedDocuments).toHaveBeenCalledTimes(1);
    expect(result.actors[0]).toMatchObject({
      coinsCreated: true,
      before: { coins: {}, total: 0 },
      after: { total: 2 },
      tracker: { status: 'disabled' },
    });
  });

  it('requires targets for writes and refuses a transfer the payer cannot afford', async () => {
    const { DSA5Payment } = setup([rich, poor]);
    expect((await dsa5Money({ action: 'receive', amount: 1 })).success).toBe(false);
    const result = await dsa5Money({ action: 'transfer', from: 'Arm', to: 'Reich', amount: 5 });
    expect(result.success).toBe(false);
    expect(DSA5Payment.executePayment).not.toHaveBeenCalled();
  });

  it('transfers by paying then receiving', async () => {
    const { DSA5Payment } = setup([rich, poor]);
    const result = await dsa5Money({ action: 'transfer', from: 'Reich', to: 'Arm', amount: 4 });
    expect(result.success).toBe(true);
    expect(DSA5Payment.executePayment.mock.calls.map(c => [c[0].name, c[1], c[2]])).toEqual([
      ['Reich', 'pay', 4],
      ['Arm', 'getPaid', 4],
    ]);
    expect(result.actors.map((a: any) => a.after.total)).toEqual([6, 4.2]);
  });
});

describe('dsa5Party', () => {
  it('lists members with pools, schips, money and conditions', async () => {
    const hero = makeActor('h1', 'Held', {
      hasPlayerOwner: true,
      coins: [1, 2, 0, 0],
      statuses: ['inpain'],
      condition: { inpain: 2 },
    });
    setup([hero]);
    const result = await dsa5Party({ action: 'get' });
    expect(result).toMatchObject({
      success: true,
      source: 'playerOwned',
      group: null,
      groupSchips: { current: 2, max: 4 },
      memberMoneyTotal: 12,
    });
    expect(result.members[0]).toEqual({
      id: 'h1',
      name: 'Held',
      type: 'character',
      LeP: '20/30',
      KaP: '10/20',
      schips: '3/3',
      money: 12,
      conditions: ['Schmerz 2'],
    });
  });

  it('uses, restores and sets the group Schicksalspunkte in the setting', async () => {
    const { store } = setup([]);
    expect(await dsa5Party({ action: 'schips', operation: 'use' })).toMatchObject({
      after: { current: 1, max: 4 },
    });
    expect((await dsa5Party({ action: 'schips', operation: 'use', amount: 2 })).success).toBe(
      false
    );
    await dsa5Party({ action: 'schips', operation: 'restore' });
    expect(store['dsa5.groupschips']).toBe('4/4');
    await dsa5Party({ action: 'schips', operation: 'set', max: 2 });
    expect(store['dsa5.groupschips']).toBe('2/2');
    expect((await dsa5Party({ action: 'schips', operation: 'set', value: 3 })).success).toBe(false);
  });

  it("changes a hero's current Schicksalspunkte within the maximum", async () => {
    const hero = makeActor('h1', 'Held', { fate: 1 });
    setup([hero]);
    expect(
      (await dsa5Party({ action: 'schips', target: 'Held', operation: 'use', amount: 2 })).success
    ).toBe(false);
    await dsa5Party({ action: 'schips', target: 'Held', operation: 'restore' });
    expect(hero.update).toHaveBeenCalledWith({ 'system.status.fatePoints.value': 3 });
    expect(
      (await dsa5Party({ action: 'schips', target: 'Held', operation: 'set', value: 4 })).success
    ).toBe(false);
  });

  it("adds and removes members through the group actor's own API", async () => {
    const hero = makeActor('h1', 'Held');
    const addMember = vi.fn();
    const removeMember = vi.fn();
    const group = makeActor('g1', 'Gruppe', {
      type: 'group',
      system: {
        members: { k1: { uuid: 'Actor.h1' } },
        actors: new Set([hero]),
        addMember,
        removeMember,
      },
    });
    const other = makeActor('o1', 'Andere');
    setup([hero, group, other], { 'dsa5.primaryParty': 'Actor.g1' });
    expect(await dsa5Party({ action: 'add-member', actor: 'Held' })).toMatchObject({
      changed: false,
    });
    await dsa5Party({ action: 'add-member', actor: 'Andere' });
    expect(addMember).toHaveBeenCalledWith(other);
    await dsa5Party({ action: 'remove-member', actor: 'Held' });
    expect(removeMember).toHaveBeenCalledWith('k1');
    expect((await dsa5Party({ action: 'add-member', actor: 'Gruppe' })).success).toBe(false);
  });

  it("edits the GM menu's hero list when there is no group actor", async () => {
    const owned = makeActor('h1', 'Held', { hasPlayerOwner: true });
    const npc = makeActor('n1', 'Begleiter');
    const { setTrackedHeros } = setup([owned, npc]);
    const result = await dsa5Party({ action: 'add-member', actor: 'Begleiter' });
    // An empty list means "all player-owned actors", so those are kept.
    expect(setTrackedHeros).toHaveBeenCalledWith(['h1', 'n1']);
    expect(result).toMatchObject({ list: 'gmMenu', members: ['Held', 'Begleiter'] });
  });
});
