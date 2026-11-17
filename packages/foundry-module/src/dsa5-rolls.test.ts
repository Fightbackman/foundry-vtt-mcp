/**
 * DSA5 rolls and item use (dsa5-rolls.ts).
 *
 * The DSA5 system is stubbed: setup*() returns prepared test data the way the system does
 * with `bypass: true`, and basicTest() returns a result shaped like DSA5 8.1.11's. What is
 * checked here is the glue: which system method runs, that the dialog is bypassed, that
 * the requested modifier lands in the "manual" field, and how results are summarized.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  applyDialogDefaults,
  dsa5ItemAction,
  parseDsa5Modifier,
  requestDsa5PlayerRoll,
  resolveDsa5Characteristic,
  rollDsa5Check,
  summarizeDsa5Result,
  useDsa5Item,
} from './dsa5-rolls.js';

const CHARACTERISTICS = {
  mu: 'CHAR.MU',
  kl: 'CHAR.KL',
  in: 'CHAR.IN',
  ch: 'CHAR.CH',
  ff: 'CHAR.FF',
  ge: 'CHAR.GE',
  ko: 'CHAR.KO',
  kk: 'CHAR.KK',
};

const I18N: Record<string, string> = {
  'CHAR.MU': 'Courage',
  'CHAR.KK': 'Strength',
  'CHARAbbrev.MU': 'COU',
  'CHARAbbrev.KK': 'STR',
  manual: 'Manual',
};

function stubGame(extra: Record<string, unknown> = {}) {
  vi.stubGlobal('game', {
    i18n: { localize: (key: string) => I18N[key] ?? key },
    dsa5: { config: { characteristics: CHARACTERISTICS } },
    ...extra,
  });
}

function skillResult(overrides: Record<string, unknown> = {}) {
  return {
    result: 2,
    qualityStep: 1,
    successLevel: 1,
    description: 'Success',
    modifiers: -2,
    rollType: 'talent',
    characteristics: [
      { char: 'mu', res: 9, suc: true, tar: 10 },
      { char: 'ge', res: 13, suc: false, tar: 6 },
      { char: 'kk', res: 6, suc: true, tar: 6 },
    ],
    messageId: 'msg-1',
    ...overrides,
  };
}

function makeActor(items: any[] = []) {
  const setup = () =>
    Promise.resolve({
      testData: {
        situationalModifiers: [{ name: 'Pain', value: -1, type: '', selected: true }],
        source: { type: 'skill' },
      },
      cardOptions: {},
    });
  return {
    id: 'actor-1',
    name: 'Alrike',
    items,
    getActiveTokens: () => [{ id: 'token-1' }],
    setupSkill: vi.fn(setup),
    setupCharacteristic: vi.fn(setup),
    setupWeapon: vi.fn(setup),
    setupWeaponless: vi.fn(setup),
    setupDodge: vi.fn(setup),
    setupSpell: vi.fn(setup),
    basicTest: vi.fn(async () => ({ result: skillResult(), cardOptions: {} })),
  };
}

describe('DSA5 roll helpers', () => {
  beforeEach(() => stubGame());
  afterEach(() => vi.unstubAllGlobals());

  it('parses whole-number modifiers and rejects dice', () => {
    expect(parseDsa5Modifier('+2')).toBe(2);
    expect(parseDsa5Modifier(' -3 ')).toBe(-3);
    expect(parseDsa5Modifier('')).toBe(0);
    expect(parseDsa5Modifier(undefined)).toBe(0);
    expect(parseDsa5Modifier(4)).toBe(4);
    expect(parseDsa5Modifier('+1d4')).toBeNull();
    expect(parseDsa5Modifier(1.5)).toBeNull();
  });

  it('resolves attributes by key, localized abbreviation or localized name', () => {
    expect(resolveDsa5Characteristic('MU')).toBe('mu');
    expect(resolveDsa5Characteristic('cou')).toBe('mu');
    expect(resolveDsa5Characteristic('Strength')).toBe('kk');
    expect(resolveDsa5Characteristic('luck')).toBeNull();
  });

  it('applies the dialog defaults to bypassed setup data', () => {
    const setup = {
      testData: {
        situationalModifiers: [
          { name: 'Pain', value: -1, type: '', selected: true },
          { name: 'Optional maneuver', value: -2, type: '', selected: false },
          { name: 'Weapon damage', value: 2, type: 'dmg' },
        ],
        source: { type: 'skill' },
      },
    };

    applyDialogDefaults(setup, 3);

    expect(setup.testData.situationalModifiers).toEqual([
      { name: 'Pain', value: -1, type: '', selected: true },
      { name: 'Weapon damage', value: 0, type: 'dmg', damageBonus: 2 },
      { name: 'Manual', value: 3, type: '' },
    ]);
  });

  it("seeds a bypassed spell's cost and casting data from the spell", () => {
    const setup: any = {
      testData: {
        situationalModifiers: [],
        source: {
          type: 'spell',
          system: {
            AsPCost: { value: 8 },
            castingTime: { value: 2 },
            range: { value: '16 steps' },
            maintainCost: { value: '' },
          },
        },
        calculatedSpellModifiers: { castingTime: 0, cost: 0, reach: 0, maintainCost: 0 },
      },
    };

    applyDialogDefaults(setup, 0);

    expect(setup.testData.calculatedSpellModifiers).toEqual({
      castingTime: '2',
      cost: '8',
      reach: '16 steps',
      maintainCost: '',
    });
  });

  it('summarizes a skill check with quality level and remaining skill points', () => {
    const summary = summarizeDsa5Result(skillResult(), 'skill');
    expect(summary).toEqual({
      outcome: 'success',
      successLevel: 1,
      description: 'Success',
      rollType: 'talent',
      dice: [
        { check: 'mu', roll: 9, target: 10, success: true },
        { check: 'ge', roll: 13, target: 6, success: false },
        { check: 'kk', roll: 6, target: 6, success: true },
      ],
      modifiers: -2,
      qualityStep: 1,
      remainingSkillPoints: 2,
      messageId: 'msg-1',
    });
  });

  it('treats a double 20 on a 3d20 check as a botch', () => {
    const summary = summarizeDsa5Result(skillResult({ successLevel: -2, qualityStep: 0 }));
    expect(summary.outcome).toBe('botch');
  });

  it('treats an unconfirmed critical or botch on a 1d20 check as success or failure', () => {
    const attack = (successLevel: number) =>
      summarizeDsa5Result({
        successLevel,
        description: 'x',
        characteristics: [{ char: 'attack', res: 1, suc: true, tar: 12 }],
      }).outcome;
    expect(attack(2)).toBe('success');
    expect(attack(3)).toBe('critical');
    expect(attack(-2)).toBe('failure');
    expect(attack(-3)).toBe('botch');
  });

  it('reports attack damage and strips HTML from descriptions', () => {
    const summary = summarizeDsa5Result({
      successLevel: 1,
      description: 'Success <a class="botch">table</a>',
      characteristics: [
        { char: 'attack', res: 4, suc: true, tar: 7 },
        { char: 'damage', res: 6, die: 'd6' },
      ],
      damage: 10,
      damageRoll: { formula: '1d6 + 4' },
      damagedescription: 'Roll 6 + Weapon Modifier 4',
    });
    expect(summary.description).toBe('Success table');
    expect(summary.dice).toEqual([
      { check: 'attack', roll: 4, target: 7, success: true },
      { check: 'damage', roll: 6 },
    ]);
    expect(summary.damage).toBe(10);
    expect(summary.damageFormula).toBe('1d6 + 4');
  });

  it("reads a spell's cost from the chat card once the card has been rendered", () => {
    stubGame({
      messages: {
        get: (id: string) =>
          id === 'msg-1'
            ? { flags: { data: { preData: { calculatedSpellModifiers: { finalcost: 4 } } } } }
            : undefined,
      },
    });
    const summary = summarizeDsa5Result(skillResult({ successLevel: -1 }), 'liturgy');
    expect(summary.cost).toMatchObject({ amount: 4, resource: 'KaP', paid: false });
  });
});

describe('rollDsa5Check', () => {
  beforeEach(() => stubGame());
  afterEach(() => vi.unstubAllGlobals());

  it('rolls a skill check without a dialog and puts the modifier in the manual field', async () => {
    const climbing = { id: 'skill-1', name: 'Climbing', type: 'skill' };
    const actor = makeActor([climbing]);

    const result = await rollDsa5Check(actor, { check: 'skill', name: 'climbing', modifier: -2 });

    expect(actor.setupSkill).toHaveBeenCalledWith(climbing, { bypass: true }, 'token-1');
    const setup = (actor.basicTest.mock.calls[0] as any[])[0];
    expect(setup.testData.situationalModifiers).toContainEqual({
      name: 'Manual',
      value: -2,
      type: '',
    });
    expect(result).toMatchObject({
      success: true,
      actorName: 'Alrike',
      check: 'skill',
      name: 'Climbing',
      roll: { outcome: 'success', qualityStep: 1, remainingSkillPoints: 2 },
    });
  });

  it('reports the opposed result a defense resolved, for the damage follow-up', async () => {
    const cards: Record<string, any> = {
      'msg-1': {
        id: 'msg-1',
        flags: { data: { attackerMessage: 'attack-1' }, dsa5: { opposedResultMessageId: 'res-1' } },
      },
      'res-1': {
        id: 'res-1',
        flags: {
          opposeData: {
            winner: 'attacker',
            speakerAttack: { alias: 'Alrike' },
            speakerDefend: { alias: 'Wolf', token: 'tok-w' },
            damage: { value: 5, sp: 5 },
          },
        },
      },
    };
    stubGame({ messages: { get: (id: string) => cards[id] } });
    const result = await rollDsa5Check(makeActor(), { check: 'dodge' });
    expect(result.roll?.opposed).toEqual([
      expect.objectContaining({
        role: 'defender',
        status: 'resolved',
        resultMessageId: 'res-1',
        winnerName: 'Alrike',
        damage: { rolled: 5, armor: 0, afterArmor: 5 },
      }),
    ]);
  });

  it('passes the message mode to the system', async () => {
    const actor = makeActor();
    await rollDsa5Check(actor, { check: 'attribute', name: 'KK', messageMode: 'gm' });
    expect(actor.setupCharacteristic).toHaveBeenCalledWith(
      'kk',
      { bypass: true, messageMode: 'gm' },
      'token-1'
    );
  });

  it('rolls attack and parry with weapons, traits and weaponless', async () => {
    const sword = { id: 'w1', name: 'Longsword', type: 'meleeweapon' };
    const bite = {
      id: 't1',
      name: 'Bite',
      type: 'trait',
      system: { traitType: { value: 'meleeAttack' } },
    };
    const actor = makeActor([sword, bite]);

    await rollDsa5Check(actor, { check: 'attack', name: 'Longsword' });
    await rollDsa5Check(actor, { check: 'parry', name: 'bite' });
    await rollDsa5Check(actor, { check: 'attack', name: 'weaponless' });
    await rollDsa5Check(actor, { check: 'dodge' });

    expect(actor.setupWeapon).toHaveBeenNthCalledWith(
      1,
      sword,
      'attack',
      { bypass: true },
      'token-1'
    );
    expect(actor.setupWeapon).toHaveBeenNthCalledWith(
      2,
      bite,
      'parry',
      { bypass: true },
      'token-1'
    );
    expect(actor.setupWeaponless).toHaveBeenCalledWith('attack', { bypass: true }, 'token-1');
    expect(actor.setupDodge).toHaveBeenCalledWith({ bypass: true }, 'token-1');
  });

  it('refuses to parry with a ranged combat skill', async () => {
    const crossbows = {
      id: 'c1',
      name: 'Crossbows',
      type: 'combatskill',
      system: { weapontype: { value: 1 } },
    };
    const actor = makeActor([crossbows]);
    const result = await rollDsa5Check(actor, { check: 'parry', name: 'Crossbows' });
    expect(result.success).toBe(false);
    expect(result.error).toContain('cannot be used to parry');
    expect(actor.setupWeapon).not.toHaveBeenCalled();
  });

  it('lists the available skills when a skill is unknown', async () => {
    const actor = makeActor([{ id: 's1', name: 'Climbing', type: 'skill' }]);
    const result = await rollDsa5Check(actor, { check: 'skill', name: 'Flying' });
    expect(result).toEqual({
      success: false,
      error: 'Skill "Flying" not found on Alrike. Skills: Climbing',
    });
  });

  it('reports when the system refuses to set up the test', async () => {
    const bow = { id: 'b1', name: 'Shortbow', type: 'rangeweapon' };
    const actor = makeActor([bow]);
    actor.setupWeapon.mockResolvedValueOnce(undefined as any);
    const result = await rollDsa5Check(actor, { check: 'attack', name: 'Shortbow' });
    expect(result.success).toBe(false);
    expect(result.error).toContain('did not start the test');
    expect(actor.basicTest).not.toHaveBeenCalled();
  });
});

describe('useDsa5Item', () => {
  beforeEach(() => stubGame());
  afterEach(() => vi.unstubAllGlobals());

  it('maps item types to what the character sheet does', () => {
    expect(dsa5ItemAction({ type: 'meleeweapon' })).toBe('attack');
    expect(dsa5ItemAction({ type: 'rangeweapon' })).toBe('attack');
    expect(dsa5ItemAction({ type: 'trait', system: { traitType: { value: 'rangeAttack' } } })).toBe(
      'attack'
    );
    expect(dsa5ItemAction({ type: 'trait', system: { traitType: { value: 'special' } } })).toBe(
      'post'
    );
    expect(dsa5ItemAction({ type: 'liturgy' })).toBe('spell');
    expect(dsa5ItemAction({ type: 'skill' })).toBe('skill');
    expect(dsa5ItemAction({ type: 'consumable' })).toBe('consume');
    expect(dsa5ItemAction({ type: 'armor' })).toBe('post');
  });

  it('attacks with a weapon and returns the roll', async () => {
    const sword = { id: 'w1', name: 'Longsword', type: 'meleeweapon' };
    const actor = makeActor([sword]);
    const result = await useDsa5Item(actor, sword);
    expect(actor.setupWeapon).toHaveBeenCalledWith(sword, 'attack', { bypass: true }, 'token-1');
    expect(result).toMatchObject({ success: true, status: 'completed', action: 'attack' });
    expect(result.roll?.outcome).toBe('success');
  });

  it('casts a spell through the system spell test', async () => {
    const spell = { id: 'sp1', name: 'Ignifaxius', type: 'spell' };
    const actor = makeActor([spell]);
    const result = await useDsa5Item(actor, spell);
    expect(actor.setupSpell).toHaveBeenCalledWith(spell, { bypass: true }, 'token-1');
    expect(result.action).toBe('spell');
  });

  it('opens the system dialog instead when skipDialog is false', async () => {
    const sword = { id: 'w1', name: 'Longsword', type: 'meleeweapon' };
    const actor = makeActor([sword]);
    const result = await useDsa5Item(actor, sword, { skipDialog: false });
    expect(actor.setupWeapon).toHaveBeenCalledWith(sword, 'attack', {}, 'token-1');
    expect(result).toMatchObject({ status: 'initiated', requiresGMInteraction: true });
  });

  it('consumes a consumable through setupEffect', async () => {
    const potion = {
      name: 'Healing Potion',
      type: 'consumable',
      system: { quantity: { value: 1 }, charges: 1, maxCharges: 1 },
      setupEffect: vi.fn().mockResolvedValue(undefined),
    };
    const result = await useDsa5Item(makeActor([potion]), potion);
    expect(potion.setupEffect).toHaveBeenCalledWith(null, {}, 'token-1');
    expect(result).toMatchObject({ success: true, status: 'consumed', action: 'consume' });
  });

  it('refuses a consumable without uses left', async () => {
    const potion = {
      name: 'Empty Flask',
      type: 'consumable',
      system: { quantity: { value: 1 }, charges: 0, maxCharges: 1 },
      setupEffect: vi.fn(),
    };
    const result = await useDsa5Item(makeActor([potion]), potion);
    expect(potion.setupEffect).not.toHaveBeenCalled();
    expect(result).toMatchObject({ success: false, status: 'failed' });
  });

  it('posts items without a use action to chat', async () => {
    const rope = {
      name: 'Rope',
      type: 'equipment',
      postItem: vi.fn().mockResolvedValue(undefined),
    };
    const result = await useDsa5Item(makeActor([rope]), rope);
    expect(rope.postItem).toHaveBeenCalledOnce();
    expect(result).toMatchObject({ success: true, status: 'posted', action: 'post' });
  });
});

describe('requestDsa5PlayerRoll', () => {
  let hooks: Map<number, (message: any) => void>;
  let createRequest: ReturnType<typeof vi.fn>;
  let actor: any;

  beforeEach(() => {
    hooks = new Map();
    let nextId = 1;
    vi.stubGlobal('Hooks', {
      on: vi.fn((_event: string, fn: (message: any) => void) => {
        const id = nextId++;
        hooks.set(id, fn);
        return id;
      }),
      off: vi.fn((_event: string, id: number) => hooks.delete(id)),
    });

    const player = { id: 'user-p', name: 'Mia', isGM: false };
    const gm = { id: 'user-gm', name: 'GM', isGM: true };
    actor = {
      id: 'actor-1',
      name: 'Alrike',
      type: 'character',
      hasPlayerOwner: true,
      items: [{ id: 's1', name: 'Climbing', type: 'skill' }],
      testUserPermission: (user: any) => user.id === 'user-p',
    };
    // Like DSA5: the card is created first, then createRequest waits for the player.
    createRequest = vi.fn((request: any) => {
      const message = {
        flags: {
          dsa5: {
            rollRequest: {
              category: request.category,
              name: request.name,
              recipients: [{ actorId: 'actor-1', designatedUserId: 'user-p', status: 'pending' }],
            },
          },
        },
      };
      for (const fn of [...hooks.values()]) fn(message);
      return new Promise(() => undefined);
    });
    const users = Object.assign([player, gm], {
      get: (id: string) => [player, gm].find(u => u.id === id),
    });
    stubGame({
      users,
      actors: [actor],
      dsa5: {
        config: { characteristics: CHARACTERISTICS },
        queries: { RollRequestService: { createRequest } },
      },
    });
  });

  afterEach(() => vi.unstubAllGlobals());

  const base = {
    targetPlayer: 'Mia',
    isPublic: true,
  };

  it('posts the system roll request card for a skill check without waiting for the roll', async () => {
    const result = await requestDsa5PlayerRoll({
      ...base,
      rollType: 'skill',
      rollTarget: 'climbing',
      rollModifier: '-2',
      flavor: 'wet rock',
    });

    expect(createRequest).toHaveBeenCalledWith({
      category: 'skill',
      name: 'Climbing',
      modifier: -2,
      messageMode: 'public',
      actors: [actor],
      label: 'Climbing (wet rock)',
    });
    expect(result.success).toBe(true);
    expect(result.message).toContain('Mia gets the roll dialog for Alrike');
    expect(hooks.size).toBe(0);
  });

  it('requests an attribute check by its localized name and whispers private requests', async () => {
    const result = await requestDsa5PlayerRoll({
      ...base,
      isPublic: false,
      rollType: 'ability',
      rollTarget: 'KK',
      rollModifier: '+1',
    });

    expect(createRequest).toHaveBeenCalledWith({
      category: 'attribute',
      name: 'Strength',
      modifier: 1,
      messageMode: 'gm',
      actors: [actor],
      whisper: ['user-p', 'user-gm'],
    });
    expect(result.success).toBe(true);
  });

  it('refuses D&D roll types with a pointer to the DSA5 parameters', async () => {
    const result = await requestDsa5PlayerRoll({ ...base, rollType: 'save', rollTarget: 'dex' });
    expect(result.success).toBe(false);
    expect(result.error).toContain('rollType "save" does not exist in DSA5');
    expect(result.error).toContain('"ability" for an attribute check');
    expect(createRequest).not.toHaveBeenCalled();
  });

  it('refuses dice in the modifier', async () => {
    const result = await requestDsa5PlayerRoll({
      ...base,
      rollType: 'skill',
      rollTarget: 'Climbing',
      rollModifier: '+1d4',
    });
    expect(result.success).toBe(false);
    expect(result.error).toContain('whole number');
  });

  it('reports an unknown skill', async () => {
    const result = await requestDsa5PlayerRoll({
      ...base,
      rollType: 'skill',
      rollTarget: 'Flying',
    });
    expect(result).toEqual({
      success: false,
      message: '',
      error: 'Skill "Flying" not found on Alrike. Skills: Climbing',
    });
  });
});
