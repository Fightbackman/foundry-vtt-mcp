/**
 * DSA5 additions to manage-combat.
 *
 * The encounter itself runs through the core Combat API (see combat-manager.ts); DSA5's
 * Combat/Combatant subclasses hook into those same methods (round-state reset, minion
 * groups, burning/bleeding and regeneration at round start). This file only reads the
 * per-combatant data the DSA5 tracker shows a GM, and names the cases where the system
 * would open a dialog instead of acting.
 */

export interface Dsa5ConditionInfo {
  id: string;
  name: string;
  level: number | null;
}

export interface Dsa5CombatantExtras {
  lep: { value: number | null; max: number | null };
  conditions: Dsa5ConditionInfo[];
  otherEffects: string[];
  initiativeBase: number | null;
  initiativeDie: number | null;
  defenseCount: number;
  defensePenalty: {
    perDefenseParry: number | null;
    perDefenseDodge: number | null;
    nextParry: number | null;
    nextDodge: number | null;
  };
  actions: { perRound: number; used: number; freeActionUsed: boolean };
  waiting: boolean;
  roundInitiative: number | null;
}

export function isDsa5(): boolean {
  return (game.system as any)?.id === 'dsa5';
}

function num(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/**
 * Status conditions (with their DSA5 level, e.g. Schmerz II) and other temporary
 * effects on the combatant's actor. Effects marked as not applicable are left out,
 * as the tracker does.
 */
export function dsa5Conditions(actor: any): {
  conditions: Dsa5ConditionInfo[];
  otherEffects: string[];
} {
  const conditions: Dsa5ConditionInfo[] = [];
  const otherEffects: string[] = [];
  for (const effect of actor?.effects ?? []) {
    if (effect.disabled || effect.notApplicable) continue;
    const statuses = [...(effect.statuses ?? [])];
    if (statuses.length) {
      conditions.push({
        id: String(statuses[0]),
        name: effect.name,
        level: num(effect.system?.condition?.value),
      });
    } else if (effect.isTemporary) {
      otherEffects.push(effect.name);
    }
  }
  return { conditions, otherEffects };
}

/**
 * Penalty per earlier defense this round. The system computes it per weapon in the
 * defense dialog (RuleChaos.multipleDefenseValue: -3, or less with Meisterliche
 * (Ausweich-)Parade); a plain parry weapon and a dodge give the two usual values.
 * Scoped active-effect overrides applied inside the dialog are not included.
 */
function perDefensePenalty(actor: any, type: 'meleeweapon' | 'dodge'): number | null {
  const ruleChaos = (game as any).dsa5?.apps?.RuleChaos;
  if (!actor || typeof ruleChaos?.multipleDefenseValue !== 'function') return null;
  try {
    return num(ruleChaos.multipleDefenseValue(actor, { type, system: {} }));
  } catch {
    return null;
  }
}

export function dsa5CombatantExtras(combatant: any): Dsa5CombatantExtras {
  const actor = combatant.actor;
  const system = combatant.system ?? {};
  const wounds = actor?.system?.status?.wounds;
  const defenseCount = Number(system.defenseCount) || 0;
  const parry = perDefensePenalty(actor, 'meleeweapon');
  const dodge = perDefensePenalty(actor, 'dodge');
  const iniBase = num(actor?.system?.status?.initiative?.value);
  const baseRoll = num(combatant.getFlag?.('dsa5', 'baseRoll'));
  const roundInitiative = num(system.roundInitiative);
  const { conditions, otherEffects } = dsa5Conditions(actor);

  return {
    lep: { value: num(wounds?.value), max: num(wounds?.max) },
    conditions,
    otherEffects,
    initiativeBase: iniBase,
    // The system stores the die result as flags.dsa5.baseRoll once initiative is set.
    initiativeDie: combatant.initiative == null ? null : baseRoll,
    defenseCount,
    defensePenalty: {
      perDefenseParry: parry,
      perDefenseDodge: dodge,
      nextParry: parry == null ? null : defenseCount * parry,
      nextDodge: dodge == null ? null : defenseCount * dodge,
    },
    actions: {
      // Creatures carry their actions per round; heroes have one.
      perRound: Number(actor?.system?.actionCount?.value) || 1,
      used: Number(system.actionsUsed) || 0,
      freeActionUsed: !!system.freeActionUsed,
    },
    waiting: combatant.getFlag?.('dsa5', 'waitInit') != null,
    roundInitiative: roundInitiative != null && roundInitiative >= 0 ? roundInitiative : null,
  };
}

/**
 * DSA5 records the initiative die (flags.dsa5.baseRoll) from an updateCombatant hook,
 * but only while the flag is missing. A reroll or a value set by hand would keep the
 * old die, and Combatant#recalcInitiative (run when an INI modifier changes) would then
 * put the old initiative back. Dropping the flag first lets the system record the new one.
 */
export async function dsa5ForgetInitiativeDie(combatants: any[]): Promise<void> {
  for (const combatant of combatants) {
    if (combatant.getFlag?.('dsa5', 'baseRoll') != null) {
      await combatant.unsetFlag('dsa5', 'baseRoll');
    }
  }
}

/**
 * DSA5 deals burning/bleeding damage and regeneration at a round start only in the
 * active encounter (RepeatingEffectsHelper checks combat.active).
 */
export function dsa5AdvanceWarnings(combat: any, roundChanged: boolean): string[] {
  if (!roundChanged || combat.active) return [];
  return [
    'This encounter is not the active one, and DSA5 applies round-start effects (burning, ' +
      'bleeding, regeneration) only in the active encounter. Use action "activate" first ' +
      'if they should apply.',
  ];
}

/** Encounter-level DSA5 data: the tracker's combat mode (standard, brawling, chase, naval). */
export function dsa5CombatExtras(combat: any): Record<string, unknown> {
  return {
    combatMode: combat.system?.combatMode ?? 'standard',
    isBrawling: !!combat.system?.isBrawling,
    autoGroupMinions: !!combat.system?.autoGroupMinions,
  };
}

/**
 * Flat values compared before and after a turn change, so the report can say what the
 * system did at the round start (burning damage, defense counts and actions reset).
 */
export function dsa5Snapshot(combatant: any): Record<string, { label: string; value: unknown }> {
  const extras = dsa5CombatantExtras(combatant);
  return {
    lep: { label: 'LeP', value: extras.lep.value },
    defenseCount: { label: 'defenses this round', value: extras.defenseCount },
    actionsUsed: { label: 'actions used', value: extras.actions.used },
    freeActionUsed: { label: 'free action used', value: extras.actions.freeActionUsed },
  };
}

/**
 * Deleting a DSA5 encounter in brawling mode, or while Prügelpunkte are left on a
 * combatant, cancels the delete and opens a dialog asking how to settle them. Nobody
 * can answer that dialog through the bridge, so say so instead of leaving it open.
 */
export function dsa5EndBlocker(combat: any): string | null {
  if (combat.system?.isBrawling) {
    return (
      'This encounter is in brawling mode (Prügelei). Ending it asks in a Foundry dialog ' +
      'whether lost Prügelpunkte become LeP damage, so switch it back to standard combat in ' +
      'Foundry or end it from the combat tracker there.'
    );
  }
  const lingering = [...(combat.combatants ?? [])].some(
    (c: any) => Number(c.actor?.system?.status?.temporaryLeP?.max) > 0
  );
  if (lingering) {
    return (
      'Some combatants still have Prügelpunkte from a brawl. Ending the encounter asks in a ' +
      'Foundry dialog whether to turn them into LeP damage, so end it from the combat ' +
      'tracker in Foundry.'
    );
  }
  return null;
}
