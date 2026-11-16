/**
 * Condition handling for DSA5 (Das Schwarze Auge 5) worlds, used by toggle-token-condition,
 * get-available-conditions and the effects list of get-character.
 *
 * DSA5 conditions are ActiveEffects carrying their status id in `statuses`. Many of them
 * have levels: `system.condition` holds `{ value, max, auto, manual }`, where `auto` levels
 * are set by the system itself (pain from lost LeP, encumbrance from armour, stun from
 * brawling) and `manual` levels are what a GM applies; `value = min(max, auto + manual)`.
 * Non-leveled conditions keep `value` at null.
 *
 * Everything goes through the actor's own addCondition/removeCondition so the system's
 * level-dependent effects, immunities and hooks run. Actor#toggleStatusEffect is not used
 * because DSA5 overrides it to add one level per call, which is the token HUD's click
 * behaviour, not what an API caller asking for "active" or "level N" means.
 */

export type Localize = (key: string) => string;

export interface Dsa5ConditionRequest {
  active?: boolean | undefined;
  level?: number | undefined;
}

export interface Dsa5ConditionResult {
  conditionId: string;
  conditionName: string;
  isActive: boolean;
  level?: number;
  maxLevel?: number;
  autoLevel?: number;
  manualLevel?: number;
  warnings?: string[];
  message: string;
}

/** State of one condition on an actor, as far as planning a change needs it. */
export interface Dsa5ConditionState {
  name: string;
  exists: boolean;
  leveled: boolean;
  maxLevel: number;
  autoLevel: number;
  manualLevel: number;
}

export type Dsa5ConditionPlan =
  | { action: 'none'; warnings: string[] }
  | { action: 'add'; warnings: string[] }
  | { action: 'remove'; warnings: string[] }
  | { action: 'set'; manual: number; warnings: string[] };

/** Leveled conditions are the ones whose definition carries a maximum level. */
export function isLeveledCondition(condition: any): boolean {
  return condition?.system?.condition?.max != null;
}

/**
 * Find a condition by id, case-insensitive id, or localized name. DSA5 names are i18n keys
 * (`CONDITION.inpain`), so the name a user sees ("Schmerz", "Pain") only matches once it
 * has been localized.
 */
export function findDsa5Condition(conditions: any[], query: string, localize: Localize): any {
  const exact = conditions.find(c => c?.id === query);
  if (exact) return exact;

  const needle = query.trim().toLowerCase();
  if (!needle) return undefined;
  return (
    conditions.find(c => typeof c?.id === 'string' && c.id.toLowerCase() === needle) ??
    conditions.find(
      c => typeof c?.name === 'string' && localize(c.name).toLowerCase() === needle
    ) ??
    conditions.find(c => typeof c?.name === 'string' && c.name.toLowerCase() === needle)
  );
}

/** One entry of get-available-conditions, with names and descriptions localized. */
export function describeDsa5Condition(condition: any, localize: Localize): Record<string, any> {
  const max = condition?.system?.condition?.max;
  return {
    id: condition.id,
    name: condition.name ? localize(condition.name) : condition.id,
    icon: condition.icon || condition.img,
    description: condition.description ? localize(condition.description) : '',
    ...(max != null ? { maxLevel: Number(max) } : {}),
  };
}

/** Extra fields for an effect in get-character: its statuses and, if leveled, its level. */
export function describeDsa5Effect(effect: any): Record<string, any> {
  const statuses = effect?.statuses ? [...effect.statuses] : [];
  const condition = effect?.system?.condition;
  return {
    ...(statuses.length > 0 ? { statuses } : {}),
    ...(condition?.value != null
      ? {
          level: Number(condition.value),
          ...(condition.max != null ? { maxLevel: Number(condition.max) } : {}),
        }
      : {}),
  };
}

/**
 * Validate a request. `level: 0` and `active: false` both remove; anything that asks for
 * the opposite at the same time is rejected rather than guessed at.
 */
export function validateDsa5ConditionRequest(request: Dsa5ConditionRequest): void {
  const { active, level } = request;
  if (level !== undefined && (!Number.isInteger(level) || level < 0)) {
    throw new Error(`level must be a whole number of 0 or more, got ${String(level)}`);
  }
  if (active === undefined && level === undefined) {
    throw new Error('Either active or level is required');
  }
  if (active === false && level !== undefined && level > 0) {
    throw new Error('Conflicting request: active is false but level is above 0');
  }
  if (active === true && level === 0) {
    throw new Error('Conflicting request: active is true but level is 0 (which removes it)');
  }
}

/** Decide what to do, without touching the actor. */
export function planDsa5Condition(
  request: Dsa5ConditionRequest,
  state: Dsa5ConditionState
): Dsa5ConditionPlan {
  validateDsa5ConditionRequest(request);
  const { level } = request;
  const warnings: string[] = [];

  if (level !== undefined && !state.leveled) {
    warnings.push(`${state.name} has no levels, so the level was ignored.`);
  }

  const removing = level === 0 || (level === undefined && request.active === false);
  if (removing) {
    if (!state.exists) return { action: 'none', warnings };
    // Automatic levels are recalculated by the system after every effect change, so
    // deleting them only makes it re-create the effect at once (in DSA5 8.1 sometimes
    // twice). Only the manual share is removed.
    if (state.leveled && state.autoLevel > 0) {
      warnings.push(
        `${state.name} keeps ${state.autoLevel} level(s) that the system applies automatically ` +
          '(e.g. pain from wounds or encumbrance from armour); only its manual levels were ' +
          'removed. The system recalculates the automatic levels itself.'
      );
      return state.manualLevel > 0
        ? { action: 'set', manual: 0, warnings }
        : { action: 'none', warnings };
    }
    return { action: 'remove', warnings };
  }

  if (!state.leveled) {
    return { action: state.exists ? 'none' : 'add', warnings };
  }

  // active: true without a level only makes sure the condition is there.
  if (level === undefined) {
    return state.exists ? { action: 'none', warnings } : { action: 'set', manual: 1, warnings };
  }

  let target = level;
  if (target > state.maxLevel) {
    warnings.push(
      `${state.name} goes up to level ${state.maxLevel}; level ${level} was capped to ${state.maxLevel}.`
    );
    target = state.maxLevel;
  }

  // Auto levels belong to the system, which recalculates them on its own, so only the
  // manual share is set.
  if (target < state.autoLevel) {
    warnings.push(
      `${state.name} has ${state.autoLevel} level(s) applied automatically by the system ` +
        '(e.g. pain from wounds or encumbrance from armour), so it cannot go below that; ' +
        'its manual levels were cleared instead.'
    );
  }
  const manual = Math.max(0, target - state.autoLevel);

  if (state.exists && manual === state.manualLevel) return { action: 'none', warnings };
  return { action: 'set', manual, warnings };
}

function findEffect(actor: any, conditionId: string): any {
  const effects = actor?.effects;
  if (!effects) return undefined;
  const list = Array.isArray(effects) ? effects : (effects.contents ?? [...effects]);
  return list.find((effect: any) => effect?.statuses?.has?.(conditionId));
}

function readState(actor: any, condition: any, name: string): Dsa5ConditionState {
  const effect = findEffect(actor, condition.id);
  const data = effect?.system?.condition;
  const leveled = effect ? data?.value != null : isLeveledCondition(condition);
  return {
    name,
    exists: !!effect,
    leveled,
    maxLevel: Number(data?.max ?? condition?.system?.condition?.max ?? 0),
    autoLevel: Number(data?.auto || 0),
    manualLevel: Number(data?.manual || 0),
  };
}

/** The system reports refusals (not owner, in compendium, unknown effect) as strings. */
function throwOnRefusal(result: unknown): void {
  if (typeof result === 'string') throw new Error(result);
}

/**
 * Apply a request to an actor through DSA5's own API and report the resulting state.
 */
export async function setDsa5Condition(
  actor: any,
  condition: any,
  request: Dsa5ConditionRequest,
  localize: Localize
): Promise<Dsa5ConditionResult> {
  const id: string = condition.id;
  const name = condition.name ? localize(condition.name) : id;
  const plan = planDsa5Condition(request, readState(actor, condition, name));
  const warnings = [...plan.warnings];

  if (plan.action === 'remove' || (plan.action === 'set' && plan.manual === 0)) {
    // Non-leveled conditions are deleted outright. For leveled ones this sets the manual
    // share to 0 (absolute, not auto); the system deletes the effect once no automatic
    // levels are left either.
    throwOnRefusal(
      readState(actor, condition, name).leveled
        ? await actor.removeCondition(id, 0, false, true)
        : await actor.removeCondition(id)
    );
  } else if (plan.action === 'add' || plan.action === 'set') {
    // DSA5's addCondition silently does nothing for an unlinked token whose token is not
    // drawn on the canvas, so say why instead of reporting a no-op.
    if (actor.isToken && !actor.token?.object) {
      throw new Error(
        'DSA5 can only add conditions to an unlinked token while its scene is viewed on ' +
          'the canvas; view the scene in Foundry and try again'
      );
    }
    // absolute = true sets the manual level outright; auto = false leaves the system's own
    // automatic levels alone.
    throwOnRefusal(
      plan.action === 'set'
        ? await actor.addCondition(id, plan.manual, true, false)
        : await actor.addCondition(id, 1, false, false)
    );
  }

  const after = readState(actor, condition, name);
  const wantedActive = plan.action === 'add' || plan.action === 'set';
  if (wantedActive && !after.exists) {
    warnings.push(
      `The DSA5 system did not apply ${name}; it handles this condition differently ` +
        '(bleeding, for example, only posts a chat message).'
    );
  }

  const effect = findEffect(actor, id);
  const level = effect?.system?.condition?.value;
  const leveledResult = after.exists ? after.leveled : isLeveledCondition(condition);

  let message: string;
  if (!after.exists) message = `${name} is not active`;
  else if (leveledResult) message = `${name} is at level ${Number(level ?? 0)}`;
  else message = `${name} is active`;

  return {
    conditionId: id,
    conditionName: name,
    isActive: after.exists,
    ...(leveledResult
      ? {
          level: after.exists ? Number(level ?? 0) : 0,
          maxLevel: after.maxLevel,
          autoLevel: after.autoLevel,
          manualLevel: after.manualLevel,
        }
      : {}),
    ...(warnings.length > 0 ? { warnings } : {}),
    message,
  };
}
