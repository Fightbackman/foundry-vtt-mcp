/**
 * DSA5: add items to an actor (and remove them again) the way the character sheet does.
 *
 * Dropping an item on a DSA5 sheet is not a plain `createEmbeddedDocuments`: advantages,
 * disadvantages and special abilities go through the system's rule classes (AP cost per
 * step, adoption such as "Begabung (Klettern)", step increase when the actor already has
 * it), spells and liturgies cost AP from the Steigerungsfaktor, equipment stacks onto an
 * equal item, money is added to the existing coins, item packages are resolved, and the
 * AP tracker journal gets an entry. This file calls exactly those system functions:
 * `AdvantageRulesDSA5._vantageReturnFunction`, `SpecialabilityRulesDSA5.
 * _specialabilityReturnFunction` (the dialog-free halves behind the adoption dialogs) and
 * the sheet's own `_addSpellOrLiturgy`, `_addLoot`, `_addMoney`, `_addDisease`, ... on the
 * unrendered `actor.sheet` (the system itself calls `actor.sheet._manageDragItems`
 * headless in its trade code). The full item document is copied, so effects and flags
 * survive.
 *
 * What a headless caller needs on top: the adoption (normally picked in a dialog) is a
 * parameter, `checkEnoughXP` must never open its "choose starting AP" dialog (it does when a
 * hero has 0 AP total and would block the GM client), and the result is reported by
 * comparing the actor before and after instead of relying on return values (the sheet
 * methods mostly return nothing).
 */

/** Types the sheet adds through `_addSpellOrLiturgy` (AP cost + tracker entry). */
const SPELL_LIKE_TYPES = new Set([
  'spell',
  'liturgy',
  'ritual',
  'ceremony',
  'blessing',
  'magictrick',
  'magicalsign',
]);

/** Types the sheet adds only once (`_addUniqueItem`). */
const UNIQUE_TYPES = new Set(['skill', 'imprint', 'essence', 'information', 'patron', 'demonmark']);

/** Types that are added through a wizard with dialogs on the character sheet. */
const WIZARD_TYPES = new Set(['species', 'culture', 'career']);

/** Fallback for game.dsa5.config.equipmentCategories (the sheet's `_addLoot` types). */
const LOOT_TYPES_FALLBACK = [
  'meleeweapon',
  'rangeweapon',
  'equipment',
  'ammunition',
  'armor',
  'poison',
  'consumable',
  'plant',
  'book',
];

export interface Dsa5AddItemEntry {
  /** Item UUID (world item, compendium entry or another actor's item). */
  uuid?: string;
  /** Item name to look up (case-insensitive exact match) in world items and compendiums. */
  name?: string;
  type?: string;
  /** Compendium id or label fragment, or "world" for world items only. */
  pack?: string;
  quantity?: number;
  /** Advantages, disadvantages, special abilities: the step (level) to end up with. */
  step?: number;
  /** The choice the adoption dialog asks for (a Talent, spell, or free text). */
  adoption?: string;
  /** Special abilities only: the free-text field of the adoption dialog. */
  adoptionDetail?: string;
  free?: boolean;
}

export interface Dsa5AddItemsRequest {
  action?: 'add' | 'remove';
  items: Dsa5AddItemEntry[];
  free?: boolean;
}

interface ItemState {
  name: string;
  type: string;
  quantity: number | undefined;
  step: number | undefined;
}

function dsa5(): any {
  return (game as any).dsa5;
}

function norm(text: unknown): string {
  return String(text ?? '')
    .trim()
    .toLowerCase();
}

function experience(actor: any): { total: number; spent: number; free: number } {
  const exp = actor.system?.details?.experience ?? {};
  const total = Number(exp.total) || 0;
  const spent = Number(exp.spent) || 0;
  return { total, spent, free: total - spent };
}

function lootTypes(): Set<string> {
  const configured = dsa5()?.config?.equipmentCategories;
  return new Set(configured ? [...configured] : LOOT_TYPES_FALLBACK);
}

function snapshot(actor: any): Map<string, ItemState> {
  const state = new Map<string, ItemState>();
  for (const item of actor.items) {
    const quantity = item.system?.quantity?.value;
    const step = item.system?.step?.value;
    state.set(item.id, {
      name: item.name,
      type: item.type,
      quantity: typeof quantity === 'number' ? quantity : undefined,
      step: typeof step === 'number' ? step : undefined,
    });
  }
  return state;
}

function trackerJournal(actor: any): any {
  return (game as any).journal?.find((j: any) => j.flags?.dsa5?.apTrackerId === actor.id);
}

function trackerEntryCount(actor: any): number {
  const journal = trackerJournal(actor);
  if (!journal) return 0;
  let count = 0;
  for (const page of journal.pages ?? []) {
    if (page.type === 'dsaaptracker') count += Object.keys(page.system?.entries ?? {}).length;
  }
  return count;
}

function trackingEnabled(): boolean {
  try {
    return Boolean((game as any).settings.get('dsa5', 'enableAPTracking'));
  } catch {
    return false;
  }
}

/**
 * Wraps the AP functions of this one actor instance for the duration of a single add.
 *
 * - `checkEnoughXP` is answered without the system's dialog: with enough free AP the
 *   system's own check runs; otherwise the add is refused (the system refuses too, except at
 *   0 AP total, where it asks for starting AP in a dialog no headless caller can answer).
 *   The requested cost is recorded so the refusal can be reported.
 * - With `free`, AP are neither checked nor booked, and the AP tracker (a ledger of spent
 *   AP) gets no entry: `hasPlayerOwner` is the tracker's own gate, so it is shadowed on the
 *   instance only. Everything else (rule hooks, adoption, effects) runs unchanged.
 *
 * Instance properties shadow the prototype methods and are deleted afterwards, so no other
 * actor and no later call is affected.
 */
function installApGuard(actor: any, free: boolean) {
  const state = {
    refused: undefined as { cost: number; free: number } | undefined,
    waived: 0,
  };
  const originalCheck = actor.checkEnoughXP;
  actor.checkEnoughXP = async (cost: unknown) => {
    if (free) return true;
    const value = Number(cost);
    if (!actor.canAdvance || cost == null || isNaN(value)) {
      return originalCheck.call(actor, cost);
    }
    const exp = experience(actor);
    if (exp.free >= value) return originalCheck.call(actor, cost);
    state.refused = { cost: value, free: exp.free };
    return false;
  };
  if (free) {
    actor._updateAPs = async (ap: unknown) => {
      state.waived += Number(ap) || 0;
    };
    Object.defineProperty(actor, 'hasPlayerOwner', { configurable: true, get: () => false });
  }
  return {
    state,
    restore() {
      delete actor.checkEnoughXP;
      if (free) {
        delete actor._updateAPs;
        delete actor.hasPlayerOwner;
      }
    },
  };
}

interface Candidate {
  uuid: string;
  name: string;
  type: string;
  source: string;
}

async function findCandidates(
  name: string,
  type: string | undefined,
  pack: string | undefined
): Promise<Candidate[]> {
  const wanted = norm(name);
  const typeWanted = type ? norm(type) : undefined;
  const packWanted = pack ? norm(pack) : undefined;
  const found: Candidate[] = [];
  const matches = (entryName: unknown, entryType: unknown) =>
    norm(entryName) === wanted && (!typeWanted || norm(entryType) === typeWanted);

  if (!packWanted || packWanted === 'world') {
    for (const item of (game as any).items ?? []) {
      if (matches(item.name, item.type)) {
        found.push({ uuid: item.uuid, name: item.name, type: item.type, source: 'World items' });
      }
    }
  }
  if (packWanted === 'world') return found;

  const user = (game as any).user;
  for (const p of (game as any).packs ?? []) {
    if ((p.documentName ?? p.metadata?.type) !== 'Item') continue;
    if (!user?.isGM && !p.visible) continue;
    const id = norm(p.collection ?? p.metadata?.id);
    const label = norm(p.metadata?.label);
    if (
      packWanted &&
      id !== packWanted &&
      !id.includes(packWanted) &&
      !label.includes(packWanted)
    ) {
      continue;
    }
    const index = await p.getIndex();
    for (const entry of index) {
      if (matches(entry.name, entry.type)) {
        found.push({
          uuid: entry.uuid ?? `Compendium.${p.collection}.Item.${entry._id}`,
          name: entry.name,
          type: entry.type,
          source: p.metadata?.label ?? p.collection,
        });
      }
    }
  }
  return found;
}

/**
 * Resolves one requested item to a document. A name must match exactly one item; a name
 * like "Begabung" also finds the official "Begabung ()" when there is no exact match,
 * because adoptable items carry an empty "()" in their name.
 */
async function resolveSource(
  entry: Dsa5AddItemEntry
): Promise<{ doc: any; source: string } | { error: string; candidates?: Candidate[] }> {
  if (entry.uuid) {
    const doc = await (globalThis as any).fromUuid(entry.uuid);
    if (!doc) return { error: `No document found for UUID ${entry.uuid}` };
    if (doc.documentName !== 'Item') {
      return { error: `UUID ${entry.uuid} is a ${doc.documentName}, not an Item` };
    }
    return { doc, source: doc.pack ?? (doc.parent ? `actor ${doc.parent.name}` : 'World items') };
  }
  const name = String(entry.name ?? '').trim();
  if (!name) return { error: 'Each item needs a uuid or a name' };

  let candidates = await findCandidates(name, entry.type, entry.pack);
  if (candidates.length === 0 && !/\(\s*\)$/.test(name)) {
    candidates = await findCandidates(`${name} ()`, entry.type, entry.pack);
  }
  if (candidates.length === 0) {
    const where = entry.pack ? ` in "${entry.pack}"` : ' in world items or compendiums';
    return {
      error: `No item named "${name}"${entry.type ? ` of type ${entry.type}` : ''}${where}`,
    };
  }
  if (candidates.length > 1) {
    return {
      error: `"${name}" matches ${candidates.length} items; pass uuid (or type/pack) to choose one`,
      candidates,
    };
  }
  const doc = await (globalThis as any).fromUuid(candidates[0].uuid);
  if (!doc) return { error: `Could not load ${candidates[0].uuid}` };
  return { doc, source: candidates[0].source };
}

/**
 * Turns the `adoption` parameter into what the system's dialog callback would pass to the
 * rule function: `{ name }` for free text, the chosen actor item (name + system, whose StF
 * picks the AP cost from "A/B/C/D" values) for item choices, `{ name }` from the rule's
 * fixed list for "array" rules.
 */
function resolveAdoption(
  rule: any,
  entry: Dsa5AddItemEntry,
  actor: any,
  itemName: string,
  forAbility: boolean
): { adoption: any } | { error: string; choices?: string[] } {
  const wanted = entry.adoption?.trim();
  let choices: Array<{ name: string; system?: any }> | undefined;
  if (rule.items === 'text') {
    choices = undefined;
  } else if (rule.items === 'array') {
    choices = (rule.elems ?? []).map((name: string) => ({ name }));
  } else {
    const types: string[] = Array.isArray(rule.items) ? rule.items : [rule.items];
    choices = actor.items
      .filter((i: any) => types.includes(i.type))
      .map((i: any) => ({ name: i.name, system: i.system }))
      .sort((a: any, b: any) => a.name.localeCompare(b.name));
  }

  if (!wanted) {
    return {
      error: `"${itemName}" needs an adoption (the choice the sheet asks for in a dialog); pass ${
        choices ? '"adoption" with one of the listed choices' : '"adoption" as free text'
      }`,
      ...(choices ? { choices: choices.map(c => c.name) } : {}),
    };
  }

  let adoption: any;
  if (!choices) {
    adoption = { name: wanted };
  } else {
    const match = choices.find(c => norm(c.name) === norm(wanted));
    if (!match) {
      return {
        error: `"${wanted}" is not a valid adoption for "${itemName}"`,
        choices: choices.map(c => c.name),
      };
    }
    adoption = { ...match };
  }
  if (forAbility && rule.items !== 'text' && rule.items !== 'array') {
    adoption.customEntry = entry.adoptionDetail?.trim() || '';
  }
  return { adoption };
}

/** Advantages, disadvantages and special abilities through the system's rule classes. */
async function addRuleItem(
  actor: any,
  itemData: any,
  entry: Dsa5AddItemEntry,
  warnings: string[]
): Promise<{ error?: string; choices?: string[] }> {
  const isAbility = itemData.type === 'specialability';
  const apps = dsa5()?.apps ?? {};
  const rules = isAbility ? apps.SpecialabilityRulesDSA5 : apps.AdvantageRulesDSA5;
  const call = isAbility ? '_specialabilityReturnFunction' : '_vantageReturnFunction';
  if (typeof rules?.[call] !== 'function') {
    return { error: `This DSA5 version does not provide ${call}; cannot add ${itemData.type}` };
  }
  const ruleMap = isAbility
    ? dsa5()?.config?.AbilitiesNeedingAdaption
    : dsa5()?.config?.vantagesNeedingAdaption;
  const rule = ruleMap?.[itemData.name];

  let adoption: any = null;
  if (rule) {
    const resolved = resolveAdoption(rule, entry, actor, itemData.name, isAbility);
    if ('error' in resolved) return resolved;
    adoption = resolved.adoption;
  } else if (/\(\s*\)$/.test(itemData.name)) {
    // "Name ()" is a template the adoption dialog fills in. Without the rule (registered by
    // the content modules) the system would add it unadopted with an unparsable AP value.
    return {
      error:
        `"${itemData.name}" needs an adoption, but this world has no adoption rule for it ` +
        `(the rules are registered by the official content modules); add a concrete item instead`,
    };
  } else if (entry.adoption) {
    warnings.push(
      `"${itemData.name}" has no adoption rule in this world (rules come from the installed ` +
        `content modules); "adoption" was ignored`
    );
  }

  // The name the system gives the item after adoption, to find an existing one.
  let finalName = itemData.name;
  if (adoption) {
    const detail = adoption.customEntry ? `, ${adoption.customEntry}` : '';
    finalName = `${itemData.name.replace(' ()', '')} (${adoption.name}${detail})`;
  }
  const max = Number(isAbility ? itemData.system?.maxRank?.value : itemData.system?.max?.value);
  const existing = actor.items.find((i: any) => i.type === itemData.type && i.name === finalName);

  if (entry.step !== undefined) {
    if (!Number.isInteger(entry.step) || entry.step < 1) return { error: 'step must be 1 or more' };
    if (max > 0 && entry.step > max) {
      return { error: `"${finalName}" has at most ${max} step(s); step ${entry.step} requested` };
    }
  }

  if (!existing) {
    if (entry.step !== undefined) {
      itemData.system.step = { ...(itemData.system.step ?? {}), value: entry.step };
    }
    await rules[call](actor, itemData, itemData.type, adoption);
    return {};
  }

  // Already on the actor: the system raises it by one step per drop (within its maximum).
  const current = Number(existing.system?.step?.value) || 1;
  const target = entry.step ?? current + 1;
  if (target <= current) {
    return { error: `${actor.name} already has "${finalName}" at step ${current}` };
  }
  if (!(max > 0) || target > max) {
    return {
      error: `${actor.name} already has "${finalName}" at step ${current} and its maximum is ${max || current}`,
    };
  }
  for (let step = current; step < target; step++) {
    await rules[call](actor, itemData, itemData.type, adoption);
    const now = Number(actor.items.get(existing.id)?.system?.step?.value) || 0;
    if (now <= step) break;
  }
  return {};
}

/**
 * Item packages: the sheet resolves the package's entries (world items first, then
 * compendiums) and creates them as they are, without stacking.
 */
async function addItemPackage(
  actor: any,
  doc: any,
  warnings: string[]
): Promise<{ error?: string }> {
  const ItempackageData = (globalThis as any).CONFIG?.Item?.dataModels?.itempackage;
  const resolved: any[] = ItempackageData?.resolvePackage
    ? await ItempackageData.resolvePackage(doc)
    : await doc.system.resolveItems();
  const contents: any[] = Object.values(doc.system?.items ?? {});
  const missing = contents.filter(c => !resolved.some(r => r.name === c.name && r.type === c.type));
  if (missing.length) {
    warnings.push(
      `Package entries not found in world items or compendiums: ${missing
        .map(m => `${m.name} (${m.type})`)
        .join(', ')}`
    );
  }
  if (!resolved.length) return { error: `None of the entries of package "${doc.name}" were found` };
  await actor.createEmbeddedDocuments('Item', resolved);
  return {};
}

async function dispatch(
  actor: any,
  doc: any,
  itemData: any,
  entry: Dsa5AddItemEntry,
  warnings: string[]
): Promise<{ error?: string; choices?: string[] }> {
  const type: string = itemData.type;
  const sheet = actor.sheet;
  const quantityTypes = lootTypes();
  quantityTypes.add('money');

  if (entry.quantity !== undefined) {
    if (quantityTypes.has(type) && itemData.system?.quantity) {
      itemData.system.quantity.value = entry.quantity;
    } else {
      warnings.push(`quantity is ignored for ${type} items`);
    }
  }
  if (
    (entry.step !== undefined || entry.adoption) &&
    !['advantage', 'disadvantage', 'specialability'].includes(type)
  ) {
    warnings.push(`step/adoption only apply to advantages, disadvantages and special abilities`);
  }

  if (WIZARD_TYPES.has(type)) {
    return {
      error:
        `${type} items are added through the system's ${type} wizard, which needs dialog ` +
        `choices (attributes, skills, options); add it on the character sheet in Foundry`,
    };
  }
  if (type === 'advantage' || type === 'disadvantage' || type === 'specialability') {
    return addRuleItem(actor, itemData, entry, warnings);
  }
  if (SPELL_LIKE_TYPES.has(type)) {
    if (actor.items.some((i: any) => i.type === type && i.name === itemData.name)) {
      return { error: `${actor.name} already has the ${type} "${itemData.name}"` };
    }
    await sheet._addSpellOrLiturgy(itemData);
    return {};
  }
  if (lootTypes().has(type)) {
    await sheet._addLoot(itemData);
    return {};
  }
  if (type === 'money') {
    await sheet._addMoney(itemData);
    return {};
  }
  if (type === 'itempackage') return addItemPackage(actor, doc, warnings);
  if (type === 'disease') {
    if (actor.items.some((i: any) => i.type === type && i.name === itemData.name)) {
      return { error: `${actor.name} already has the disease "${itemData.name}"` };
    }
    await sheet._addDisease(itemData);
    return {};
  }
  if (type === 'trait') {
    // Only the creature sheet accepts traits (it books their AP value like a drop).
    if (typeof sheet._addTrait !== 'function') {
      return { error: `Traits can only be added to creatures (${actor.name} is a ${actor.type})` };
    }
    if (actor.items.some((i: any) => i.type === 'trait' && i.name === itemData.name)) {
      return { error: `${actor.name} already has the trait "${itemData.name}"` };
    }
    await sheet._addTrait(itemData);
    return {};
  }
  if (UNIQUE_TYPES.has(type)) {
    if (actor.items.some((i: any) => i.type === type && i.name === itemData.name)) {
      return { error: `${actor.name} already has the ${type} "${itemData.name}"` };
    }
    await sheet._addUniqueItem(itemData);
    return {};
  }
  if (type === 'application') {
    await sheet._handleApplication(itemData);
    return {};
  }
  if (type === 'spellextension') {
    const spell = actor.items.find(
      (i: any) => i.type === itemData.system?.category && i.name === itemData.system?.source
    );
    if (!spell) {
      return {
        error: `"${itemData.name}" extends the ${itemData.system?.category} "${itemData.system?.source}", which ${actor.name} does not have`,
      };
    }
    if (Number(spell.system?.talentValue?.value) < Number(itemData.system?.talentValue)) {
      return {
        error: `"${itemData.name}" needs ${spell.name} at ${itemData.system?.talentValue}; ${actor.name} has ${spell.system?.talentValue?.value}`,
      };
    }
    await sheet._handleSpellExtension(itemData);
    return {};
  }
  if (type === 'effectwrapper') {
    // Same as the sheet's _handleEffectWrapper: only the effects are applied to the actor.
    await actor.createEmbeddedDocuments(
      'ActiveEffect',
      (itemData.effects ?? []).map((e: any) => ({ ...e, origin: null }))
    );
    return {};
  }
  if (type === 'aggregatedTest' && actor.type === 'character') {
    await actor.createEmbeddedDocuments('Item', [itemData]);
    return {};
  }
  return { error: `The DSA5 sheet does not accept ${type} items on a ${actor.type}` };
}

function trackerNote(actor: any, free: boolean, apChanged: boolean, written: number): string {
  if (written > 0) return `${written} AP tracker entr${written === 1 ? 'y' : 'ies'} written`;
  if (!apChanged && !free) return 'no AP booked, nothing to track';
  if (free) return 'not tracked (free)';
  if (!trackingEnabled()) return 'AP tracking is disabled in the DSA5 settings';
  if (!actor.hasPlayerOwner)
    return 'not tracked: the DSA5 AP tracker only records player-owned actors';
  return 'no tracker entry written';
}

async function addOne(actor: any, entry: Dsa5AddItemEntry, defaultFree: boolean) {
  const label = entry.uuid ?? entry.name ?? '(no name)';
  const warnings: string[] = [];
  const resolved = await resolveSource(entry);
  if ('error' in resolved) {
    return {
      request: label,
      success: false,
      error: resolved.error,
      ...(resolved.candidates ? { candidates: resolved.candidates } : {}),
    };
  }
  const { doc, source } = resolved;
  const itemData = doc.toObject();
  const free = entry.free ?? defaultFree;

  const before = snapshot(actor);
  const effectsBefore = new Set(actor.effects.map((e: any) => e.id));
  const expBefore = experience(actor);
  const trackerBefore = trackerEntryCount(actor);

  const guard = installApGuard(actor, free);
  let outcome: { error?: string; choices?: string[] };
  try {
    outcome = await dispatch(actor, doc, itemData, entry, warnings);
  } catch (error) {
    outcome = { error: error instanceof Error ? error.message : String(error) };
  } finally {
    guard.restore();
  }

  const expAfter = experience(actor);
  const created: any[] = [];
  const changed: any[] = [];
  for (const item of actor.items) {
    const old = before.get(item.id);
    if (!old) {
      created.push({
        id: item.id,
        name: item.name,
        type: item.type,
        ...(typeof item.system?.quantity?.value === 'number'
          ? { quantity: item.system.quantity.value }
          : {}),
        ...(typeof item.system?.step?.value === 'number' &&
        ['advantage', 'disadvantage', 'specialability'].includes(item.type)
          ? { step: item.system.step.value }
          : {}),
        effects: item.effects.map((e: any) => e.name),
      });
      continue;
    }
    const quantity = item.system?.quantity?.value;
    const step = item.system?.step?.value;
    if (old.quantity !== undefined && quantity !== old.quantity) {
      changed.push({
        id: item.id,
        name: item.name,
        type: item.type,
        stacked: true,
        quantity: { before: old.quantity, after: quantity },
      });
    } else if (old.step !== undefined && step !== old.step) {
      changed.push({
        id: item.id,
        name: item.name,
        type: item.type,
        step: { before: old.step, after: step },
        effects: item.effects.map((e: any) => e.name),
      });
    }
  }
  // Status conditions (e.g. Schmerz after a LeP maximum change) are the system reacting to
  // the new values, not effects copied from the item, so they are listed separately.
  const newEffects = actor.effects.filter((e: any) => !effectsBefore.has(e.id));
  const isCondition = (e: any) => (e.statuses?.size ?? 0) > 0;
  const actorEffects = newEffects.filter((e: any) => !isCondition(e)).map((e: any) => e.name);
  const conditions = newEffects.filter(isCondition).map((e: any) => e.name);
  const apCharged = expAfter.spent - expBefore.spent;
  const trackerWritten = trackerEntryCount(actor) - trackerBefore;

  const result: Record<string, unknown> = {
    request: label,
    source: `${doc.name} (${doc.type}) from ${source}`,
  };
  if (created.length) result.created = created;
  if (changed.length) result.changed = changed;
  if (actorEffects.length) result.actorEffects = actorEffects;
  if (conditions.length) result.conditionsTriggered = conditions;

  const anything = created.length > 0 || changed.length > 0 || actorEffects.length > 0;
  if (guard.state.refused) {
    result.success = false;
    result.error =
      `Not enough AP: ${guard.state.refused.cost} needed, ${guard.state.refused.free} free ` +
      `(the system refuses to overspend; pass free: true for a GM ruling)`;
  } else if (outcome.error) {
    result.success = false;
    result.error = outcome.error;
    if (outcome.choices) result.choices = outcome.choices;
  } else if (!anything) {
    result.success = false;
    result.error = 'The system did not add the item (nothing changed on the actor)';
  } else {
    result.success = true;
  }

  if (actor.canAdvance) {
    result.ap = {
      charged: apCharged,
      ...(free ? { waived: guard.state.waived } : {}),
      freeBefore: expBefore.free,
      freeAfter: expAfter.free,
    };
    result.tracker = trackerNote(actor, free, apCharged !== 0, trackerWritten);
  } else if (anything) {
    warnings.push(
      `${actor.name} (${actor.type}) has no AP budget; added without AP like the sheet does`
    );
  }
  if (warnings.length) result.warnings = warnings;
  return result;
}

async function removeOne(actor: any, entry: Dsa5AddItemEntry) {
  const label = entry.uuid ?? entry.name ?? '(no name)';
  const wanted = norm(entry.name);
  let matches: any[];
  if (entry.uuid) {
    matches = actor.items.filter((i: any) => i.uuid === entry.uuid || i.id === entry.uuid);
  } else {
    matches = actor.items.filter(
      (i: any) =>
        (i.id === entry.name || norm(i.name) === wanted) &&
        (!entry.type || norm(i.type) === norm(entry.type))
    );
  }
  if (matches.length === 0) {
    return { request: label, success: false, error: `${actor.name} has no item "${label}"` };
  }
  if (matches.length > 1) {
    return {
      request: label,
      success: false,
      error: `"${label}" matches ${matches.length} items on ${actor.name}; pass its id or type`,
      candidates: matches.map((i: any) => ({ id: i.id, name: i.name, type: i.type })),
    };
  }
  const item = matches[0];
  const before = snapshot(actor);
  const expBefore = experience(actor);
  const trackerBefore = trackerEntryCount(actor);
  try {
    // The sheet's delete path (after its confirmation dialog): refunds AP for advantages,
    // special abilities, spells (with their extensions) and books the tracker entry.
    await actor.sheet._cleverDeleteItem(item.id);
  } catch (error) {
    return {
      request: label,
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
  const removed = [...before.entries()]
    .filter(([id]) => !actor.items.get(id))
    .map(([id, s]) => ({ id, name: s.name, type: s.type }));
  const expAfter = experience(actor);
  const result: Record<string, unknown> = {
    request: label,
    success: removed.length > 0,
    removed,
  };
  if (!removed.length) result.error = 'The system did not remove the item';
  if (actor.canAdvance) {
    const trackerWritten = trackerEntryCount(actor) - trackerBefore;
    result.ap = {
      refunded: expBefore.spent - expAfter.spent,
      freeBefore: expBefore.free,
      freeAfter: expAfter.free,
    };
    result.tracker = trackerNote(actor, false, expAfter.spent !== expBefore.spent, trackerWritten);
  }
  return result;
}

/**
 * Adds (or removes) the requested items one after the other, so a later entry can use an
 * earlier one (e.g. a Talent added first and then chosen as an adoption). A failing entry
 * is reported and does not stop the others.
 */
export async function dsa5AddItems(actor: any, request: Dsa5AddItemsRequest): Promise<any> {
  const action = request.action ?? 'add';
  const results: any[] = [];
  for (const entry of request.items) {
    results.push(
      action === 'remove'
        ? await removeOne(actor, entry)
        : await addOne(actor, entry, Boolean(request.free))
    );
  }
  const succeeded = results.filter(r => r.success).length;
  const exp = experience(actor);
  return {
    success: succeeded > 0,
    action,
    actor: actor.name,
    actorId: actor.id,
    summary: `${succeeded} of ${results.length} item(s) ${action === 'remove' ? 'removed' : 'added'}`,
    ...(actor.canAdvance ? { apFree: exp.free, apTotal: exp.total } : {}),
    results,
  };
}
