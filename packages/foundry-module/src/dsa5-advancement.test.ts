import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  dsa5Advance,
  dsa5AwardAP,
  dsa5PartyActors,
  resolveAdvanceTarget,
} from './dsa5-advancement.js';

// The system's cost table (config-dsa5.js DSA5.advancementCosts), trimmed to what the tests use.
const COSTS: Record<string, number[]> = {
  B: [2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 4, 6, 8],
  D: [4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 8, 12, 16],
  E: [15, 15, 15, 15, 15, 15, 15, 15, 15, 15, 15, 15, 15, 15, 15, 30, 45],
};
const calc = (value: number, type: string, modifier = 1) => COSTS[type]?.[value + modifier];

const LABELS: Record<string, string> = {
  'CHAR.MU': 'Mut',
  'CHARAbbrev.MU': 'MU',
  'CHAR.KK': 'Körperkraft',
  'CHARAbbrev.KK': 'KK',
  wounds: 'Lebenskraft',
};

const track = vi.fn();
const chatCreate = vi.fn(async () => ({ id: 'chat-1' }));

function makeSkill(actor: any, name: string, value: number, max = 11) {
  const item: any = {
    id: `id-${name}`,
    name,
    type: 'skill',
    system: {
      talentValue: { value },
      StF: { value: 'B' },
      advanceCategory: 'B',
      characteristic1: { value: 'mu' },
      characteristic2: { value: 'mu' },
      characteristic3: { value: 'kk' },
    },
    update: vi.fn(async (data: any) => {
      item.system.talentValue.value = data['system.talentValue.value'];
    }),
  };
  // Stand-ins for the system's SkillSheet methods: same cost, AP and max behaviour.
  item.sheet = {
    _checkMaximumItemAdvancement: vi.fn((v: number) => ({ result: v <= max, max, maxBonus: 0 })),
    _advanceStep: vi.fn(async () => {
      const v = item.system.talentValue.value;
      const cost = calc(v, 'B');
      const exp = actor.system.details.experience;
      if (exp.total - exp.spent < cost || v + 1 > max) return undefined;
      item.system.talentValue.value = v + 1;
      exp.spent += cost;
      return true;
    }),
    _refundStep: vi.fn(async () => {
      const v = item.system.talentValue.value;
      if (v <= 0) return undefined;
      item.system.talentValue.value = v - 1;
      actor.system.details.experience.spent -= calc(v, 'B', 0);
      return true;
    }),
  };
  return item;
}

function makeActor(
  options: { type?: string; canAdvance?: boolean; total?: number; spent?: number } = {}
) {
  const actor: any = {
    id: 'actor-1',
    name: 'Alrike',
    type: options.type ?? 'character',
    canAdvance: options.canAdvance ?? true,
    hasPlayerOwner: true,
    system: {
      details: { experience: { total: options.total ?? 1000, spent: options.spent ?? 0 } },
      characteristics: {
        mu: { initial: 8, advances: 4, value: 12 },
        kk: { initial: 8, advances: 0, value: 8 },
      },
      status: { wounds: { advances: 0 } },
      pointAdvancementLimit: () => 8,
    },
    update: vi.fn(),
  };
  actor.sheet = {
    _advanceAttribute: vi.fn(async (key: string) => {
      const c = actor.system.characteristics[key];
      actor.system.details.experience.spent += calc(c.initial + c.advances, 'E');
      c.advances += 1;
      return true;
    }),
    _refundAttributeAdvance: vi.fn(),
    _advancePoints: vi.fn(),
    _refundPointsAdvance: vi.fn(),
  };
  const climbing = makeSkill(actor, 'Klettern', 10);
  actor.items = [climbing, { id: 'vant-1', name: 'Begabung', type: 'advantage' }];
  return { actor, climbing };
}

beforeEach(() => {
  track.mockReset();
  chatCreate.mockClear();
  vi.stubGlobal('ChatMessage', { create: chatCreate });
  vi.stubGlobal('game', {
    i18n: {
      localize: (key: string) => LABELS[key] ?? key,
      format: (_key: string, data: any) => `${data.heros} +${data.number}`,
    },
    settings: {
      get: (_scope: string, key: string) =>
        ({ enableAPTracking: true, primaryParty: '', trackedActors: { actors: [] } })[key],
    },
    journal: [],
    actors: [],
    dsa5: {
      apps: {
        DSA5_Utility: {
          _calculateAdvCost: calc,
          chatDataSetup: (content: string) => ({ content }),
        },
        APTracker: { track },
      },
    },
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('resolveAdvanceTarget', () => {
  it('finds attributes by key, localized name or abbreviation', () => {
    const { actor } = makeActor();
    for (const name of ['mu', 'Mut', 'MU']) {
      const r = resolveAdvanceTarget(actor, name) as any;
      expect(r.track.kind).toBe('attribute');
      expect(r.track.details.key).toBe('mu');
    }
  });

  it('finds bought life points by alias and localized name', () => {
    const { actor } = makeActor();
    expect((resolveAdvanceTarget(actor, 'LeP') as any).track.details.key).toBe('wounds');
    expect((resolveAdvanceTarget(actor, 'Lebenskraft') as any).track.details.key).toBe('wounds');
  });

  it('finds an item by exact name or id, ignoring case', () => {
    const { actor } = makeActor();
    expect((resolveAdvanceTarget(actor, 'klettern') as any).track.name).toBe('Klettern');
    expect((resolveAdvanceTarget(actor, 'id-Klettern') as any).track.name).toBe('Klettern');
  });

  it('refuses item types the tool does not advance', () => {
    const { actor } = makeActor();
    expect((resolveAdvanceTarget(actor, 'Begabung') as any).error).toMatch(/advantage/);
  });

  it('suggests similar names when nothing matches', () => {
    const { actor } = makeActor();
    expect((resolveAdvanceTarget(actor, 'Klet') as any).error).toMatch(/Similar items: Klettern/);
  });
});

describe('dsa5Advance', () => {
  it('previews the cost from the system table without writing', async () => {
    const { actor, climbing } = makeActor();
    const r = await dsa5Advance(actor, { action: 'preview', target: 'Klettern', toValue: 11 });
    expect(r.steps).toEqual([{ from: 10, to: 11, cost: 2 }]);
    expect(r.canAfford).toBe(true);
    expect(climbing.sheet._advanceStep).not.toHaveBeenCalled();
  });

  it('raises step by step through the sheet method and reports AP', async () => {
    const { actor, climbing } = makeActor();
    const r = await dsa5Advance(actor, { action: 'raise', target: 'Klettern' });
    expect(r.success).toBe(true);
    expect(climbing.sheet._advanceStep).toHaveBeenCalledTimes(1);
    expect(r.newValue).toBe(11);
    expect(r.totalCost).toBe(2);
    expect(r.ap.after.free).toBe(998);
  });

  it('refuses a raise past the maximum without touching the value', async () => {
    const { actor, climbing } = makeActor();
    climbing.system.talentValue.value = 11;
    const r = await dsa5Advance(actor, { action: 'raise', target: 'Klettern' });
    expect(r.success).toBe(false);
    expect(r.blockedReason).toBe('maximum');
    expect(r.maximum).toBe(11);
    expect(climbing.sheet._advanceStep).not.toHaveBeenCalled();
  });

  it('stops a multi-step raise when AP run out and reports how far it got', async () => {
    const { actor } = makeActor({ total: 40, spent: 0 });
    const r = await dsa5Advance(actor, { action: 'raise', target: 'mu', steps: 4 });
    // MU 12 -> 13 -> 14 cost 15 each; 14 -> 15 costs 15 but only 10 AP remain.
    expect(r.success).toBe(true);
    expect(r.newValue).toBe(14);
    expect(r.completed).toBe(false);
    expect(r.stoppedReason).toBe('insufficientAP');
    expect(actor.sheet._advanceAttribute).toHaveBeenCalledTimes(2);
  });

  it('never calls the system when the first step is unaffordable (avoids its 0-AP dialog)', async () => {
    const { actor, climbing } = makeActor({ total: 0 });
    const r = await dsa5Advance(actor, { action: 'raise', target: 'Klettern' });
    expect(r.success).toBe(false);
    expect(r.blockedReason).toBe('insufficientAP');
    expect(climbing.sheet._advanceStep).not.toHaveBeenCalled();
  });

  it('lowers through the refund method', async () => {
    const { actor, climbing } = makeActor({ spent: 100 });
    const r = await dsa5Advance(actor, { action: 'lower', target: 'Klettern', steps: 2 });
    expect(climbing.sheet._refundStep).toHaveBeenCalledTimes(2);
    expect(r.totalCost).toBe(-4);
    expect(r.newValue).toBe(8);
  });

  it('free raise writes the value, logs cost 0 and keeps AP', async () => {
    const { actor, climbing } = makeActor();
    const r = await dsa5Advance(actor, { action: 'raise', target: 'Klettern', free: true });
    expect(climbing.update).toHaveBeenCalledWith({ 'system.talentValue.value': 11 });
    expect(climbing.sheet._advanceStep).not.toHaveBeenCalled();
    expect(track).toHaveBeenCalledWith(
      actor,
      expect.objectContaining({ previous: 10, next: 11 }),
      0
    );
    expect(r.totalCost).toBe(0);
  });

  it('free raise respects the maximum unless ignoreMaximum is set', async () => {
    const { actor, climbing } = makeActor();
    climbing.system.talentValue.value = 11;
    const blocked = await dsa5Advance(actor, { action: 'raise', target: 'Klettern', free: true });
    expect(blocked.success).toBe(false);
    const allowed = await dsa5Advance(actor, {
      action: 'raise',
      target: 'Klettern',
      free: true,
      ignoreMaximum: true,
    });
    expect(allowed.newValue).toBe(12);
  });

  it('rejects ignoreMaximum on a paid raise', async () => {
    const { actor } = makeActor();
    const r = await dsa5Advance(actor, {
      action: 'raise',
      target: 'Klettern',
      ignoreMaximum: true,
    });
    expect(r.error).toMatch(/requires free/);
  });

  it('refuses actors without an AP economy, like the system', async () => {
    const { actor } = makeActor({ type: 'npc', canAdvance: false });
    const r = await dsa5Advance(actor, { action: 'raise', target: 'mu' });
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/no Abenteuerpunkte economy/);
  });
});

describe('dsa5AwardAP', () => {
  function simple(id: string, system: Record<string, unknown> = {}, canAdvance = true) {
    const actor: any = {
      id,
      name: id,
      type: 'character',
      canAdvance,
      hasPlayerOwner: true,
      system: { details: { experience: { total: 100, spent: 0 } }, ...system },
    };
    actor.update = vi.fn(async (data: any) => {
      actor.system.details.experience.total = data['system.details.experience.total'];
    });
    return actor;
  }

  it('gives familiars 25 % and pets 10 % like the GM menu, skipping npcs', async () => {
    const hero = simple('hero');
    const familiar = simple('familiar', { isFamiliar: true });
    const pet = simple('pet', { isPet: true });
    const npc = simple('npc', {}, false);
    const r = await dsa5AwardAP([hero, familiar, pet, npc], { amount: 30, reason: 'Ende' });
    expect(r.awarded.map((a: any) => a.received)).toEqual([30, 8, 3]);
    expect(hero.system.details.experience.total).toBe(130);
    expect(r.skipped[0].name).toBe('npc');
    expect(npc.update).not.toHaveBeenCalled();
    expect(chatCreate).toHaveBeenCalledTimes(1);
    expect((chatCreate.mock.calls[0] as any)[0].content).toContain('Ende');
  });

  it('gives at least 1 AP to companions and can skip the chat message', async () => {
    const pet = simple('pet', { isPet: true });
    const r = await dsa5AwardAP([pet], { amount: 2, postToChat: false });
    expect(r.awarded[0].received).toBe(1);
    expect(chatCreate).not.toHaveBeenCalled();
  });

  it('uses player-owned actors as the party when no party is configured', () => {
    const owned = { id: 'a', hasPlayerOwner: true };
    const other = { id: 'b', hasPlayerOwner: false };
    (globalThis as any).game.actors = [owned, other];
    expect(dsa5PartyActors()).toEqual([owned]);
  });
});
