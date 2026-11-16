/**
 * DSA5 condition handling: lookup, listing, planning a level change, and applying it
 * through the system's addCondition/removeCondition.
 *
 * The fake actor below mirrors DSA5 8.1's DSA5StatusEffects for the calls this module
 * makes: addCondition(id, value, absolute, auto) and removeCondition(id, value, auto,
 * absolute), with value = min(max, auto + manual) and the effect deleted once both
 * shares are 0.
 */

import { describe, expect, it, vi } from 'vitest';
import {
  describeDsa5Condition,
  describeDsa5Effect,
  findDsa5Condition,
  planDsa5Condition,
  setDsa5Condition,
  type Dsa5ConditionState,
} from './dsa5-conditions.js';

const translations: Record<string, string> = {
  'CONDITION.inpain': 'Schmerz',
  'CONDITIONDESCRIPTION.inpain': 'Wunden verursachen Schmerz.',
  'CONDITION.prone': 'Liegend',
  'CONDITIONDESCRIPTION.prone': 'Am Boden.',
  'CONDITION.feared': 'Furcht',
};
const localize = (key: string) => translations[key] ?? key;

const inpain = {
  id: 'inpain',
  name: 'CONDITION.inpain',
  img: 'icons/svg/blood.svg',
  description: 'CONDITIONDESCRIPTION.inpain',
  system: { condition: { value: 1, max: 4 } },
};
const prone = {
  id: 'prone',
  name: 'CONDITION.prone',
  img: 'icons/svg/falling.svg',
  description: 'CONDITIONDESCRIPTION.prone',
};
const feared = {
  id: 'feared',
  name: 'CONDITION.feared',
  img: 'f.svg',
  description: 'CONDITIONDESCRIPTION.feared',
  system: { condition: { value: 1, max: 4 } },
};
const statusEffects = [inpain, prone, feared];

interface FakeEffect {
  id: string;
  statuses: Set<string>;
  system: { condition: { value: number | null; max: number | null; auto: number; manual: number } };
}

function makeActor(initial: FakeEffect[] = []) {
  const effects: FakeEffect[] = [...initial];
  let nextId = 1;
  const find = (id: string) => effects.find(e => e.statuses.has(id));
  const definition = (id: string) => statusEffects.find(s => s.id === id) as any;
  const recalc = (e: FakeEffect) => {
    const c = e.system.condition;
    c.value = Math.min(c.max!, c.auto + c.manual);
  };

  const actor = {
    isToken: false,
    token: null as any,
    effects,
    addCondition: vi.fn(async (id: string, value = 1, absolute = false, auto = false) => {
      if (absolute && value < 1) return actor.removeCondition(id, value, auto, absolute);
      const existing = find(id);
      const max = definition(id).system?.condition?.max ?? null;
      if (existing && existing.system.condition.value == null) return existing;
      if (existing) {
        const c = existing.system.condition;
        if (auto) c.auto = Math.min(max, absolute ? value : c.auto + value);
        else c.manual = absolute ? value : c.manual + value;
        recalc(existing);
        return existing;
      }
      const effect: FakeEffect = {
        id: `e${nextId++}`,
        statuses: new Set([id]),
        system: { condition: { value: null, max, auto: 0, manual: 0 } },
      };
      if (max != null) {
        if (auto) effect.system.condition.auto = Math.min(max, value);
        else effect.system.condition.manual = Math.min(max, value);
        recalc(effect);
      }
      effects.push(effect);
      return [effect];
    }),
    removeCondition: vi.fn(async (id: string, value = 1, auto = true, absolute = false) => {
      const existing = find(id);
      if (!existing) return undefined;
      const c = existing.system.condition;
      if (c.value != null) {
        if (auto) c.auto = absolute ? value : Math.max(0, c.auto - value);
        else c.manual = absolute ? value : c.manual - value;
        if (!(c.auto < 1 && c.manual === 0)) {
          recalc(existing);
          return existing;
        }
      }
      effects.splice(effects.indexOf(existing), 1);
      return [existing.id];
    }),
  };
  return actor;
}

function leveledEffect(id: string, auto: number, manual: number, max = 4): FakeEffect {
  return {
    id: `pre-${id}`,
    statuses: new Set([id]),
    system: { condition: { value: Math.min(max, auto + manual), max, auto, manual } },
  };
}

describe('findDsa5Condition', () => {
  it('finds by id, by case-insensitive id, and by localized name', () => {
    expect(findDsa5Condition(statusEffects, 'inpain', localize)).toBe(inpain);
    expect(findDsa5Condition(statusEffects, 'InPain', localize)).toBe(inpain);
    expect(findDsa5Condition(statusEffects, 'schmerz', localize)).toBe(inpain);
    expect(findDsa5Condition(statusEffects, ' Liegend ', localize)).toBe(prone);
  });

  it('also accepts the raw i18n key and reports unknown names as missing', () => {
    expect(findDsa5Condition(statusEffects, 'CONDITION.feared', localize)).toBe(feared);
    expect(findDsa5Condition(statusEffects, 'nonsense', localize)).toBeUndefined();
    expect(findDsa5Condition(statusEffects, '  ', localize)).toBeUndefined();
  });
});

describe('describeDsa5Condition', () => {
  it('localizes name and description and reports the maximum level', () => {
    expect(describeDsa5Condition(inpain, localize)).toEqual({
      id: 'inpain',
      name: 'Schmerz',
      icon: 'icons/svg/blood.svg',
      description: 'Wunden verursachen Schmerz.',
      maxLevel: 4,
    });
  });

  it('leaves maxLevel out for conditions without levels', () => {
    expect(describeDsa5Condition(prone, localize)).not.toHaveProperty('maxLevel');
  });
});

describe('describeDsa5Effect', () => {
  it('adds statuses and the level of a leveled condition', () => {
    expect(describeDsa5Effect(leveledEffect('inpain', 2, 1))).toEqual({
      statuses: ['inpain'],
      level: 3,
      maxLevel: 4,
    });
  });

  it('adds only statuses for a non-leveled condition, and nothing for a plain effect', () => {
    expect(
      describeDsa5Effect({
        statuses: new Set(['prone']),
        system: { condition: { value: null, max: null } },
      })
    ).toEqual({ statuses: ['prone'] });
    expect(describeDsa5Effect({ statuses: new Set(), system: {} })).toEqual({});
  });
});

describe('planDsa5Condition', () => {
  const state = (overrides: Partial<Dsa5ConditionState> = {}): Dsa5ConditionState => ({
    name: 'Schmerz',
    exists: false,
    leveled: true,
    maxLevel: 4,
    autoLevel: 0,
    manualLevel: 0,
    ...overrides,
  });

  it('rejects requests that contradict themselves or say nothing', () => {
    expect(() => planDsa5Condition({}, state())).toThrow(/active or level/);
    expect(() => planDsa5Condition({ active: false, level: 2 }, state())).toThrow(/Conflicting/);
    expect(() => planDsa5Condition({ active: true, level: 0 }, state())).toThrow(/Conflicting/);
    expect(() => planDsa5Condition({ level: 1.5 }, state())).toThrow(/whole number/);
    expect(() => planDsa5Condition({ level: -1 }, state())).toThrow(/whole number/);
  });

  it('only adds level 1 for active: true and leaves an existing condition alone', () => {
    expect(planDsa5Condition({ active: true }, state())).toEqual({
      action: 'set',
      manual: 1,
      warnings: [],
    });
    expect(
      planDsa5Condition({ active: true }, state({ exists: true, manualLevel: 3 }))
    ).toMatchObject({ action: 'none' });
  });

  it('sets the manual share so that it adds up to the requested total', () => {
    expect(
      planDsa5Condition({ level: 3 }, state({ exists: true, autoLevel: 2, manualLevel: 0 }))
    ).toEqual({ action: 'set', manual: 1, warnings: [] });
  });

  it('caps the level at the maximum and says so', () => {
    const plan = planDsa5Condition({ level: 9 }, state());
    expect(plan).toMatchObject({ action: 'set', manual: 4 });
    expect(plan.warnings[0]).toMatch(/capped to 4/);
  });

  it('cannot go below the automatic levels and explains why', () => {
    const plan = planDsa5Condition(
      { level: 1 },
      state({ exists: true, autoLevel: 2, manualLevel: 1 })
    );
    expect(plan).toMatchObject({ action: 'set', manual: 0 });
    expect(plan.warnings[0]).toMatch(/2 level\(s\) applied automatically/);
  });

  it('removes a condition without automatic levels', () => {
    expect(planDsa5Condition({ level: 0 }, state({ exists: true, manualLevel: 2 }))).toEqual({
      action: 'remove',
      warnings: [],
    });
    expect(planDsa5Condition({ active: false }, state())).toMatchObject({ action: 'none' });
  });

  it('keeps automatic levels on removal, since the system would re-apply them at once', () => {
    const withManual = planDsa5Condition(
      { active: false },
      state({ exists: true, autoLevel: 2, manualLevel: 1 })
    );
    expect(withManual).toMatchObject({ action: 'set', manual: 0 });
    expect(withManual.warnings[0]).toMatch(/keeps 2 level\(s\)/);

    const autoOnly = planDsa5Condition(
      { level: 0 },
      state({ exists: true, autoLevel: 2, manualLevel: 0 })
    );
    expect(autoOnly).toMatchObject({ action: 'none' });
    expect(autoOnly.warnings).toHaveLength(1);
  });

  it('warns that a non-leveled condition ignores the level', () => {
    const plan = planDsa5Condition({ level: 3 }, state({ name: 'Liegend', leveled: false }));
    expect(plan).toMatchObject({ action: 'add' });
    expect(plan.warnings[0]).toMatch(/Liegend has no levels/);
  });
});

describe('setDsa5Condition', () => {
  it('adds a non-leveled condition once and removes it again', async () => {
    const actor = makeActor();

    const added = await setDsa5Condition(actor, prone, { active: true }, localize);
    expect(added).toMatchObject({ conditionId: 'prone', conditionName: 'Liegend', isActive: true });
    expect(added).not.toHaveProperty('level');
    expect(actor.addCondition).toHaveBeenCalledWith('prone', 1, false, false);

    await setDsa5Condition(actor, prone, { active: true }, localize);
    expect(actor.addCondition).toHaveBeenCalledTimes(1);

    const removed = await setDsa5Condition(actor, prone, { active: false }, localize);
    expect(removed.isActive).toBe(false);
    expect(actor.removeCondition).toHaveBeenCalledWith('prone');
    expect(actor.effects).toHaveLength(0);
  });

  it('sets, raises, lowers and removes a leveled condition', async () => {
    const actor = makeActor();

    expect(await setDsa5Condition(actor, feared, { level: 2 }, localize)).toMatchObject({
      conditionId: 'feared',
      conditionName: 'Furcht',
      isActive: true,
      level: 2,
      maxLevel: 4,
      autoLevel: 0,
      manualLevel: 2,
    });
    expect(actor.addCondition).toHaveBeenLastCalledWith('feared', 2, true, false);

    expect((await setDsa5Condition(actor, feared, { level: 4 }, localize)).level).toBe(4);

    const capped = await setDsa5Condition(actor, feared, { level: 7 }, localize);
    expect(capped.level).toBe(4);
    expect(capped.warnings?.[0]).toMatch(/capped/);

    expect((await setDsa5Condition(actor, feared, { level: 1 }, localize)).level).toBe(1);

    const removed = await setDsa5Condition(actor, feared, { level: 0 }, localize);
    expect(removed).toMatchObject({ isActive: false, level: 0, manualLevel: 0 });
    expect(actor.removeCondition).toHaveBeenLastCalledWith('feared', 0, false, true);
    expect(actor.effects).toHaveLength(0);
  });

  it('builds on automatic levels and keeps them on removal', async () => {
    const actor = makeActor([leveledEffect('inpain', 2, 0)]);

    const set = await setDsa5Condition(actor, inpain, { level: 3 }, localize);
    expect(set).toMatchObject({ level: 3, autoLevel: 2, manualLevel: 1 });
    expect(actor.addCondition).toHaveBeenLastCalledWith('inpain', 1, true, false);

    const removed = await setDsa5Condition(actor, inpain, { active: false }, localize);
    expect(removed).toMatchObject({ isActive: true, level: 2, autoLevel: 2, manualLevel: 0 });
    expect(removed.warnings?.[0]).toMatch(/keeps 2 level\(s\)/);
    expect(actor.removeCondition).toHaveBeenLastCalledWith('inpain', 0, false, true);
  });

  it('refuses an unlinked token that is not drawn, where DSA5 would silently do nothing', async () => {
    const actor = makeActor();
    actor.isToken = true;
    actor.token = { object: null };

    await expect(setDsa5Condition(actor, prone, { active: true }, localize)).rejects.toThrow(
      /viewed on the canvas/
    );
    expect(actor.addCondition).not.toHaveBeenCalled();
  });

  it('reports when the system did not apply the condition', async () => {
    const actor = makeActor();
    actor.addCondition.mockResolvedValueOnce(undefined);

    const result = await setDsa5Condition(actor, prone, { active: true }, localize);
    expect(result.isActive).toBe(false);
    expect(result.warnings?.[0]).toMatch(/did not apply Liegend/);
  });

  it('turns a refusal returned as text into an error', async () => {
    const actor = makeActor();
    actor.addCondition.mockResolvedValueOnce('You do not own this');

    await expect(setDsa5Condition(actor, prone, { active: true }, localize)).rejects.toThrow(
      'You do not own this'
    );
  });
});
