/**
 * DSA5 opposed tests as seen from the chat log.
 *
 * DSA5 links an attack and its defense only through chat message flags: the attack card
 * lists one "start" message per targeted token (flags.data.startMessagesList), the target
 * actor carries a pending-oppose flag until it defends, and once the defense is rolled the
 * system posts an opposed result card (flags.opposeData) and stores its id on the defense
 * card or, for undefended attacks, on the start message (flags.dsa5.opposedResultMessageId).
 * The helpers below follow those links so a caller learns whether a test is still pending,
 * who won, the damage the system computed and which card to apply it from.
 */

type AnyRecord = Record<string, any>;

export interface Dsa5OpposedDamage {
  /** Damage rolled by the attacker (TP), before armor. */
  rolled?: number;
  /** Armor (RS) the system subtracted, including its own armor modifiers. */
  armor?: number;
  /** What the defender loses when the damage is applied with armor (TP - RS). */
  afterArmor: number;
}

export interface Dsa5OpposedEntry {
  role: 'attacker' | 'defender';
  status: 'pending' | 'resolved';
  attacker?: string;
  defender?: string;
  defenderTokenId?: string;
  startMessageId?: string;
  resultMessageId?: string;
  winner?: 'attacker' | 'defender';
  winnerName?: string;
  result?: string;
  damage?: Dsa5OpposedDamage;
  damageApplied?: boolean;
  next?: string;
}

function stripHtml(text: unknown): string {
  return String(text ?? '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function getMessage(id: unknown): any {
  return id ? (game as any).messages?.get?.(String(id)) : undefined;
}

/** Damage block of an opposed result card, in caller terms. */
export function opposedDamage(opposeData: AnyRecord | undefined): Dsa5OpposedDamage | undefined {
  const damage = opposeData?.damage;
  if (!damage || !Number.isFinite(Number(damage.value))) return undefined;
  // The card shows TP - RS even when negative; nothing gets through then.
  const afterArmor = Math.max(0, Number(damage.value));
  const out: Dsa5OpposedDamage = { afterArmor };
  // `sp` is the raw roll ("apply as SP" ignores armor); a brawling counter-hit has none.
  if (Number.isFinite(Number(damage.sp))) {
    out.rolled = Number(damage.sp);
    out.armor = out.rolled - Number(damage.value);
  }
  return out;
}

/** Describe an opposed result card (flags.opposeData). */
export function describeOpposedResult(
  resultMessage: any,
  role: Dsa5OpposedEntry['role']
): Dsa5OpposedEntry {
  const data: AnyRecord = resultMessage?.flags?.opposeData ?? {};
  const entry: Dsa5OpposedEntry = { role, status: 'resolved', resultMessageId: resultMessage.id };
  if (data.speakerAttack?.alias) entry.attacker = String(data.speakerAttack.alias);
  if (data.speakerDefend?.alias) entry.defender = String(data.speakerDefend.alias);
  if (data.speakerDefend?.token) entry.defenderTokenId = String(data.speakerDefend.token);
  if (data.winner === 'attacker' || data.winner === 'defender') {
    entry.winner = data.winner;
    const winnerName = data.winner === 'attacker' ? entry.attacker : entry.defender;
    if (winnerName) entry.winnerName = winnerName;
  }
  if (data.result) entry.result = stripHtml(data.result);
  const damage = data.winner === 'attacker' ? opposedDamage(data) : undefined;
  if (damage) {
    entry.damage = damage;
    entry.damageApplied = Boolean(resultMessage?.flags?.data?.damageApplied);
    if (!entry.damageApplied && damage.afterArmor > 0) {
      entry.next = `Apply the damage with dsa5-apply-damage (action "damage", messageId "${resultMessage.id}").`;
    } else if (!entry.damageApplied && (damage.rolled ?? 0) > 0) {
      entry.next = `Armor absorbs the hit. To apply the ${damage.rolled} TP as SP anyway: dsa5-apply-damage (action "damage", messageId "${resultMessage.id}", armor false).`;
    }
  }
  return entry;
}

/**
 * Opposed-test state of a freshly rolled attack, parry or dodge card. Returns undefined
 * when the roll is not part of an opposed test (no target, missed attack, plain check).
 */
export function summarizeDsa5Opposed(
  messageId: string | undefined
): Dsa5OpposedEntry[] | undefined {
  const message = getMessage(messageId);
  const data: AnyRecord | undefined = message?.flags?.data;
  if (!data) return undefined;

  // Defense answering a pending attack: DSA5 links it to the attack and the result card.
  if (data.attackerMessage) {
    const result = getMessage(message.flags?.dsa5?.opposedResultMessageId);
    if (result?.flags?.opposeData) return [describeOpposedResult(result, 'defender')];
    return [{ role: 'defender', status: 'pending' }];
  }

  // Attack against targets: one start message per target that may now defend.
  const startIds: string[] = Array.isArray(data.startMessagesList) ? data.startMessagesList : [];
  if (startIds.length === 0) return undefined;
  return startIds.map(startId => {
    const start = getMessage(startId);
    const target: AnyRecord = start?.flags?.unopposeData?.targetSpeaker ?? {};
    // Undefended results (attack of opportunity, vehicles, damage-only rolls) exist already.
    const result = getMessage(start?.flags?.dsa5?.opposedResultMessageId);
    if (result?.flags?.opposeData) {
      return { ...describeOpposedResult(result, 'attacker'), startMessageId: startId };
    }
    const entry: Dsa5OpposedEntry = {
      role: 'attacker',
      status: 'pending',
      startMessageId: startId,
    };
    if (target.alias) entry.defender = String(target.alias);
    if (target.token) {
      entry.defenderTokenId = String(target.token);
      entry.next = `The target may defend: dsa5-roll-check with actor "${target.token}" and check "parry" or "dodge". The opposed result card then carries the damage.`;
    }
    return entry;
  });
}

/**
 * Find the opposed result card behind a message id: the result card itself, a defense card
 * or start message linked to one, or an attack card whose defenses produced exactly one.
 */
export function findOpposedResultMessage(message: any): {
  message?: any;
  pending?: boolean;
  candidates?: string[];
} {
  if (message?.flags?.opposeData) return { message };

  const linked = getMessage(message?.flags?.dsa5?.opposedResultMessageId);
  if (linked?.flags?.opposeData) return { message: linked };

  const data: AnyRecord = message?.flags?.data ?? {};
  const ids = new Set<string>();
  for (const defenderId of Array.isArray(data.defenderMessage) ? data.defenderMessage : []) {
    const id = getMessage(defenderId)?.flags?.dsa5?.opposedResultMessageId;
    if (getMessage(id)?.flags?.opposeData) ids.add(id);
  }
  const startIds: string[] = Array.isArray(data.startMessagesList) ? data.startMessagesList : [];
  for (const startId of startIds) {
    const id = getMessage(startId)?.flags?.dsa5?.opposedResultMessageId;
    if (getMessage(id)?.flags?.opposeData) ids.add(id);
  }
  if (ids.size === 1) return { message: getMessage([...ids][0]) };
  if (ids.size > 1) return { candidates: [...ids] };
  if (startIds.length > 0 || data.attackerMessage || message?.flags?.unopposeData) {
    return { pending: true };
  }
  return {};
}
