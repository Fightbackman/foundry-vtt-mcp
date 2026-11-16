/**
 * DSA5 structured journal pages.
 *
 * The DSA5 system (Das Schwarze Auge / The Dark Eye 5e) ships its own JournalEntryPage
 * types. Each page stores a keyed collection of entries under `page.system.<collection>`:
 *
 *   dsapersonaedramatis → personae         (Dramatis Personae)
 *   dsaquestlog         → quests           (quest log)
 *   dsacalendar         → calendarentries  (almanac events)
 *   citydetails         → details          (city details: temples, inns, merchants, …)
 *   dsaaptracker        → entries          (AP log, written by the system)
 *   dsamoneytracker     → entries          (money log, written by the system)
 *
 * The generic journal tools only understand `text` pages, so this class reads and writes
 * the structured ones. Writes go through `page.update()` so the system's own hooks keep
 * running (filling a persona from its linked actor, computing an event's day of year,
 * almanac notifications), and journals are registered with the system's almanac the same
 * way the system does it when the GM creates an entry by hand.
 */

import { MODULE_ID } from './constants.js';
import { permissionManager } from './permissions.js';

export type DSA5JournalPageType =
  | 'personae'
  | 'quests'
  | 'calendar'
  | 'citydetails'
  | 'aptracker'
  | 'moneytracker';

interface PageTypeConfig {
  /** JournalEntryPage type registered by the DSA5 system. */
  foundryType: string;
  /** Key of the entry collection under `page.system`. */
  collection: string;
  /** Entry field holding its display name. */
  titleField: string;
  writable: boolean;
  /** dsa5 world setting listing the journals shown in the almanac. */
  settingName?: string;
  /** CalendarPicker parts to re-render after registering a journal. */
  refreshParts?: string[];
  /** i18n key of the system's default journal/page name, plus a fallback. */
  defaultNameKey?: string;
  defaultName: string;
}

export const DSA5_JOURNAL_PAGE_TYPES: Record<DSA5JournalPageType, PageTypeConfig> = {
  personae: {
    foundryType: 'dsapersonaedramatis',
    collection: 'personae',
    titleField: 'name',
    writable: true,
    settingName: 'calendarActors',
    refreshParts: ['personae', 'config'],
    defaultNameKey: 'PERSONAE.ImportantPersons',
    defaultName: 'Dramatis Personae',
  },
  quests: {
    foundryType: 'dsaquestlog',
    collection: 'quests',
    titleField: 'title',
    writable: true,
    settingName: 'questlogJournals',
    refreshParts: ['questlog', 'config'],
    defaultNameKey: 'DSAQUESTLOG.defaultJournalName',
    defaultName: 'Quest Log',
  },
  calendar: {
    foundryType: 'dsacalendar',
    collection: 'calendarentries',
    titleField: 'title',
    writable: true,
    settingName: 'calendarJournals',
    refreshParts: ['events', 'config'],
    defaultNameKey: 'dsacalendar.defaultJournalName',
    defaultName: 'Calendar',
  },
  citydetails: {
    foundryType: 'citydetails',
    collection: 'details',
    titleField: 'name',
    writable: true,
    defaultNameKey: 'DSACITYDETAILS.Name',
    defaultName: 'City Details',
  },
  aptracker: {
    foundryType: 'dsaaptracker',
    collection: 'entries',
    titleField: 'itemName',
    writable: false,
    defaultName: 'AP Tracker',
  },
  moneytracker: {
    foundryType: 'dsamoneytracker',
    collection: 'entries',
    titleField: 'name',
    writable: false,
    defaultName: 'Money Tracker',
  },
};

// Friendly names for the system's numeric choices; the array index is the stored value.
const PERSONA_KINDS = ['person', 'creature'] as const;
const QUEST_STATUS = ['open', 'ended', 'failed'] as const;
const OBJECTIVE_STATUS = ['open', 'done', 'failed'] as const;
const QUEST_PRIORITY = ['main', 'side', 'personal'] as const;
const QUEST_AUDIENCE = ['party', 'players', 'gm'] as const;
const CALENDAR_CATEGORIES = ['general', 'holiday', 'anniversary', 'historical', 'milestone'];
const CALENDAR_CATEGORY_I18N = ['general', 'holidays', 'event', 'historical', 'milestones'];
const CITY_KINDS = [
  'temples',
  'inns',
  'taverns',
  'crafts',
  'merchants',
  'services',
  'healers',
  'travellers',
];
const GARADAN_VALUES = [0, 1, 2, 3, 4, 6];

/** Aventurian months; the index is the stored (0-based) month. */
const MONTHS = [
  'Praios',
  'Rondra',
  'Efferd',
  'Travia',
  'Boron',
  'Hesinde',
  'Firun',
  'Tsa',
  'Phex',
  'Peraine',
  'Ingerimm',
  'Rahja',
  'Namenlose Tage',
];

const SUMMARY_TEXT_LENGTH = 300;
const DEFAULT_LIMIT = 50;

const gameAny = (): any => game as any;
const globalAny = (): any => globalThis as any;

function toArray(collection: any): any[] {
  if (!collection) return [];
  if (Array.isArray(collection)) return collection;
  if (Array.isArray(collection.contents)) return collection.contents;
  return Array.from(collection as Iterable<any>);
}

function localize(key: string, fallback?: string): string {
  const localized = gameAny().i18n?.localize?.(key);
  return localized && localized !== key ? localized : (fallback ?? key);
}

function sameText(a: unknown, b: unknown): boolean {
  return String(a ?? '').toLowerCase() === String(b ?? '').toLowerCase();
}

/** Wrap plain text in paragraphs; anything that already contains markup is kept as is. */
export function textToHtml(text: string): string {
  if (/<[a-z][^>]*>/i.test(text)) return text;
  const escape = (s: string) =>
    s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return text
    .split(/\n{2,}/)
    .map(paragraph => paragraph.trim())
    .filter(Boolean)
    .map(paragraph => `<p>${escape(paragraph).replace(/\n/g, '<br>')}</p>`)
    .join('');
}

/** Reduce HTML to readable text, optionally cut to a maximum length. */
export function htmlToText(html: unknown, maxLength?: number): string {
  const text = String(html ?? '')
    .replace(/<\s*br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|h[1-6])>/gi, '\n')
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/[ \t]+/g, ' ')
    .replace(/\s*\n\s*/g, '\n')
    .trim();
  if (maxLength && text.length > maxLength) return `${text.slice(0, maxLength).trimEnd()}…`;
  return text;
}

/**
 * Month given as a 1-based number (1 = Praios … 12 = Rahja, 13 = the Nameless Days) or a
 * month name, returned as the 0-based index the system stores.
 */
export function parseMonth(value: unknown): number {
  if (typeof value === 'number') {
    if (!Number.isInteger(value) || value < 1 || value > MONTHS.length) {
      throw new Error(`month must be 1-${MONTHS.length} or a month name, got ${value}`);
    }
    return value - 1;
  }
  const name = String(value ?? '')
    .trim()
    .toLowerCase();
  if (/^\d+$/.test(name)) return parseMonth(Number(name));
  if (name.startsWith('namenlos') || name.startsWith('nameless')) return MONTHS.length - 1;
  const index = MONTHS.findIndex(month => month.toLowerCase() === name);
  if (index >= 0) return index;

  const calendarMonths: any[] = gameAny().time?.calendar?.months?.values ?? [];
  const localizedIndex = calendarMonths.findIndex(
    month => sameText(localize(month?.name ?? ''), name) || sameText(month?.name, name)
  );
  if (localizedIndex >= 0) return localizedIndex;
  throw new Error(`Unknown month "${value}". Use 1-13 or one of: ${MONTHS.join(', ')}`);
}

function monthName(index: number): string {
  const month = gameAny().time?.calendar?.months?.values?.[index];
  return month?.name ? localize(month.name, MONTHS[index]) : (MONTHS[index] ?? String(index + 1));
}

function enumIndex(list: readonly string[], value: unknown, field: string): number {
  if (typeof value === 'number' && Number.isInteger(value) && value >= 0 && value < list.length) {
    return value;
  }
  const index = list.indexOf(String(value).toLowerCase());
  if (index < 0) throw new Error(`${field} must be one of: ${list.join(', ')}`);
  return index;
}

function enumName(list: readonly string[], value: unknown): string {
  return list[Number(value) || 0] ?? String(value);
}

function tagList(tags: unknown): string[] {
  if (Array.isArray(tags)) return tags.map(tag => String(tag).trim()).filter(Boolean);
  return String(tags ?? '')
    .split(',')
    .map(tag => tag.trim())
    .filter(Boolean);
}

function collectStrings(value: unknown, out: string[] = []): string[] {
  if (typeof value === 'string') out.push(value);
  else if (value && typeof value === 'object') {
    for (const child of Object.values(value)) collectStrings(child, out);
  }
  return out;
}

/** Mark `key` for deletion: Foundry v14's `_del` operator, or the legacy `-=key` form. */
function setDeletion(target: Record<string, any>, key: string): void {
  const del = globalAny()._del;
  if (del !== undefined) target[key] = del;
  else target[`-=${key}`] = null;
}

async function resolveUuid(uuid: string): Promise<any> {
  try {
    return (await globalAny().fromUuid?.(uuid)) ?? null;
  } catch {
    return null;
  }
}

function sortedEntries(collection: any): Array<[string, any]> {
  return Object.entries(collection ?? {}).sort(
    ([, a]: [string, any], [, b]: [string, any]) => (Number(a?.sort) || 0) - (Number(b?.sort) || 0)
  );
}

function nextSort(collection: any): { value: number; density: number } {
  const density = Number(globalAny().CONST?.SORT_INTEGER_DENSITY) || 100000;
  const sorts = Object.values(collection ?? {}).map((entry: any) => Number(entry?.sort) || 0);
  return { value: (sorts.length ? Math.max(...sorts) : -density) + density, density };
}

interface PageRef {
  journal: any;
  page: any;
}

export interface DSA5JournalReadRequest {
  pageType?: DSA5JournalPageType;
  page?: string;
  journal?: string;
  entryKey?: string;
  search?: string;
  faction?: string;
  tag?: string;
  status?: string;
  kind?: string;
  visible?: boolean;
  limit?: number;
}

export interface DSA5JournalManageRequest {
  pageType: DSA5JournalPageType;
  action: 'create' | 'update' | 'delete';
  entryKey?: string;
  page?: string;
  journal?: string;
  pageName?: string;
  data?: Record<string, any>;
}

export class DSA5JournalAccess {
  // ───────────────────────────── public API ─────────────────────────────

  async read(request: DSA5JournalReadRequest = {}): Promise<any> {
    try {
      this.assertDsa5();
      if (!request.pageType) return { success: true, pages: this.overview() };

      const config = this.config(request.pageType);
      const pages = this.findPages(config, request);

      if (request.entryKey) {
        for (const ref of pages) {
          const entry = this.entriesOf(config, ref.page)[request.entryKey];
          if (!entry) continue;
          return {
            success: true,
            pageType: request.pageType,
            page: this.describePage(config, ref),
            entry: await this.formatEntry(request.pageType, ref, request.entryKey, entry, true),
          };
        }
        throw new Error(`No ${request.pageType} entry with key "${request.entryKey}" found`);
      }

      const matches: any[] = [];
      for (const ref of pages) {
        for (const [key, raw] of Object.entries(this.entriesOf(config, ref.page))) {
          const entry = await this.formatEntry(request.pageType, ref, key, raw, false);
          if (this.matchesFilters(entry, raw, request)) matches.push(entry);
        }
      }
      if (!config.writable) matches.sort((a, b) => (b.created ?? 0) - (a.created ?? 0));

      const limit = Math.max(1, request.limit ?? DEFAULT_LIMIT);
      return {
        success: true,
        pageType: request.pageType,
        pages: pages.map(ref => this.describePage(config, ref)),
        totalMatches: matches.length,
        returned: Math.min(matches.length, limit),
        entries: matches.slice(0, limit),
      };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  async manage(request: DSA5JournalManageRequest): Promise<any> {
    try {
      this.assertDsa5();
      const config = this.config(request.pageType);
      if (!config.writable) {
        throw new Error(`${request.pageType} pages are maintained by the DSA5 system (read-only)`);
      }

      const operation = request.action === 'delete' ? 'deleteData' : 'createActor';
      const permission = permissionManager.checkWritePermission(operation);
      if (!permission.allowed) {
        throw new Error(`DSA5 journal ${request.action} denied: ${permission.reason}`);
      }

      const warnings: string[] = [];
      const data = request.data ?? {};

      if (request.action === 'create') {
        const target = await this.resolveCreateTarget(config, request);
        const key: string = (foundry.utils as any).randomID();
        await this.writeEntry(request.pageType, config, target.page, key, null, data, warnings);
        await this.registerInAlmanac(config, target.journal, warnings);
        return this.manageResult(request, config, target, key, warnings, {
          ...(target.createdJournal ? { createdJournal: true } : {}),
          ...(target.createdPage ? { createdPage: true } : {}),
        });
      }

      if (!request.entryKey) throw new Error(`entryKey is required for ${request.action}`);
      const key = request.entryKey;
      const ref = this.findPages(config, request).find(
        candidate => this.entriesOf(config, candidate.page)[key] !== undefined
      );
      if (!ref) throw new Error(`No ${request.pageType} entry with key "${key}" found`);
      const existing = this.entriesOf(config, ref.page)[key];

      if (request.action === 'delete') {
        const removal: Record<string, any> = {};
        setDeletion(removal, key);
        await ref.page.update({ system: { [config.collection]: removal } });
        console.log(`[${MODULE_ID}] Deleted DSA5 ${request.pageType} entry ${key}`);
        return {
          success: true,
          action: 'delete',
          pageType: request.pageType,
          page: this.describePage(config, ref),
          deleted: { entryKey: key, name: existing?.[config.titleField] ?? '' },
        };
      }

      if (Object.keys(data).length === 0) throw new Error('data must contain at least one field');
      await this.writeEntry(request.pageType, config, ref.page, key, existing, data, warnings);
      await this.registerInAlmanac(config, ref.journal, warnings);
      return this.manageResult(request, config, ref, key, warnings);
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  /** One-line description of a DSA5 page for the generic journal tools; null for other pages. */
  static describeStructuredPage(page: any): string | null {
    const found = Object.entries(DSA5_JOURNAL_PAGE_TYPES).find(
      ([, config]) => config.foundryType === page?.type
    );
    if (!found || gameAny().system?.id !== 'dsa5') return null;
    const [pageType, config] = found;
    const count = Object.keys(page.system?.[config.collection] ?? {}).length;
    return (
      `[DSA5 structured page "${pageType}" with ${count} entries. ` +
      `Read it with dsa5-journal-read (pageType: "${pageType}", page: "${page.uuid ?? page.id}").]`
    );
  }

  // ───────────────────────────── lookup ─────────────────────────────

  private assertDsa5(): void {
    const systemId = gameAny().system?.id;
    if (systemId !== 'dsa5') {
      throw new Error(`DSA5 journal tools require the DSA5 system (current: "${systemId}")`);
    }
  }

  private config(pageType: string): PageTypeConfig {
    const config = (DSA5_JOURNAL_PAGE_TYPES as Record<string, PageTypeConfig>)[pageType];
    if (!config) {
      throw new Error(
        `Unknown pageType "${pageType}". Use one of: ${Object.keys(DSA5_JOURNAL_PAGE_TYPES).join(', ')}`
      );
    }
    return config;
  }

  private allPages(config: PageTypeConfig): PageRef[] {
    const refs: PageRef[] = [];
    for (const journal of toArray(gameAny().journal)) {
      for (const page of toArray(journal.pages)) {
        if (page.type === config.foundryType) refs.push({ journal, page });
      }
    }
    return refs;
  }

  private matchesJournal(journal: any, identifier: string): boolean {
    return (
      journal.id === identifier || journal.uuid === identifier || sameText(journal.name, identifier)
    );
  }

  private matchesPage(page: any, identifier: string): boolean {
    return page.id === identifier || page.uuid === identifier || sameText(page.name, identifier);
  }

  /** Pages of one type, narrowed by the optional `page` / `journal` identifiers. */
  private findPages(
    config: PageTypeConfig,
    filter: { page?: string; journal?: string }
  ): PageRef[] {
    let refs = this.allPages(config);
    if (filter.journal) {
      refs = refs.filter(ref => this.matchesJournal(ref.journal, filter.journal as string));
    }
    if (filter.page) {
      refs = refs.filter(ref => this.matchesPage(ref.page, filter.page as string));
      if (refs.length === 0)
        throw new Error(`No ${config.foundryType} page "${filter.page}" found`);
    }
    return refs;
  }

  private entriesOf(config: PageTypeConfig, page: any): Record<string, any> {
    const source = typeof page.toObject === 'function' ? page.toObject()?.system : page.system;
    return source?.[config.collection] ?? {};
  }

  private isRegistered(config: PageTypeConfig, journal: any): boolean | undefined {
    if (!config.settingName) return undefined;
    try {
      const activated = gameAny().settings.get('dsa5', config.settingName)?.activated ?? [];
      return activated.some((entry: any) => entry?.uuid === journal.uuid);
    } catch {
      return false;
    }
  }

  private describePage(config: PageTypeConfig, ref: PageRef): any {
    const registered = this.isRegistered(config, ref.journal);
    return {
      journalId: ref.journal.id,
      journalName: ref.journal.name,
      pageId: ref.page.id,
      pageName: ref.page.name,
      pageUuid: ref.page.uuid,
      entryCount: Object.keys(this.entriesOf(config, ref.page)).length,
      ...(registered !== undefined ? { shownInAlmanac: registered } : {}),
    };
  }

  private overview(): any[] {
    const pages: any[] = [];
    for (const [pageType, config] of Object.entries(DSA5_JOURNAL_PAGE_TYPES)) {
      for (const ref of this.allPages(config)) {
        pages.push({ pageType, writable: config.writable, ...this.describePage(config, ref) });
      }
    }
    return pages;
  }

  /**
   * Target page for a new entry: the named one, the only one of its type, or a freshly
   * created journal/page named like the system would name it.
   */
  private async resolveCreateTarget(
    config: PageTypeConfig,
    request: DSA5JournalManageRequest
  ): Promise<PageRef & { createdJournal?: boolean; createdPage?: boolean }> {
    const defaultName = localize(config.defaultNameKey ?? '', config.defaultName);
    const pageData = { name: request.pageName || defaultName, type: config.foundryType };

    if (request.page) {
      const refs = this.findPages(config, request);
      if (refs.length > 1) throw new Error(this.ambiguousPages(config, refs));
      return refs[0];
    }

    if (request.journal) {
      const journal = toArray(gameAny().journal).find(candidate =>
        this.matchesJournal(candidate, request.journal as string)
      );
      if (journal) {
        const refs = this.allPages(config).filter(
          ref =>
            ref.journal === journal &&
            (!request.pageName || sameText(ref.page.name, request.pageName))
        );
        if (refs.length === 1) return refs[0];
        if (refs.length > 1) throw new Error(this.ambiguousPages(config, refs));
        const [page] = await journal.createEmbeddedDocuments('JournalEntryPage', [pageData]);
        return { journal, page, createdPage: true };
      }
      return this.createJournal(config, request.journal, pageData);
    }

    const refs = this.allPages(config).filter(
      ref => !request.pageName || sameText(ref.page.name, request.pageName)
    );
    if (refs.length === 1) return refs[0];
    if (refs.length > 1) throw new Error(this.ambiguousPages(config, refs));
    return this.createJournal(config, defaultName, pageData);
  }

  private async createJournal(
    config: PageTypeConfig,
    name: string,
    pageData: { name: string; type: string }
  ): Promise<PageRef & { createdJournal: boolean; createdPage: boolean }> {
    const journal = await globalAny().JournalEntry.create({ name, pages: [pageData] });
    const page = toArray(journal?.pages).find(candidate => candidate.type === config.foundryType);
    if (!journal || !page) throw new Error(`Failed to create a ${config.foundryType} journal`);
    return { journal, page, createdJournal: true, createdPage: true };
  }

  private ambiguousPages(config: PageTypeConfig, refs: PageRef[]): string {
    const list = refs
      .map(ref => `"${ref.journal.name} / ${ref.page.name}" (${ref.page.uuid})`)
      .join(', ');
    return `Several ${config.foundryType} pages match; pass "page" to pick one: ${list}`;
  }

  /** Same effect as the system's JournalEntryTargetHelper.registerJournal. */
  private async registerInAlmanac(
    config: PageTypeConfig,
    journal: any,
    warnings: string[]
  ): Promise<void> {
    if (!config.settingName || this.isRegistered(config, journal)) return;
    try {
      const settings = gameAny().settings.get('dsa5', config.settingName) ?? {};
      const activated = Array.isArray(settings.activated) ? settings.activated : [];
      await gameAny().settings.set('dsa5', config.settingName, {
        ...settings,
        activated: [...activated, { uuid: journal.uuid, name: journal.name }],
      });
      await gameAny().dsa5?.apps?.CalendarPicker?.refreshParts?.(config.refreshParts ?? []);
    } catch (error) {
      warnings.push(
        `Entry saved, but the journal could not be added to the almanac: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }
  }

  private findActors(identifier: string): any[] {
    const actors = toArray(gameAny().actors);
    const byId = actors.filter(actor => actor.id === identifier || actor.uuid === identifier);
    if (byId.length) return byId;
    const exact = actors.filter(actor => actor.name === identifier);
    if (exact.length) return exact;
    return actors.filter(actor => sameText(actor.name, identifier));
  }

  private async resolveActor(identifier: string, field: string): Promise<any> {
    if (identifier.includes('.')) {
      const document = await resolveUuid(identifier);
      if (document && (document.documentName ?? 'Actor') === 'Actor') return document;
    }
    const matches = this.findActors(identifier);
    if (matches.length === 1) return matches[0];
    if (matches.length > 1) {
      const list = matches.map(actor => `${actor.name} (${actor.uuid})`).join(', ');
      throw new Error(`${field}: "${identifier}" matches several actors, pass a UUID: ${list}`);
    }
    throw new Error(`${field}: actor "${identifier}" not found`);
  }

  private resolveUsers(identifiers: string[]): string[] {
    const users = toArray(gameAny().users);
    return identifiers.map(identifier => {
      const user =
        users.find(candidate => candidate.id === identifier || candidate.name === identifier) ??
        users.find(candidate => sameText(candidate.name, identifier));
      if (!user) throw new Error(`players: user "${identifier}" not found`);
      return user.id as string;
    });
  }

  /** Resolve a quest link given as a UUID or as the name of an actor, item, journal or page. */
  private async resolveLinkUuid(reference: string): Promise<string> {
    if (reference.includes('.')) {
      const document = await resolveUuid(reference);
      if (document) return document.uuid ?? reference;
    }
    const candidates: any[] = [
      ...toArray(gameAny().actors),
      ...toArray(gameAny().items),
      ...toArray(gameAny().journal),
      ...toArray(gameAny().journal).flatMap(journal => toArray(journal.pages)),
    ].filter(document => sameText(document.name, reference) || document.id === reference);

    if (candidates.length === 1) return candidates[0].uuid;
    if (candidates.length > 1) {
      const list = candidates.map(document => `${document.name} (${document.uuid})`).join(', ');
      throw new Error(`links: "${reference}" matches several documents, pass a UUID: ${list}`);
    }
    throw new Error(`links: no actor, item, journal or page named "${reference}" found`);
  }

  // ───────────────────────────── reading ─────────────────────────────

  private matchesFilters(entry: any, raw: any, request: DSA5JournalReadRequest): boolean {
    if (request.visible !== undefined && entry.visible !== request.visible) return false;
    if (request.status && !sameText(entry.status, request.status)) return false;
    if (request.kind && !sameText(entry.kind, request.kind)) return false;
    if (request.faction) {
      if (
        !String(entry.faction ?? '')
          .toLowerCase()
          .includes(request.faction.toLowerCase())
      ) {
        return false;
      }
    }
    if (request.tag) {
      const tags: string[] = entry.tags ?? [];
      if (!tags.some(tag => sameText(tag, request.tag))) return false;
    }
    if (request.search) {
      const haystack = [...collectStrings(raw), ...collectStrings(entry)].join('\n').toLowerCase();
      if (!haystack.includes(request.search.toLowerCase())) return false;
    }
    return true;
  }

  private formatDate(date: any): any {
    if (!date) return null;
    const { dayOfMonth = null, month = null, year = null } = date;
    if (dayOfMonth === null && month === null && year === null) return null;
    return {
      day: dayOfMonth,
      month: month === null ? null : month + 1,
      monthName: month === null ? null : monthName(month),
      year,
    };
  }

  private choice(list: readonly string[], value: unknown, i18nPrefix: string, i18nKeys?: string[]) {
    const index = Number(value) || 0;
    const name = enumName(list, index);
    return { name, label: localize(`${i18nPrefix}.${i18nKeys?.[index] ?? index}`, name) };
  }

  private async formatEntry(
    pageType: DSA5JournalPageType,
    ref: PageRef,
    key: string,
    entry: any,
    detail: boolean
  ): Promise<any> {
    const base = { entryKey: key, pageUuid: ref.page.uuid };
    const text = (html: unknown) => htmlToText(html, detail ? undefined : SUMMARY_TEXT_LENGTH);

    switch (pageType) {
      case 'personae':
        return { ...base, ...(await this.formatPersona(entry, text, detail)) };
      case 'quests':
        return { ...base, ...(await this.formatQuest(entry, text, detail)) };
      case 'calendar': {
        const category = this.choice(
          CALENDAR_CATEGORIES,
          entry.category,
          'dsacalendar.CATEGORIES',
          CALENDAR_CATEGORY_I18N
        );
        return {
          ...base,
          title: entry.title ?? '',
          date: this.formatDate(entry.from),
          ...(entry.to?.dayOfMonth ? { endDay: entry.to.dayOfMonth } : {}),
          category: category.name,
          categoryLabel: category.label,
          location: entry.location ?? '',
          visible: !!entry.visible,
          recurring: !!entry.recurring,
          content: text(entry.content),
          ...(detail ? { contentHtml: entry.content ?? '' } : {}),
        };
      }
      case 'citydetails': {
        const quality = entry.qualityRowIndex ?? null;
        const price = entry.priceRowIndex ?? null;
        return {
          ...base,
          name: entry.name ?? '',
          kind: entry.kind ?? '',
          kindLabel: localize(`DSACITYDETAILS.KIND.${entry.kind}`, entry.kind ?? ''),
          typeText: entry.typeText ?? '',
          quality,
          ...(quality !== null
            ? { qualityLabel: localize(`DSACITYDETAILS.QUALITY.${quality}`, String(quality)) }
            : {}),
          price,
          ...(price !== null
            ? { priceLabel: localize(`DSACITYDETAILS.PRICE.${price}`, String(price)) }
            : {}),
          visible: entry.visible !== false,
          description: text(entry.description),
          gmNotes: text(entry.gmNotes),
          ...(detail
            ? {
                descriptionHtml: entry.description ?? '',
                gmNotesHtml: entry.gmNotes ?? '',
                img: entry.img ?? '',
              }
            : {}),
        };
      }
      default:
        // AP / money trackers: plain log rows written by the system.
        return {
          ...base,
          ...entry,
          ...(entry.created ? { createdAt: new Date(entry.created).toISOString() } : {}),
        };
    }
  }

  private async formatPersona(entry: any, text: (html: unknown) => string, detail: boolean) {
    const actor = entry.actor_uuid ? await resolveUuid(entry.actor_uuid) : null;
    const notesOnActor = !!entry.linkActorNotes && !!actor && !actor.pack && !actor.inCompendium;
    const notesHtml = notesOnActor ? actor.system?.details?.notes?.value : entry.notes;
    const descriptionHtml =
      entry.showActorDescription && actor
        ? (actor.system?.details?.biography?.value ?? actor.system?.description?.value)
        : entry.description;

    const result: any = {
      name: entry.name ?? '',
      kind: enumName(PERSONA_KINDS, entry.type),
      subtitle: entry.subtitle ?? '',
      faction: entry.faction ?? '',
      tags: tagList(entry.tags),
      visible: !!entry.visible,
      important: !!entry.important,
      description: text(descriptionHtml),
      notes: text(notesHtml),
    };

    if (entry.actor_uuid) {
      result.actor = actor
        ? {
            uuid: actor.uuid,
            name: actor.name,
            type: actor.type,
            ...(actor.system?.details?.species?.value
              ? { species: actor.system.details.species.value }
              : {}),
            ...(actor.system?.details?.culture?.value
              ? { culture: actor.system.details.culture.value }
              : {}),
            ...(actor.system?.details?.career?.value
              ? { career: actor.system.details.career.value }
              : {}),
            ...(actor.system?.creatureClass?.value
              ? { creatureClass: actor.system.creatureClass.value }
              : {}),
          }
        : { uuid: entry.actor_uuid, missing: true };
    }

    if (detail) {
      const contacts = [];
      for (const [slug, contact] of Object.entries<any>(entry.socialContact ?? {})) {
        const uuid = slug.replaceAll('_', '.');
        const hero = await resolveUuid(uuid);
        const level = contact?.level ?? 5;
        contacts.push({
          hero: hero?.name ?? uuid,
          heroUuid: uuid,
          level,
          label: localize(`PERSONAE.FIELDS.personae.socialContact.level.choices.${level}`, ''),
        });
      }
      Object.assign(result, {
        descriptionHtml: descriptionHtml ?? '',
        notesHtml: notesHtml ?? '',
        notesStoredOn: notesOnActor ? 'actor' : 'journal',
        img: entry.img ?? '',
        garadan: entry.garadan ?? 0,
        showGaradanGMOnly: entry.showGaradanGMOnly !== false,
        showSpecies: entry.showSpecies !== false,
        showCulture: entry.showCulture !== false,
        showProfession: entry.showProfession !== false,
        showActorDescription: !!entry.showActorDescription,
        linkActorNotes: !!entry.linkActorNotes,
        socialContacts: contacts,
        ...(actor?.system?.details?.notes?.gmdescription
          ? { actorGmNotes: htmlToText(actor.system.details.notes.gmdescription) }
          : {}),
      });
    }
    return result;
  }

  private async formatQuest(entry: any, text: (html: unknown) => string, detail: boolean) {
    const status = this.choice(QUEST_STATUS, entry.status, 'DSAQUESTLOG.STATUS');
    const priority = this.choice(QUEST_PRIORITY, entry.priority, 'DSAQUESTLOG.PRIORITY');
    const audience = this.choice(QUEST_AUDIENCE, entry.audience, 'DSAQUESTLOG.AUDIENCE');
    const users = gameAny().users;

    const result: any = {
      title: entry.title ?? '',
      summary: entry.summary ?? '',
      status: status.name,
      statusLabel: status.label,
      priority: priority.name,
      priorityLabel: priority.label,
      audience: audience.name,
      players: (entry.playerOwners ?? []).map((id: string) => users?.get?.(id)?.name ?? id),
      visible: entry.visible !== false,
      pinToTop: !!entry.pinToTop,
      chapter: entry.chapter ?? '',
      location: entry.location ?? '',
      tags: tagList(entry.tags),
      startDate: this.formatDate(entry.startDate),
      targetDate: this.formatDate(entry.targetDate),
      completionDate: this.formatDate(entry.completionDate),
      objectives: sortedEntries(entry.objectives).map(([key, objective]) => ({
        key,
        text: objective.text ?? '',
        status: enumName(OBJECTIVE_STATUS, objective.status),
        visible: objective.visible !== false,
      })),
      details: text(entry.details),
      gmNotes: text(entry.gmNotes),
      linkCount: Object.keys(entry.linkedPages ?? {}).length,
    };

    if (detail) {
      const links = [];
      for (const [key, link] of sortedEntries(entry.linkedPages)) {
        const document = link.uuid ? await resolveUuid(link.uuid) : null;
        links.push({
          key,
          uuid: link.uuid ?? '',
          name: document?.name ?? null,
          documentType: document?.documentName ?? String(link.uuid ?? '').split('.')[0],
          visible: link.visible !== false,
          ...(document ? {} : { missing: true }),
        });
      }
      Object.assign(result, {
        detailsHtml: entry.details ?? '',
        gmNotesHtml: entry.gmNotes ?? '',
        image: entry.image ?? null,
        links,
      });
    }
    return result;
  }

  // ───────────────────────────── writing ─────────────────────────────

  private async manageResult(
    request: DSA5JournalManageRequest,
    config: PageTypeConfig,
    ref: PageRef,
    key: string,
    warnings: string[],
    extra: Record<string, any> = {}
  ): Promise<any> {
    const stored = this.entriesOf(config, ref.page)[key];
    console.log(`[${MODULE_ID}] DSA5 ${request.pageType} entry ${key}: ${request.action}`);
    return {
      success: true,
      action: request.action,
      pageType: request.pageType,
      ...extra,
      page: this.describePage(config, ref),
      entryKey: key,
      ...(stored
        ? { entry: await this.formatEntry(request.pageType, ref, key, stored, true) }
        : {}),
      ...(warnings.length ? { warnings } : {}),
    };
  }

  private async updateEntry(
    config: PageTypeConfig,
    page: any,
    key: string,
    payload: Record<string, any>
  ): Promise<void> {
    if (Object.keys(payload).length === 0) return;
    // Nested (not dotted) update data: the system's _preUpdate hooks read
    // changed.system.<collection>.<key>.
    await page.update({ system: { [config.collection]: { [key]: payload } } });
  }

  private async writeEntry(
    pageType: DSA5JournalPageType,
    config: PageTypeConfig,
    page: any,
    key: string,
    existing: any,
    data: Record<string, any>,
    warnings: string[]
  ): Promise<void> {
    switch (pageType) {
      case 'personae':
        return this.writePersona(config, page, key, existing, data, warnings);
      case 'quests':
        return this.updateEntry(config, page, key, await this.buildQuest(existing, data));
      case 'calendar':
        return this.updateEntry(config, page, key, this.buildCalendarEvent(existing, data));
      case 'citydetails':
        return this.updateEntry(config, page, key, this.buildCityDetail(existing, data));
      default:
        throw new Error(`${pageType} pages are read-only`);
    }
  }

  private copyFields(
    data: Record<string, any>,
    payload: Record<string, any>,
    spec: { text?: string[]; html?: string[]; flags?: string[] }
  ): void {
    for (const field of spec.text ?? []) {
      if (data[field] !== undefined) payload[field] = String(data[field] ?? '');
    }
    for (const field of spec.html ?? []) {
      if (data[field] !== undefined) payload[field] = textToHtml(String(data[field] ?? ''));
    }
    for (const field of spec.flags ?? []) {
      if (data[field] !== undefined) payload[field] = !!data[field];
    }
  }

  private async writePersona(
    config: PageTypeConfig,
    page: any,
    key: string,
    existing: any,
    data: Record<string, any>,
    warnings: string[]
  ): Promise<void> {
    const payload: Record<string, any> = {};
    this.copyFields(data, payload, {
      text: ['name', 'subtitle', 'faction', 'img'],
      html: ['description'],
      flags: [
        'visible',
        'important',
        'showGaradanGMOnly',
        'showSpecies',
        'showCulture',
        'showProfession',
        'showActorDescription',
        'linkActorNotes',
      ],
    });
    if (data.kind !== undefined) payload.type = enumIndex(PERSONA_KINDS, data.kind, 'kind');
    if (data.tags !== undefined) payload.tags = tagList(data.tags).join(', ');
    if (data.garadan !== undefined) {
      if (!GARADAN_VALUES.includes(data.garadan)) {
        throw new Error(`garadan must be one of: ${GARADAN_VALUES.join(', ')}`);
      }
      payload.garadan = data.garadan;
    }

    // Actor link. When it changes, the system overwrites name, img, type, garadan,
    // faction, subtitle and linkActorNotes from the actor, so values the caller passed
    // explicitly for those are re-applied in a second update.
    let actor: any = null;
    let actorChanged = false;
    if (data.actor === null || data.actor === '') {
      payload.actor_uuid = null;
    } else if (data.actor !== undefined) {
      actor = await this.resolveActor(String(data.actor), 'actor');
      if (actor.type === 'group') throw new Error('actor: group actors cannot be linked');
      payload.actor_uuid = actor.uuid;
      actorChanged = actor.uuid !== existing?.actor_uuid;
    } else if (existing?.actor_uuid) {
      actor = await resolveUuid(existing.actor_uuid);
    }

    if (!existing && !actor && !data.name) throw new Error('name or actor is required');

    if (Array.isArray(data.socialContacts)) {
      const contacts: Record<string, any> = {};
      for (const contact of data.socialContacts) {
        const hero = await this.resolveActor(String(contact?.hero ?? ''), 'socialContacts.hero');
        const slug = String(hero.uuid).replaceAll('.', '_');
        if (contact.level === null) {
          if (existing?.socialContact?.[slug]) setDeletion(contacts, slug);
          continue;
        }
        if (!Number.isInteger(contact.level) || contact.level < 1 || contact.level > 9) {
          throw new Error('socialContacts.level must be an integer 1-9, or null to remove');
        }
        contacts[slug] = { level: contact.level };
      }
      if (Object.keys(contacts).length) payload.socialContact = contacts;
    }

    // Notes live on the actor when the entry links them (the system's default for a
    // linked world actor), otherwise on the journal entry.
    const actorLinkable = !!actor && !actor.pack && !actor.inCompendium;
    let actorNotes: string | undefined;
    if (data.notes !== undefined) {
      const linkNotes =
        data.linkActorNotes ?? (actorChanged ? actorLinkable : (existing?.linkActorNotes ?? true));
      const html = textToHtml(String(data.notes ?? ''));
      if (linkNotes && actorLinkable) actorNotes = html;
      else payload.notes = html;
    }

    await this.updateEntry(config, page, key, payload);

    if (actorChanged) {
      const overrides: Record<string, any> = {};
      for (const field of [
        'name',
        'type',
        'img',
        'faction',
        'subtitle',
        'garadan',
        'linkActorNotes',
      ]) {
        if (payload[field] !== undefined) overrides[field] = payload[field];
      }
      await this.updateEntry(config, page, key, overrides);
    }

    if (actorNotes !== undefined) {
      await actor.update({ 'system.details.notes.value': actorNotes });
      warnings.push(`Notes were saved on the linked actor "${actor.name}" (linkActorNotes).`);
    }
  }

  /** Quest date: only the parts that were passed are written, so the rest is kept. */
  private buildPartialDate(input: any, field: string): Record<string, number | null> {
    if (input === null) return { dayOfMonth: null, month: null, year: null };
    if (typeof input !== 'object')
      throw new Error(`${field} must be {day?, month?, year?} or null`);
    const date: Record<string, number | null> = {};
    if (input.day !== undefined) date.dayOfMonth = input.day;
    if (input.month !== undefined)
      date.month = input.month === null ? null : parseMonth(input.month);
    if (input.year !== undefined) date.year = input.year;
    return date;
  }

  private worldDate(): { dayOfMonth: number; month: number; year: number } | null {
    try {
      const time = gameAny().time;
      const components = time.calendar.timeToComponents(time.worldTime);
      return {
        dayOfMonth: components.dayOfMonth + 1,
        month: components.month,
        year: components.year,
      };
    } catch {
      return null;
    }
  }

  private async buildQuest(existing: any, data: Record<string, any>) {
    const payload: Record<string, any> = {};
    if (!existing && !data.title) throw new Error('title is required');

    this.copyFields(data, payload, {
      text: ['title', 'summary', 'chapter', 'location'],
      html: ['details', 'gmNotes'],
      flags: ['visible', 'pinToTop'],
    });
    if (data.status !== undefined) payload.status = enumIndex(QUEST_STATUS, data.status, 'status');
    if (data.priority !== undefined) {
      payload.priority = enumIndex(QUEST_PRIORITY, data.priority, 'priority');
    }
    if (data.audience !== undefined) {
      payload.audience = enumIndex(QUEST_AUDIENCE, data.audience, 'audience');
    }
    if (data.players !== undefined) payload.playerOwners = this.resolveUsers(data.players ?? []);
    if (data.tags !== undefined) payload.tags = tagList(data.tags).join(', ');
    if (data.image !== undefined) {
      payload.image = data.image || null;
      if (!data.image) payload.imageFrame = {};
    }

    for (const field of ['startDate', 'targetDate', 'completionDate']) {
      if (data[field] !== undefined) payload[field] = this.buildPartialDate(data[field], field);
    }
    if (!existing) {
      // Like the system's createEntryData: new quests start hidden, dated today.
      if (payload.visible === undefined) payload.visible = false;
      if (payload.startDate === undefined) {
        const today = this.worldDate();
        if (today) payload.startDate = today;
      }
    }

    const objectives = this.buildObjectives(existing, data.objectives);
    if (objectives) payload.objectives = objectives;
    const links = await this.buildLinks(existing, data.links);
    if (links) payload.linkedPages = links;
    return payload;
  }

  /** `objectives` is `{add, update, remove}`, or just a list of objectives to add. */
  private buildObjectives(existing: any, input: any): Record<string, any> | null {
    if (input === undefined || input === null) return null;
    const operations = Array.isArray(input) ? { add: input } : input;
    const current = existing?.objectives ?? {};
    const result: Record<string, any> = {};
    const sort = nextSort(current);

    for (const item of operations.add ?? []) {
      const objective = typeof item === 'string' ? { text: item } : item;
      if (!objective?.text) throw new Error('objectives.add: text is required');
      result[(foundry.utils as any).randomID()] = {
        text: String(objective.text),
        status: enumIndex(OBJECTIVE_STATUS, objective.status ?? 'open', 'objectives.status'),
        visible: objective.visible !== false,
        sort: sort.value,
      };
      sort.value += sort.density;
    }
    for (const item of operations.update ?? []) {
      if (!item?.key || !current[item.key]) {
        throw new Error(`objectives.update: no objective with key "${item?.key}"`);
      }
      const change: Record<string, any> = {};
      if (item.text !== undefined) change.text = String(item.text);
      if (item.status !== undefined) {
        change.status = enumIndex(OBJECTIVE_STATUS, item.status, 'objectives.status');
      }
      if (item.visible !== undefined) change.visible = !!item.visible;
      result[item.key] = change;
    }
    for (const key of operations.remove ?? []) {
      if (!current[key]) throw new Error(`objectives.remove: no objective with key "${key}"`);
      setDeletion(result, key);
    }
    return Object.keys(result).length ? result : null;
  }

  /** `links` is `{add, remove}`, or just a list of references to add. */
  private async buildLinks(existing: any, input: any): Promise<Record<string, any> | null> {
    if (input === undefined || input === null) return null;
    const operations = Array.isArray(input) ? { add: input } : input;
    const current: Record<string, any> = existing?.linkedPages ?? {};
    const result: Record<string, any> = {};
    const linked = new Set(Object.values(current).map((link: any) => link?.uuid));
    const sort = nextSort(current);

    for (const item of operations.add ?? []) {
      const link = typeof item === 'string' ? { ref: item } : item;
      if (!link?.ref) throw new Error('links.add: ref is required');
      const uuid = await this.resolveLinkUuid(String(link.ref));
      if (linked.has(uuid)) continue;
      linked.add(uuid);
      result[(foundry.utils as any).randomID()] = {
        uuid,
        visible: link.visible !== false,
        sort: sort.value,
      };
      sort.value += sort.density;
    }
    for (const reference of operations.remove ?? []) {
      const found = Object.entries(current).find(
        ([key, link]) => key === reference || link?.uuid === reference
      );
      if (!found) throw new Error(`links.remove: no link with key or uuid "${reference}"`);
      setDeletion(result, found[0]);
    }
    return Object.keys(result).length ? result : null;
  }

  private buildCalendarEvent(existing: any, data: Record<string, any>) {
    const payload: Record<string, any> = {};
    if (!existing && !data.title) throw new Error('title is required');

    this.copyFields(data, payload, {
      text: ['title', 'location'],
      html: ['content'],
      flags: ['visible', 'recurring'],
    });
    if (data.category !== undefined) {
      const category = data.category === 'event' ? 'anniversary' : data.category;
      payload.category = enumIndex(CALENDAR_CATEGORIES, category, 'category');
    }

    // The system derives the day of the year from a complete `from`, so always send
    // day, month and year together.
    if (!existing || data.date !== undefined || data.endDay !== undefined) {
      const base = existing?.from ?? this.worldDate() ?? { dayOfMonth: 1, month: 0, year: 1040 };
      const from = { dayOfMonth: base.dayOfMonth, month: base.month, year: base.year };
      const date = data.date ?? {};
      if (date.day !== undefined && date.day !== null) from.dayOfMonth = date.day;
      if (date.month !== undefined && date.month !== null) from.month = parseMonth(date.month);
      if (date.year !== undefined && date.year !== null) from.year = date.year;
      payload.from = from;
    }
    if (data.endDay !== undefined) payload.to = { dayOfMonth: data.endDay };
    if (!existing && payload.visible === undefined) payload.visible = false;
    return payload;
  }

  private buildCityDetail(existing: any, data: Record<string, any>) {
    const payload: Record<string, any> = {};
    if (!existing && !data.name) throw new Error('name is required');

    this.copyFields(data, payload, {
      text: ['name', 'typeText', 'img'],
      html: ['description', 'gmNotes'],
      flags: ['visible'],
    });
    if (data.kind !== undefined) {
      payload.kind = CITY_KINDS[enumIndex(CITY_KINDS, data.kind, 'kind')];
    }
    for (const [field, target] of [
      ['quality', 'qualityRowIndex'],
      ['price', 'priceRowIndex'],
    ] as const) {
      const value = data[field];
      if (value === undefined) continue;
      if (value !== null && (!Number.isInteger(value) || value < 0 || value > 5)) {
        throw new Error(`${field} must be an integer 0-5 or null`);
      }
      payload[target] = value;
    }
    return payload;
  }
}
