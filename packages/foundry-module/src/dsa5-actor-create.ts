/**
 * DSA5 actor creation that matches an actor created in Foundry's own UI.
 *
 * DSA5 adds its per-actor defaults (all Talente, all Kampftechniken, the coin items,
 * 0 Schicksalspunkte for non-heroes, starting LeP) in the static `Actordsa5.create`,
 * not in a data model or `_preCreate`. The core `Actor.create` / `Actor.createDocuments`
 * statics never call that override, so actors created through them came out without
 * any of those items and with 0 LeP, which the system immediately answers with Pain
 * and Incapacitated.
 *
 * The helpers here therefore create each actor through the configured document class
 * (`CONFIG.Actor.documentClass.create`), i.e. the system's own creation path, and only
 * add what that path cannot do for us:
 *
 * - Caller-provided items. `Actordsa5.create` skips all defaults as soon as `items` is
 *   present, so the actor is created without them and they are added afterwards. A
 *   caller item whose type and name match one of the defaults (skill, combat skill,
 *   coin) updates that default item instead of creating a duplicate; the caller's
 *   fields (e.g. a talent value) win.
 * - Starting LeP. The system stores a fixed 16 LeP, which only matches the derived
 *   maximum for an unmodified hero. When the caller does not set the current LeP, the
 *   stored value is set to the derived maximum (before creation where it can be
 *   computed, and corrected after the items exist). AsP/KaP are left alone because the
 *   system does not set them for new actors either.
 */

/** Item types `Actordsa5.create` adds to every new character, npc and creature. */
const DEFAULT_ITEM_TYPES = new Set(['skill', 'combatskill', 'money']);

/** Actor types whose LeP live in `system.status.wounds`. */
const WOUNDED_ACTOR_TYPES = new Set(['character', 'npc', 'creature']);

const WOUNDS_VALUE_PATH = 'system.status.wounds.value';

export interface Dsa5ActorCreateData {
  name: string;
  type: string;
  img?: string;
  system?: Record<string, any>;
  folder?: string | null;
  [key: string]: unknown;
}

function itemKey(type: unknown, name: unknown): string | null {
  if (typeof type !== 'string' || typeof name !== 'string') return null;
  if (!DEFAULT_ITEM_TYPES.has(type)) return null;
  const trimmed = name.trim().toLowerCase();
  return trimmed ? `${type}|${trimmed}` : null;
}

/** The current LeP the caller asked for, or undefined when the caller left it out. */
export function explicitWoundsValue(system: Record<string, any> | undefined): number | undefined {
  if (!system || typeof system !== 'object') return undefined;
  // Callers may use dotted keys ("status.wounds.value"); Foundry expands those on create.
  const expanded = foundry.utils.expandObject(system) as Record<string, any>;
  const value = expanded?.status?.wounds?.value;
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function stripIdentity(item: Record<string, any>): Record<string, any> {
  const copy = foundry.utils.deepClone(item);
  delete copy._id;
  delete copy.folder;
  delete copy.sort;
  return copy;
}

/**
 * Derived maximum LeP for not-yet-created actor data, computed on a temporary
 * (never saved) document so items such as advantages are taken into account.
 */
function probeMaxWounds(ActorClass: any, data: Record<string, any>, items: any[]): number | null {
  try {
    const probe = new ActorClass({ ...foundry.utils.deepClone(data), items });
    const max = Number(probe?.system?.status?.wounds?.max);
    return Number.isFinite(max) && max > 0 ? max : null;
  } catch {
    // The probe is only an optimisation; the post-creation check below still applies.
    return null;
  }
}

/** Adds caller items, merging same-name defaults instead of duplicating them. */
async function addCallerItems(actor: any, items: any[]): Promise<void> {
  const defaults = new Map<string, string>();
  for (const item of actor.items ?? []) {
    const key = itemKey(item.type, item.name);
    if (key && !defaults.has(key)) defaults.set(key, item.id);
  }

  const updates = new Map<string, Record<string, any>>();
  const creates: Record<string, any>[] = [];
  for (const raw of items) {
    if (!raw || typeof raw !== 'object') continue;
    const item = stripIdentity(raw);
    const existingId = defaults.get(itemKey(item.type, item.name) ?? '');
    if (!existingId) {
      creates.push(item);
      continue;
    }
    // Keep the default's name and type; everything else the caller sent overrides it.
    delete item.name;
    delete item.type;
    const previous = updates.get(existingId) ?? { _id: existingId };
    updates.set(existingId, foundry.utils.mergeObject(previous, item, { inplace: false }));
  }

  if (updates.size > 0) await actor.updateEmbeddedDocuments('Item', [...updates.values()]);
  if (creates.length > 0) await actor.createEmbeddedDocuments('Item', creates);
}

/**
 * Create one DSA5 actor through the system's own creation path and add the caller's
 * items. If adding the items fails, the half-created actor is deleted again.
 */
export async function createDsa5Actor(data: Dsa5ActorCreateData, items: any[] = []): Promise<any> {
  const ActorClass = (CONFIG as any).Actor.documentClass;
  const createData: Record<string, any> = foundry.utils.deepClone(data);
  delete createData.items;
  const callerItems = (Array.isArray(items) ? items : []).filter(
    item => item && typeof item === 'object'
  );

  const tracksWounds = WOUNDED_ACTOR_TYPES.has(createData.type);
  const requestedWounds = explicitWoundsValue(createData.system);

  if (tracksWounds && requestedWounds === undefined) {
    const max = probeMaxWounds(ActorClass, createData, callerItems.map(stripIdentity));
    if (max !== null) foundry.utils.setProperty(createData, WOUNDS_VALUE_PATH, max);
  }

  const actor = await ActorClass.create(createData);
  if (!actor) throw new Error(`Foundry failed to create actor "${data.name}"`);

  try {
    if (callerItems.length > 0) await addCallerItems(actor, callerItems);

    if (tracksWounds) {
      const stored = foundry.utils.getProperty(actor._source ?? {}, WOUNDS_VALUE_PATH);
      const max = Number(actor.system?.status?.wounds?.max);
      // An explicit value wins; Actordsa5.create replaces an explicit 0 with 16.
      const target =
        requestedWounds !== undefined
          ? requestedWounds
          : Number.isFinite(max) && max > 0
            ? max
            : undefined;
      if (target !== undefined && stored !== target) {
        await actor.update({ [WOUNDS_VALUE_PATH]: target });
      }
    }
  } catch (error) {
    await actor.delete().catch(() => undefined);
    throw error;
  }

  return actor;
}

/**
 * Create several DSA5 actors one by one (the system's defaults are only applied to
 * single-actor creates). All-or-nothing like a batch create: if one fails, the actors
 * already created by this call are deleted again.
 */
export async function createDsa5Actors(
  entries: Array<{ data: Dsa5ActorCreateData; items?: any[] }>
): Promise<any[]> {
  const created: any[] = [];
  try {
    for (const entry of entries) {
      created.push(await createDsa5Actor(entry.data, entry.items ?? []));
    }
  } catch (error) {
    for (const actor of created) await actor.delete().catch(() => undefined);
    throw error;
  }
  return created;
}
