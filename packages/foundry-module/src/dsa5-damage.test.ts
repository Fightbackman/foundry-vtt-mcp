/**
 * DSA5 damage, healing, regeneration and AsP/KaP (dsa5-damage.ts, dsa5-opposed.ts).
 *
 * The DSA5 system is stubbed with the pieces the bridge calls: Actor#applyDamage /
 * applyMana / setupRegeneration / basicTest, the static Actordsa5.armorValue, the
 * RegenerationHelper and the chat context menu entries the system registers through the
 * getChatMessageContextOptions hook. What is checked is the glue: which system entry runs
 * with which message, what is refused before the system is called, and the report.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  applyDsa5Damage,
  diffConditions,
  dsa5SettleTiming,
  snapshotDsa5Actor,
} from './dsa5-damage.js';
import { findOpposedResultMessage, summarizeDsa5Opposed } from './dsa5-opposed.js';

type AnyRecord = Record<string, any>;

class StubActor {
  static armor = 0;
  static armorValue = vi.fn(() => ({ armor: StubActor.armor, wornArmor: [] }));

  name: string;
  isToken = false;
  token: AnyRecord | undefined;
  effects: AnyRecord[] = [];
  system: AnyRecord;
  powersource: AnyRecord | undefined;

  constructor(name: string, status: AnyRecord = {}) {
    this.name = name;
    this.system = {
      isMage: true,
      isPriest: false,
      status: {
        wounds: { value: 20, max: 30 },
        astralenergy: { value: 10, max: 20 },
        karmaenergy: { value: 0, max: 0 },
        regeneration: { LePmax: 1, AsPmax: 0, KaPmax: 0 },
        ...status,
      },
    };
  }

  /** DSA5: a negative amount heals; LeP never exceed the maximum. Adds pain like the system. */
  applyDamage = vi.fn(async (amount: number) => {
    const wounds = this.system.status.wounds;
    wounds.value = Math.min(wounds.max, wounds.value - amount);
    const pain = Math.floor((1 - wounds.value / wounds.max) * 4);
    this.effects = this.effects.filter(e => !e.statuses.has('inpain'));
    if (pain > 0) {
      this.effects.push({
        id: 'pain',
        name: 'Pain',
        statuses: new Set(['inpain']),
        system: { condition: { value: pain } },
      });
    }
  });

  applyMana = vi.fn(async (amount: number, type: string) => {
    const pool = this.system.status[type === 'AsP' ? 'astralenergy' : 'karmaenergy'];
    const next = Math.min(pool.max, pool.value - amount);
    if (next < 0) {
      (globalThis as any).ui.notifications.error(`DSAError.NotEnough${type}`, { localize: true });
      return false;
    }
    pool.value = next;
    return true;
  });

  update = vi.fn(async () => this);
  setupRegeneration = vi.fn(async () => ({
    testData: {
      situationalModifiers: [{ name: 'Off', value: 2, selected: false }],
      source: { type: 'regenerate' },
      extra: { options: {} },
    },
    cardOptions: {},
  }));
  basicTest = vi.fn(async () => ({ result: { LeP: 4, AsP: 2, messageId: 'regen-1' } }));
  getActiveTokens = () => [{ id: 'token-hero' }];
}

let messages: Map<string, AnyRecord>;
let contextOptions: AnyRecord[];
let regenerationHelper: AnyRecord;
let notifications: AnyRecord;

function addMessage(message: AnyRecord): AnyRecord {
  const stored = { flags: {}, update: vi.fn(async () => stored), ...message };
  messages.set(stored.id, stored);
  return stored;
}

function contextOption(visibleName: string, onClick: (event: unknown, li: any) => unknown) {
  const visible = { [visibleName]: () => true }[visibleName];
  return { label: visibleName, visible, onClick };
}

function stubFoundry(speakers: Record<string, any>) {
  notifications = { error: vi.fn(), warn: vi.fn() };
  vi.stubGlobal('ui', { notifications, chat: {} });
  vi.stubGlobal('Hooks', {
    call: vi.fn((hook: string, _app: unknown, options: AnyRecord[]) => {
      if (hook === 'getChatMessageContextOptions') options.push(...contextOptions);
      return true;
    }),
  });
  vi.stubGlobal(
    'Roll',
    class {
      constructor(public formula: string) {}
      async evaluate() {
        if (!/d/.test(this.formula)) throw new Error('bad formula');
        return { total: 9 };
      }
    }
  );
  vi.stubGlobal('game', {
    i18n: { localize: (key: string) => key },
    messages: { get: (id: string) => messages.get(id) },
    actors: { get: () => undefined },
    dsa5: {
      config: {
        regnerationCampLocations: { 0: 'camp.normal', '-1': 'camp.bad', 1: 'camp.good' },
        regenerationInterruptOptions: { 0: 'int.none', '-1': 'int.small', '-2': 'int.big' },
      },
      apps: {
        DSA5_Utility: {
          getSpeaker: (speaker: AnyRecord) => speakers[speaker?.token ?? speaker?.alias],
        },
        RegenerationHelper: regenerationHelper,
      },
    },
  });
}

beforeEach(() => {
  dsa5SettleTiming.intervalMs = 0;
  StubActor.armor = 0;
  messages = new Map();
  contextOptions = [];
  regenerationHelper = {
    hasNegative: (data: AnyRecord) => ['LeP', 'AsP', 'KaP'].some(k => Number(data[k]) < 0),
    normalizeAmounts: (data: AnyRecord) => ({
      LeP: Number(data.LeP) || 0,
      AsP: Number(data.AsP) || 0,
      KaP: Number(data.KaP) || 0,
    }),
    hasRegenStats: (data: AnyRecord) => ['LeP', 'AsP', 'KaP'].some(k => data?.[k] !== undefined),
    isApplied: (message: AnyRecord) => Boolean(message.flags?.data?.healApplied),
    getActorFromMessage: vi.fn(),
    regenerationPhaseBlocks: () => [],
    applyFromMessage: vi.fn(async () => true),
    applyToActor: vi.fn(async () => true),
    markApplied: vi.fn(async () => undefined),
  };
});

afterEach(() => vi.unstubAllGlobals());

/** Attack card -> start message -> defense -> opposed result card, as DSA5 links them. */
function opposedChain(damage: AnyRecord, extra: AnyRecord = {}) {
  addMessage({
    id: 'result-1',
    flags: {
      opposeData: {
        winner: 'attacker',
        result: '<b>Alrike</b> wins against <b>Wolf</b>',
        speakerAttack: { alias: 'Alrike', token: 'token-hero' },
        speakerDefend: { alias: 'Wolf', token: 'token-wolf' },
        damage,
      },
      dsa5: { opposedMeta: { attackerMessageId: 'attack-1' } },
      ...extra,
    },
  });
  addMessage({
    id: 'defense-1',
    flags: { data: { attackerMessage: 'attack-1' }, dsa5: { opposedResultMessageId: 'result-1' } },
  });
  addMessage({
    id: 'attack-1',
    flags: { data: { defenderMessage: ['defense-1'], startMessagesList: ['start-1'] } },
  });
  addMessage({
    id: 'start-1',
    flags: { unopposeData: { targetSpeaker: { token: 'token-wolf', alias: 'Wolf' } } },
  });
}

describe('damage from an opposed result card', () => {
  it("runs DSA5's 'apply damage as TP' entry for the result behind an attack card", async () => {
    const wolf = new StubActor('Wolf');
    wolf.isToken = true;
    wolf.token = { id: 'token-wolf' };
    stubFoundry({ 'token-wolf': wolf });
    opposedChain({ value: 5, sp: 7 });
    const hurt = vi.fn(async (_event: unknown, li: any) => {
      expect(li.dataset.messageId).toBe('result-1');
      await wolf.applyDamage(5);
      messages.get('result-1')!.flags.data = { damageApplied: true };
    });
    contextOptions = [contextOption('canHurtSP', vi.fn()), contextOption('canHurt', hurt)];

    const result = await applyDsa5Damage(undefined, { action: 'damage', messageId: 'attack-1' });

    expect(hurt).toHaveBeenCalledOnce();
    expect(result).toMatchObject({
      success: true,
      messageId: 'result-1',
      actorName: 'Wolf',
      tokenId: 'token-wolf',
      rolled: 7,
      armor: 2,
      applied: 5,
      before: { LeP: 20, AsP: 10 },
      after: { LeP: 15, AsP: 10 },
      conditions: { added: [{ id: 'inpain', name: 'Pain', level: 2 }] },
    });
  });

  it("uses the 'apply damage as SP' entry with armor: false", async () => {
    const wolf = new StubActor('Wolf');
    stubFoundry({ 'token-wolf': wolf });
    opposedChain({ value: 0, sp: 3 });
    const hurtSP = vi.fn(async () => {
      await wolf.applyDamage(3);
      messages.get('result-1')!.flags.data = { damageApplied: true };
    });
    contextOptions = [contextOption('canHurt', vi.fn()), contextOption('canHurtSP', hurtSP)];

    const result = await applyDsa5Damage(undefined, {
      action: 'damage',
      messageId: 'result-1',
      armor: false,
    });
    expect(hurtSP).toHaveBeenCalledOnce();
    expect(result).toMatchObject({ success: true, applied: 3, after: { LeP: 17 } });
    expect(result.armor).toBeUndefined();
  });

  it('refuses when armor absorbs everything, when already applied and when the defender won', async () => {
    const wolf = new StubActor('Wolf');
    stubFoundry({ 'token-wolf': wolf });
    const hurt = vi.fn();
    contextOptions = [contextOption('canHurt', hurt)];

    opposedChain({ value: -2, sp: 1 });
    let result = await applyDsa5Damage(undefined, { action: 'damage', messageId: 'result-1' });
    expect(result.error).toContain('armor: false');

    opposedChain({ value: 4, sp: 4 }, { data: { damageApplied: true } });
    result = await applyDsa5Damage(undefined, { action: 'damage', messageId: 'result-1' });
    expect(result.error).toContain('already been applied');

    opposedChain({ value: 4, sp: 4 });
    messages.get('result-1')!.flags.opposeData.winner = 'defender';
    result = await applyDsa5Damage(undefined, { action: 'damage', messageId: 'result-1' });
    expect(result.error).toContain('defender won');

    expect(hurt).not.toHaveBeenCalled();
    expect(wolf.applyDamage).not.toHaveBeenCalled();
  });

  it('reports a pending opposed test instead of applying anything', async () => {
    stubFoundry({});
    addMessage({ id: 'attack-2', flags: { data: { startMessagesList: ['start-2'] } } });
    addMessage({ id: 'start-2', flags: { unopposeData: { targetSpeaker: { token: 't' } } } });
    const result = await applyDsa5Damage(undefined, { action: 'damage', messageId: 'attack-2' });
    expect(result.success).toBe(false);
    expect(result.error).toContain('still pending');
  });

  it('points to "amount" for an attack card without a target', async () => {
    stubFoundry({});
    addMessage({ id: 'attack-3', flags: { data: { postData: { damage: 6 } } }, isRoll: true });
    const result = await applyDsa5Damage(undefined, { action: 'damage', messageId: 'attack-3' });
    expect(result.error).toContain('amount 6');
  });
});

describe('direct damage and healing', () => {
  it('subtracts the target armor from the TP like DSA5 does for damage cards', async () => {
    stubFoundry({});
    StubActor.armor = 3;
    const hero = new StubActor('Alrike');
    const result = await applyDsa5Damage(hero, { action: 'damage', amount: '2d6+2' });
    expect(hero.applyDamage).toHaveBeenCalledWith(6);
    expect(result).toMatchObject({
      success: true,
      rolled: 9,
      formula: '2d6+2',
      armor: 3,
      applied: 6,
      before: { LeP: 20 },
      after: { LeP: 14 },
    });
  });

  it('applies SP without armor and refuses non-positive or invalid amounts', async () => {
    stubFoundry({});
    StubActor.armor = 3;
    const hero = new StubActor('Alrike');
    await applyDsa5Damage(hero, { action: 'damage', amount: 4, armor: false });
    expect(hero.applyDamage).toHaveBeenCalledWith(4);
    expect((await applyDsa5Damage(hero, { action: 'damage', amount: 0 })).success).toBe(false);
    expect((await applyDsa5Damage(hero, { action: 'damage', amount: 'lots' })).error).toContain(
      'not a valid'
    );
  });

  it('applies the damage of a plain roll card to the named actor', async () => {
    stubFoundry({});
    const hero = new StubActor('Alrike');
    const card = addMessage({ id: 'roll-1', isRoll: true, rolls: [{ total: 5 }] });
    const result = await applyDsa5Damage(hero, { action: 'damage', messageId: 'roll-1' });
    expect(hero.applyDamage).toHaveBeenCalledWith(5);
    expect(result).toMatchObject({ success: true, messageId: 'roll-1', applied: 5 });
    expect(card.update).toHaveBeenCalledWith({ 'flags.data.damageApplied': true });
  });

  it('heals LeP through applyDamage and reports the cap at the maximum', async () => {
    stubFoundry({});
    const hero = new StubActor('Alrike');
    const result = await applyDsa5Damage(hero, { action: 'heal', amount: 30 });
    expect(hero.applyDamage).toHaveBeenCalledWith(-30);
    expect(result).toMatchObject({ success: true, applied: 10, after: { LeP: 30 } });
    expect(result.message).toContain('capped');
  });

  it('restores AsP through applyMana and refuses pools the actor lacks', async () => {
    stubFoundry({});
    const hero = new StubActor('Alrike');
    const result = await applyDsa5Damage(hero, { action: 'heal', resource: 'AsP', amount: 4 });
    expect(hero.applyMana).toHaveBeenCalledWith(-4, 'AsP');
    expect(result).toMatchObject({ success: true, applied: 4, after: { AsP: 14 } });
    const kap = await applyDsa5Damage(hero, { action: 'heal', resource: 'KaP', amount: 4 });
    expect(kap.error).toContain('has no KaP');
  });
});

describe('spending AsP/KaP and paying spell costs', () => {
  it("spends AsP and reports the system's refusal when too few are left", async () => {
    stubFoundry({});
    const hero = new StubActor('Alrike');
    const ok = await applyDsa5Damage(hero, { action: 'spend', resource: 'AsP', amount: 3 });
    expect(hero.applyMana).toHaveBeenCalledWith(3, 'AsP', { skipPowerSource: true });
    expect(ok).toMatchObject({ success: true, before: { AsP: 10 }, after: { AsP: 7 } });

    const refused = await applyDsa5Damage(hero, { action: 'spend', resource: 'AsP', amount: 50 });
    expect(refused.success).toBe(false);
    expect(refused.error).toContain('has only 7 AsP');
    expect(refused.notifications).toEqual(['DSAError.NotEnoughAsP']);
    expect(notifications.error).toHaveBeenCalled();
  });

  function spellCard(cost: number, type = 'spell') {
    return addMessage({
      id: 'spell-1',
      speaker: { token: 'token-hero' },
      flags: {
        data: {
          preData: {
            source: { name: 'Ignifaxius', type },
            calculatedSpellModifiers: { finalcost: cost },
          },
        },
      },
    });
  }

  it("pays the cost through DSA5's 'pay AsP/KaP' entry", async () => {
    const hero = new StubActor('Alrike');
    stubFoundry({ 'token-hero': hero });
    const card = spellCard(8);
    const pay = vi.fn(async (_event: unknown, li: any) => {
      expect(li.dataset.messageId).toBe('spell-1');
      await hero.applyMana(8, 'AsP');
      card.flags.data.manaApplied = true;
    });
    contextOptions = [contextOption('canCostMana', pay)];
    hero.system.status.astralenergy.value = 12;

    const result = await applyDsa5Damage(undefined, { action: 'pay-cost', messageId: 'spell-1' });
    expect(pay).toHaveBeenCalledOnce();
    expect(result).toMatchObject({
      success: true,
      resource: 'AsP',
      applied: 8,
      before: { AsP: 12 },
      after: { AsP: 4 },
    });

    const again = await applyDsa5Damage(undefined, { action: 'pay-cost', messageId: 'spell-1' });
    expect(again.error).toContain('already been paid');
  });

  it('refuses before calling DSA5 when the caster lacks the points', async () => {
    const hero = new StubActor('Alrike');
    stubFoundry({ 'token-hero': hero });
    spellCard(16);
    const pay = vi.fn();
    contextOptions = [contextOption('canCostMana', pay)];
    const result = await applyDsa5Damage(undefined, { action: 'pay-cost', messageId: 'spell-1' });
    expect(result.error).toContain('has only 10 AsP but Ignifaxius costs 16');
    expect(pay).not.toHaveBeenCalled();
  });

  it('refuses when charged power sources would make DSA5 ask in a dialog', async () => {
    const hero = new StubActor('Alrike');
    hero.powersource = { segments: [{ value: 3 }] };
    stubFoundry({ 'token-hero': hero });
    spellCard(2);
    const result = await applyDsa5Damage(undefined, { action: 'pay-cost', messageId: 'spell-1' });
    expect(result.error).toContain('power sources');
  });

  it('pays liturgies with KaP', async () => {
    const hero = new StubActor('Alrike', { karmaenergy: { value: 1, max: 10 } });
    stubFoundry({ 'token-hero': hero });
    spellCard(4, 'liturgy');
    contextOptions = [contextOption('canCostMana', vi.fn())];
    const result = await applyDsa5Damage(undefined, { action: 'pay-cost', messageId: 'spell-1' });
    expect(result.error).toContain('has only 1 KaP');
  });
});

describe('regeneration', () => {
  it('rolls the regeneration test like the confirmed dialog and applies the card', async () => {
    stubFoundry({});
    const hero = new StubActor('Alrike');
    const card = addMessage({ id: 'regen-1', flags: { data: { postData: { LeP: 4, AsP: 2 } } } });

    const result = await applyDsa5Damage(hero, {
      action: 'regenerate',
      campsite: 'good',
      interruption: 'small',
      badEnvironment: true,
      modifier: 1,
      resources: ['LeP'],
    });

    expect(hero.setupRegeneration).toHaveBeenCalledWith(
      'regenerate',
      { bypass: true },
      'token-hero'
    );
    const setup = (hero.basicTest.mock.calls[0] as any[])[0];
    const testData = setup.testData;
    expect(testData.situationalModifiers).toEqual([
      { name: 'manual', value: 1, type: '' },
      { name: 'camplocation - camp.good', value: 1 },
      { name: 'interruption - int.small', value: -1 },
    ]);
    expect(testData).toMatchObject({
      regenerationFactor: 0.5,
      regenerateLeP: 1,
      regenerateAsP: 0,
      regenerateKaP: 0,
      regenerationLeP: 1,
    });
    expect(hero.update).toHaveBeenCalledWith({ 'system.status.regeneration.LePTemp': 0 });
    expect(regenerationHelper.applyFromMessage).toHaveBeenCalledWith(card, { allowGM: true });
    expect(result).toMatchObject({
      success: true,
      messageId: 'regen-1',
      regeneration: { LeP: 4, AsP: 2 },
    });
  });

  it('only rolls with apply: false and applies a rolled card later by message id', async () => {
    stubFoundry({});
    const hero = new StubActor('Alrike');
    const card = addMessage({ id: 'regen-1', flags: { data: { postData: { LeP: 4 } } } });
    const rolled = await applyDsa5Damage(hero, { action: 'regenerate', apply: false });
    expect(rolled.message).toContain('not applied');
    expect(regenerationHelper.applyFromMessage).not.toHaveBeenCalled();

    card.flags.data.postData.rollType = 'regenerate';
    regenerationHelper.getActorFromMessage.mockReturnValue(hero);
    const applied = await applyDsa5Damage(undefined, {
      action: 'regenerate',
      messageId: 'regen-1',
    });
    expect(applied.success).toBe(true);
    expect(regenerationHelper.applyFromMessage).toHaveBeenCalledWith(card, { allowGM: true });
  });

  it('treats negative results as 0, as DSA5 does when the confirmation is declined', async () => {
    stubFoundry({});
    const hero = new StubActor('Alrike');
    const card = addMessage({
      id: 'regen-1',
      flags: { data: { postData: { rollType: 'regenerate', LeP: 2, AsP: -2 } } },
    });
    regenerationHelper.getActorFromMessage.mockReturnValue(hero);
    const result = await applyDsa5Damage(undefined, { action: 'regenerate', messageId: 'regen-1' });
    expect(regenerationHelper.applyToActor).toHaveBeenCalledWith(
      hero,
      { LeP: 2, AsP: 0, KaP: 0 },
      { skipConfirm: true }
    );
    expect(regenerationHelper.markApplied).toHaveBeenCalledWith(card);
    expect(result.notes?.[0]).toContain('negative');
  });
});

describe('snapshots and condition changes', () => {
  it('reports only the pools an actor has and diffs condition levels', () => {
    const hero = new StubActor('Alrike', { astralenergy: { value: 0, max: 0 } });
    hero.effects = [
      { id: 'a', name: 'Pain', statuses: new Set(['inpain']), system: { condition: { value: 1 } } },
      { id: 'b', name: 'Prone', statuses: new Set(['prone']), system: {} },
    ];
    const before = snapshotDsa5Actor(hero);
    expect(before.values).toEqual({ LeP: 20 });
    hero.effects = [
      { id: 'a', name: 'Pain', statuses: new Set(['inpain']), system: { condition: { value: 3 } } },
      { id: 'c', name: 'Incapacitated', statuses: new Set(['incapacitated']), system: {} },
    ];
    expect(diffConditions(before.conditions, snapshotDsa5Actor(hero).conditions)).toEqual({
      added: [{ id: 'incapacitated', name: 'Incapacitated', level: null }],
      removed: [{ id: 'prone', name: 'Prone', level: null }],
      changed: [{ id: 'inpain', name: 'Pain', from: 1, to: 3 }],
    });
  });
});

describe('opposed test summary', () => {
  it('reports pending targets of an attack with the token id to defend with', () => {
    stubFoundry({});
    addMessage({ id: 'attack-2', flags: { data: { startMessagesList: ['start-2'] } } });
    addMessage({
      id: 'start-2',
      flags: { unopposeData: { targetSpeaker: { token: 'token-wolf', alias: 'Wolf' } } },
    });
    expect(summarizeDsa5Opposed('attack-2')).toEqual([
      expect.objectContaining({
        role: 'attacker',
        status: 'pending',
        defender: 'Wolf',
        defenderTokenId: 'token-wolf',
        startMessageId: 'start-2',
      }),
    ]);
  });

  it('reports the resolved result, winner and damage of a defense', () => {
    stubFoundry({});
    opposedChain({ value: 5, sp: 7 });
    expect(summarizeDsa5Opposed('defense-1')).toEqual([
      expect.objectContaining({
        role: 'defender',
        status: 'resolved',
        resultMessageId: 'result-1',
        winner: 'attacker',
        winnerName: 'Alrike',
        result: 'Alrike wins against Wolf',
        damage: { rolled: 7, armor: 2, afterArmor: 5 },
        damageApplied: false,
      }),
    ]);
  });

  it('is empty for rolls outside an opposed test and asks to choose between several results', () => {
    stubFoundry({});
    addMessage({ id: 'plain', flags: { data: { postData: {} } } });
    expect(summarizeDsa5Opposed('plain')).toBeUndefined();

    addMessage({ id: 'r1', flags: { opposeData: {} } });
    addMessage({ id: 'r2', flags: { opposeData: {} } });
    addMessage({ id: 'd1', flags: { dsa5: { opposedResultMessageId: 'r1' } } });
    addMessage({ id: 'd2', flags: { dsa5: { opposedResultMessageId: 'r2' } } });
    const attack = addMessage({ id: 'a', flags: { data: { defenderMessage: ['d1', 'd2'] } } });
    expect(findOpposedResultMessage(attack)).toEqual({ candidates: ['r1', 'r2'] });
  });
});
