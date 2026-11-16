/**
 * DSA5 structured journal pages: Dramatis Personae, quest log, almanac events and city
 * details. The DSA5 system isn't available in tests, so its world is stubbed: pages hold
 * plain `system` data and `update()` merges changes the way Foundry does, including the
 * `-=key` deletion form.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DSA5JournalAccess, htmlToText, parseMonth, textToHtml } from './dsa5-journals.js';

function merge(target: Record<string, any>, change: Record<string, any>): void {
  for (const [key, value] of Object.entries(change)) {
    if (key.startsWith('-=')) {
      delete target[key.slice(2)];
    } else if (value && typeof value === 'object' && !Array.isArray(value)) {
      if (!target[key] || typeof target[key] !== 'object') target[key] = {};
      merge(target[key], value);
    } else {
      target[key] = value;
    }
  }
}

function makeJournal(
  id: string,
  name: string,
  pages: Array<{ id: string; name: string; type: string; system: any }>
) {
  const journal: any = { id, name, uuid: `JournalEntry.${id}`, pages: { contents: [] as any[] } };
  journal.createEmbeddedDocuments = vi.fn(async (_type: string, data: any[]) =>
    data.map((pageData, index) => addPage(journal, { id: `new${index}`, system: {}, ...pageData }))
  );
  for (const page of pages) addPage(journal, page);
  return journal;
}

function addPage(journal: any, data: { id: string; name: string; type: string; system: any }) {
  const page: any = {
    ...data,
    uuid: `${journal.uuid}.JournalEntryPage.${data.id}`,
    update: vi.fn(async (change: any) => merge(page.system, change.system ?? {})),
  };
  journal.pages.contents.push(page);
  return page;
}

function makeActor(id: string, name: string, extra: Record<string, any> = {}) {
  const actor: any = {
    id,
    name,
    uuid: `Actor.${id}`,
    documentName: 'Actor',
    type: 'npc',
    system: { details: { career: { value: 'Krieger' }, notes: { value: '' } } },
    update: vi.fn(async () => undefined),
    ...extra,
  };
  return actor;
}

interface World {
  journals: any[];
  actors: any[];
  dsa5Settings: Record<string, any>;
  settingsSet: ReturnType<typeof vi.fn>;
  createJournal: ReturnType<typeof vi.fn>;
  refreshParts: ReturnType<typeof vi.fn>;
}

function stubWorld(options: {
  systemId?: string;
  journals?: any[];
  actors?: any[];
  allowWrites?: boolean;
  dsa5Settings?: Record<string, any>;
}): World {
  const journals = options.journals ?? [];
  const actors = options.actors ?? [];
  const dsa5Settings = options.dsa5Settings ?? {};
  const refreshParts = vi.fn(async () => undefined);
  const settingsSet = vi.fn(async (_module: string, key: string, value: any) => {
    dsa5Settings[key] = value;
  });
  const createJournal = vi.fn(async (data: any) => {
    const journal = makeJournal(`j${journals.length + 1}`, data.name, []);
    data.pages.forEach((page: any, index: number) =>
      addPage(journal, { id: `p${index}`, system: {}, ...page })
    );
    journals.push(journal);
    return journal;
  });

  let nextId = 0;
  vi.stubGlobal('game', {
    ready: true,
    world: { id: 'world-1' },
    user: { id: 'gm', name: 'GM', isGM: true },
    system: { id: options.systemId ?? 'dsa5' },
    i18n: { localize: (key: string) => key },
    settings: {
      get: (module: string, key: string) =>
        module === 'dsa5' ? dsa5Settings[key] : (options.allowWrites ?? true),
      set: settingsSet,
    },
    journal: { contents: journals },
    actors: { contents: actors },
    items: { contents: [] },
    users: {
      contents: [{ id: 'u1', name: 'Alrik' }],
      get: (id: string) => (id === 'u1' ? { id: 'u1', name: 'Alrik' } : undefined),
    },
    time: {
      worldTime: 0,
      calendar: {
        timeToComponents: () => ({ dayOfMonth: 4, month: 2, year: 1040 }),
        months: { values: [] },
      },
    },
    dsa5: { apps: { CalendarPicker: { refreshParts } } },
  });
  vi.stubGlobal('foundry', { utils: { randomID: () => `id${++nextId}` } });
  vi.stubGlobal('CONST', { SORT_INTEGER_DENSITY: 100000 });
  vi.stubGlobal('JournalEntry', { create: createJournal });
  vi.stubGlobal('fromUuid', async (uuid: string) => {
    const documents = [
      ...actors,
      ...journals,
      ...journals.flatMap(journal => journal.pages.contents),
    ];
    return documents.find(document => document.uuid === uuid) ?? null;
  });

  return { journals, actors, dsa5Settings, settingsSet, createJournal, refreshParts };
}

const access = () => new DSA5JournalAccess();

describe('DSA5 journal pages', () => {
  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('refuses to run outside a DSA5 world', async () => {
    stubWorld({ systemId: 'dnd5e' });

    const read = await access().read({ pageType: 'personae' });
    const manage = await access().manage({
      pageType: 'quests',
      action: 'create',
      data: { title: 'A quest' },
    });

    expect(read).toMatchObject({ success: false, error: expect.stringContaining('dnd5e') });
    expect(manage.success).toBe(false);
  });

  describe('reading', () => {
    it('gives an overview of every structured page and whether the almanac shows it', async () => {
      const journal = makeJournal('j1', 'Havena', [
        { id: 'p1', name: 'People', type: 'dsapersonaedramatis', system: { personae: { a: {} } } },
        { id: 'p2', name: 'Places', type: 'citydetails', system: { details: {} } },
        { id: 'p3', name: 'Notes', type: 'text', system: {} },
      ]);
      stubWorld({
        journals: [journal],
        dsa5Settings: {
          calendarActors: { activated: [{ uuid: 'JournalEntry.j1', name: 'Havena' }] },
        },
      });

      const result = await access().read();

      expect(result.pages).toEqual([
        expect.objectContaining({
          pageType: 'personae',
          pageName: 'People',
          entryCount: 1,
          shownInAlmanac: true,
        }),
        expect.objectContaining({ pageType: 'citydetails', pageName: 'Places', entryCount: 0 }),
      ]);
      // City details aren't part of the almanac, so the flag is left out.
      expect(result.pages[1]).not.toHaveProperty('shownInAlmanac');
    });

    it('lists personae with their linked actor and filters them', async () => {
      const actor = makeActor('a1', 'Rondrian');
      const journal = makeJournal('j1', 'Havena', [
        {
          id: 'p1',
          name: 'People',
          type: 'dsapersonaedramatis',
          system: {
            personae: {
              k1: {
                name: 'Rondrian',
                type: 0,
                actor_uuid: 'Actor.a1',
                faction: 'Stadtwache, Rondrakirche',
                tags: 'ally, guard',
                visible: true,
                description: '<p>A <b>stern</b> captain.</p>',
              },
              k2: { name: 'Sewer rat', type: 1, faction: 'Vermin', tags: '', visible: false },
            },
          },
        },
      ]);
      stubWorld({ journals: [journal], actors: [actor] });

      const all = await access().read({ pageType: 'personae' });
      const guards = await access().read({ pageType: 'personae', faction: 'stadtwache' });
      const hidden = await access().read({ pageType: 'personae', visible: false });
      const found = await access().read({ pageType: 'personae', search: 'STERN' });

      expect(all.totalMatches).toBe(2);
      expect(all.entries[0]).toMatchObject({
        entryKey: 'k1',
        name: 'Rondrian',
        kind: 'person',
        tags: ['ally', 'guard'],
        description: 'A stern captain.',
        actor: { uuid: 'Actor.a1', name: 'Rondrian', career: 'Krieger' },
      });
      expect(guards.entries.map((entry: any) => entry.entryKey)).toEqual(['k1']);
      expect(hidden.entries.map((entry: any) => entry.name)).toEqual(['Sewer rat']);
      expect(found.entries.map((entry: any) => entry.entryKey)).toEqual(['k1']);
    });

    it('returns one persona in full, with notes read from the linked actor', async () => {
      const actor = makeActor('a1', 'Rondrian');
      actor.system.details.notes.value = '<p>Owes the party a favour.</p>';
      const hero = makeActor('h1', 'Alrike', { type: 'character' });
      const journal = makeJournal('j1', 'Havena', [
        {
          id: 'p1',
          name: 'People',
          type: 'dsapersonaedramatis',
          system: {
            personae: {
              k1: {
                name: 'Rondrian',
                type: 0,
                actor_uuid: 'Actor.a1',
                linkActorNotes: true,
                notes: '<p>stale journal copy</p>',
                socialContact: { Actor_h1: { level: 7 } },
              },
            },
          },
        },
      ]);
      stubWorld({ journals: [journal], actors: [actor, hero] });

      const result = await access().read({ pageType: 'personae', entryKey: 'k1' });

      expect(result.entry).toMatchObject({
        notes: 'Owes the party a favour.',
        notesStoredOn: 'actor',
        socialContacts: [{ hero: 'Alrike', heroUuid: 'Actor.h1', level: 7 }],
      });
    });

    it('lists quests with readable status, 1-based months and ordered objectives', async () => {
      const journal = makeJournal('j1', 'Quests', [
        {
          id: 'p1',
          name: 'Log',
          type: 'dsaquestlog',
          system: {
            quests: {
              q1: {
                title: 'Find the amulet',
                status: 0,
                priority: 1,
                audience: 1,
                playerOwners: ['u1'],
                startDate: { dayOfMonth: 3, month: 0, year: 1040 },
                targetDate: { dayOfMonth: null, month: null, year: null },
                objectives: {
                  b: { text: 'second', status: 1, sort: 200 },
                  a: { text: 'first', status: 0, sort: 100 },
                },
              },
              q2: { title: 'Done deal', status: 1 },
            },
          },
        },
      ]);
      stubWorld({ journals: [journal] });

      const open = await access().read({ pageType: 'quests', status: 'open' });

      expect(open.entries).toHaveLength(1);
      expect(open.entries[0]).toMatchObject({
        title: 'Find the amulet',
        status: 'open',
        priority: 'side',
        audience: 'players',
        players: ['Alrik'],
        startDate: { day: 3, month: 1, monthName: 'Praios', year: 1040 },
        targetDate: null,
        objectives: [
          { key: 'a', text: 'first', status: 'open' },
          { key: 'b', text: 'second', status: 'done' },
        ],
      });
    });
  });

  describe('personae', () => {
    it('creates the journal, registers it in the almanac and links the actor', async () => {
      const actor = makeActor('a1', 'Rondrian');
      const world = stubWorld({ actors: [actor] });

      const result = await access().manage({
        pageType: 'personae',
        action: 'create',
        data: { actor: 'rondrian', visible: true },
      });

      expect(result).toMatchObject({ success: true, createdJournal: true, entryKey: 'id1' });
      // The stubbed i18n has no translation, so the built-in fallback name is used.
      expect(world.createJournal).toHaveBeenCalledWith({
        name: 'Dramatis Personae',
        pages: [{ name: 'Dramatis Personae', type: 'dsapersonaedramatis' }],
      });
      const page = world.journals[0].pages.contents[0];
      expect(page.update).toHaveBeenCalledTimes(1);
      expect(page.update).toHaveBeenCalledWith({
        system: { personae: { id1: { visible: true, actor_uuid: 'Actor.a1' } } },
      });
      expect(world.dsa5Settings.calendarActors.activated).toEqual([
        { uuid: 'JournalEntry.j1', name: 'Dramatis Personae' },
      ]);
      expect(world.refreshParts).toHaveBeenCalledWith(['personae', 'config']);
    });

    it('re-applies explicit fields after the system fills a newly linked persona', async () => {
      const actor = makeActor('a1', 'Rondrian');
      const journal = makeJournal('j1', 'Havena', [
        { id: 'p1', name: 'People', type: 'dsapersonaedramatis', system: { personae: {} } },
      ]);
      stubWorld({ journals: [journal], actors: [actor] });
      const page = journal.pages.contents[0];

      await access().manage({
        pageType: 'personae',
        action: 'create',
        data: { actor: 'Actor.a1', faction: 'Stadtwache', tags: ['ally', 'guard'] },
      });

      expect(page.update).toHaveBeenCalledTimes(2);
      expect(page.update).toHaveBeenNthCalledWith(2, {
        system: { personae: { id1: { faction: 'Stadtwache' } } },
      });
      expect(page.system.personae.id1.tags).toBe('ally, guard');
    });

    it('saves notes on the linked actor, and on the journal when there is none', async () => {
      const actor = makeActor('a1', 'Rondrian');
      const journal = makeJournal('j1', 'Havena', [
        {
          id: 'p1',
          name: 'People',
          type: 'dsapersonaedramatis',
          system: {
            personae: {
              linked: { name: 'Rondrian', actor_uuid: 'Actor.a1', linkActorNotes: true },
              loose: { name: 'Stranger', linkActorNotes: true },
            },
          },
        },
      ]);
      stubWorld({ journals: [journal], actors: [actor] });
      const page = journal.pages.contents[0];

      const linked = await access().manage({
        pageType: 'personae',
        action: 'update',
        entryKey: 'linked',
        data: { notes: 'Trusts the party.' },
      });
      await access().manage({
        pageType: 'personae',
        action: 'update',
        entryKey: 'loose',
        data: { notes: 'Seen at the docks.\n\nTwice.' },
      });

      expect(actor.update).toHaveBeenCalledWith({
        'system.details.notes.value': '<p>Trusts the party.</p>',
      });
      expect(linked.warnings[0]).toContain('Rondrian');
      expect(page.system.personae.linked.notes).toBeUndefined();
      expect(page.system.personae.loose.notes).toBe('<p>Seen at the docks.</p><p>Twice.</p>');
    });

    it('sets and removes social contacts by hero', async () => {
      const hero = makeActor('h1', 'Alrike', { type: 'character' });
      const journal = makeJournal('j1', 'Havena', [
        {
          id: 'p1',
          name: 'People',
          type: 'dsapersonaedramatis',
          system: {
            personae: { k1: { name: 'Rondrian', socialContact: { Actor_h1: { level: 5 } } } },
          },
        },
      ]);
      stubWorld({ journals: [journal], actors: [hero] });
      const page = journal.pages.contents[0];

      await access().manage({
        pageType: 'personae',
        action: 'update',
        entryKey: 'k1',
        data: { socialContacts: [{ hero: 'Alrike', level: 8 }] },
      });
      expect(page.system.personae.k1.socialContact).toEqual({ Actor_h1: { level: 8 } });

      await access().manage({
        pageType: 'personae',
        action: 'update',
        entryKey: 'k1',
        data: { socialContacts: [{ hero: 'Alrike', level: null }] },
      });
      expect(page.system.personae.k1.socialContact).toEqual({});
    });

    it('asks for a page when several could take the new entry', async () => {
      const journal = makeJournal('j1', 'Havena', [
        { id: 'p1', name: 'Friends', type: 'dsapersonaedramatis', system: { personae: {} } },
        { id: 'p2', name: 'Foes', type: 'dsapersonaedramatis', system: { personae: {} } },
      ]);
      stubWorld({ journals: [journal] });

      const ambiguous = await access().manage({
        pageType: 'personae',
        action: 'create',
        data: { name: 'Stranger' },
      });
      const picked = await access().manage({
        pageType: 'personae',
        action: 'create',
        page: 'Foes',
        data: { name: 'Stranger' },
      });

      expect(ambiguous.success).toBe(false);
      expect(ambiguous.error).toContain('Friends');
      expect(picked.page.pageName).toBe('Foes');
    });

    it('does not create a journal when the entry turns out to be invalid', async () => {
      const world = stubWorld({});

      const result = await access().manage({
        pageType: 'personae',
        action: 'create',
        data: { actor: 'Nobody' },
      });

      expect(result.success).toBe(false);
      expect(world.createJournal).not.toHaveBeenCalled();
      expect(world.settingsSet).not.toHaveBeenCalled();
    });

    it('reports an unknown or ambiguous actor instead of guessing', async () => {
      const journal = makeJournal('j1', 'Havena', [
        { id: 'p1', name: 'People', type: 'dsapersonaedramatis', system: { personae: {} } },
      ]);
      stubWorld({
        journals: [journal],
        actors: [makeActor('a1', 'Guard'), makeActor('a2', 'Guard')],
      });

      const missing = await access().manage({
        pageType: 'personae',
        action: 'create',
        data: { actor: 'Nobody' },
      });
      const ambiguous = await access().manage({
        pageType: 'personae',
        action: 'create',
        data: { actor: 'Guard' },
      });

      expect(missing.error).toContain('not found');
      expect(ambiguous.error).toContain('Actor.a2');
      expect(journal.pages.contents[0].update).not.toHaveBeenCalled();
    });
  });

  describe('quests', () => {
    it('creates a hidden quest dated today, with objectives and resolved links', async () => {
      const actor = makeActor('a1', 'Rondrian');
      const journal = makeJournal('j1', 'Quests', [
        { id: 'p1', name: 'Log', type: 'dsaquestlog', system: { quests: {} } },
      ]);
      const world = stubWorld({ journals: [journal], actors: [actor] });

      const result = await access().manage({
        pageType: 'quests',
        action: 'create',
        data: {
          title: 'Find the amulet',
          priority: 'side',
          audience: 'players',
          players: ['alrik'],
          details: 'Somewhere in the sewers.',
          objectives: ['Ask around', { text: 'Enter the sewers', status: 'done' }],
          links: ['Rondrian'],
        },
      });

      expect(result.success).toBe(true);
      const quest = journal.pages.contents[0].system.quests[result.entryKey];
      expect(quest).toMatchObject({
        title: 'Find the amulet',
        priority: 1,
        audience: 1,
        playerOwners: ['u1'],
        visible: false,
        details: '<p>Somewhere in the sewers.</p>',
        startDate: { dayOfMonth: 5, month: 2, year: 1040 },
      });
      expect(Object.values(quest.objectives)).toEqual([
        { text: 'Ask around', status: 0, visible: true, sort: 0 },
        { text: 'Enter the sewers', status: 1, visible: true, sort: 100000 },
      ]);
      expect(Object.values(quest.linkedPages)).toEqual([
        { uuid: 'Actor.a1', visible: true, sort: 0 },
      ]);
      expect(world.dsa5Settings.questlogJournals.activated).toEqual([
        { uuid: 'JournalEntry.j1', name: 'Quests' },
      ]);
    });

    it('updates only the date parts, objectives and links it is given', async () => {
      const journal = makeJournal('j1', 'Quests', [
        {
          id: 'p1',
          name: 'Log',
          type: 'dsaquestlog',
          system: {
            quests: {
              q1: {
                title: 'Find the amulet',
                status: 0,
                targetDate: { dayOfMonth: 12, month: 3, year: null },
                objectives: {
                  o1: { text: 'Ask around', status: 0, sort: 0 },
                  o2: { text: 'Old lead', status: 0, sort: 100000 },
                },
                linkedPages: { l1: { uuid: 'Actor.gone', visible: true, sort: 0 } },
              },
            },
          },
        },
      ]);
      stubWorld({
        journals: [journal],
        dsa5Settings: { questlogJournals: { activated: [{ uuid: 'JournalEntry.j1' }] } },
      });
      const page = journal.pages.contents[0];

      const result = await access().manage({
        pageType: 'quests',
        action: 'update',
        entryKey: 'q1',
        data: {
          status: 'ended',
          targetDate: { year: 1041 },
          completionDate: { day: 1, month: 'Rondra' },
          objectives: {
            update: [{ key: 'o1', status: 'done' }],
            remove: ['o2'],
            add: ['Report back'],
          },
          links: { remove: ['Actor.gone'] },
        },
      });

      expect(result.success).toBe(true);
      expect(page.update).toHaveBeenCalledWith({
        system: {
          quests: {
            q1: {
              status: 1,
              targetDate: { year: 1041 },
              completionDate: { dayOfMonth: 1, month: 1 },
              objectives: {
                id1: { text: 'Report back', status: 0, visible: true, sort: 200000 },
                o1: { status: 1 },
                '-=o2': null,
              },
              linkedPages: { '-=l1': null },
            },
          },
        },
      });
      expect(page.system.quests.q1.targetDate).toEqual({ dayOfMonth: 12, month: 3, year: 1041 });
    });

    it('rejects an objective key the quest does not have', async () => {
      const journal = makeJournal('j1', 'Quests', [
        { id: 'p1', name: 'Log', type: 'dsaquestlog', system: { quests: { q1: { title: 'Q' } } } },
      ]);
      stubWorld({ journals: [journal] });

      const result = await access().manage({
        pageType: 'quests',
        action: 'update',
        entryKey: 'q1',
        data: { objectives: { update: [{ key: 'nope', status: 'done' }] } },
      });

      expect(result).toMatchObject({ success: false, error: expect.stringContaining('nope') });
      expect(journal.pages.contents[0].update).not.toHaveBeenCalled();
    });
  });

  describe('almanac events', () => {
    it('creates an event from a month name and maps the category', async () => {
      const journal = makeJournal('j1', 'Calendar', [
        { id: 'p1', name: 'Events', type: 'dsacalendar', system: { calendarentries: {} } },
      ]);
      stubWorld({ journals: [journal] });

      await access().manage({
        pageType: 'calendar',
        action: 'create',
        data: {
          title: 'Tournament',
          date: { day: 14, month: 'rondra', year: 1041 },
          category: 'holiday',
        },
      });

      expect(journal.pages.contents[0].system.calendarentries.id1).toEqual({
        title: 'Tournament',
        category: 1,
        from: { dayOfMonth: 14, month: 1, year: 1041 },
        visible: false,
      });
    });

    it('always sends a complete start date so the system can recompute the day', async () => {
      const journal = makeJournal('j1', 'Calendar', [
        {
          id: 'p1',
          name: 'Events',
          type: 'dsacalendar',
          system: {
            calendarentries: {
              e1: { title: 'Fair', from: { dayOfMonth: 3, month: 5, year: 1040, day: 153 } },
            },
          },
        },
      ]);
      stubWorld({ journals: [journal] });
      const page = journal.pages.contents[0];

      await access().manage({
        pageType: 'calendar',
        action: 'update',
        entryKey: 'e1',
        data: { date: { month: 13 }, endDay: 5 },
      });

      expect(page.update).toHaveBeenCalledWith({
        system: {
          calendarentries: {
            e1: { from: { dayOfMonth: 3, month: 12, year: 1040 }, to: { dayOfMonth: 5 } },
          },
        },
      });
    });
  });

  describe('city details', () => {
    it('maps quality and price onto the system fields', async () => {
      const journal = makeJournal('j1', 'Havena', [
        { id: 'p1', name: 'Places', type: 'citydetails', system: { details: {} } },
      ]);
      const world = stubWorld({ journals: [journal] });

      const result = await access().manage({
        pageType: 'citydetails',
        action: 'create',
        data: { name: 'The Golden Anchor', kind: 'inns', quality: 4, price: 3 },
      });

      expect(journal.pages.contents[0].system.details.id1).toEqual({
        name: 'The Golden Anchor',
        kind: 'inns',
        qualityRowIndex: 4,
        priceRowIndex: 3,
      });
      expect(result.entry).toMatchObject({ name: 'The Golden Anchor', quality: 4, price: 3 });
      // City details have no almanac registration.
      expect(world.settingsSet).not.toHaveBeenCalled();
    });

    it('rejects an unknown kind', async () => {
      const journal = makeJournal('j1', 'Havena', [
        { id: 'p1', name: 'Places', type: 'citydetails', system: { details: {} } },
      ]);
      stubWorld({ journals: [journal] });

      const result = await access().manage({
        pageType: 'citydetails',
        action: 'create',
        data: { name: 'Castle', kind: 'castles' },
      });

      expect(result).toMatchObject({ success: false, error: expect.stringContaining('kind') });
    });
  });

  describe('deleting and permissions', () => {
    const questJournal = () =>
      makeJournal('j1', 'Quests', [
        {
          id: 'p1',
          name: 'Log',
          type: 'dsaquestlog',
          system: { quests: { q1: { title: 'Find the amulet' }, q2: { title: 'Other' } } },
        },
      ]);

    it('deletes one entry and leaves the others', async () => {
      const journal = questJournal();
      stubWorld({ journals: [journal] });

      const result = await access().manage({
        pageType: 'quests',
        action: 'delete',
        entryKey: 'q1',
      });

      expect(result).toMatchObject({
        success: true,
        deleted: { entryKey: 'q1', name: 'Find the amulet' },
      });
      expect(Object.keys(journal.pages.contents[0].system.quests)).toEqual(['q2']);
    });

    it("uses Foundry v14's deletion operator when it exists", async () => {
      const journal = questJournal();
      stubWorld({ journals: [journal] });
      const del = Symbol('_del');
      vi.stubGlobal('_del', del);

      await access().manage({ pageType: 'quests', action: 'delete', entryKey: 'q1' });

      expect(journal.pages.contents[0].update).toHaveBeenCalledWith({
        system: { quests: { q1: del } },
      });
    });

    it('reports a missing entry key', async () => {
      stubWorld({ journals: [questJournal()] });

      const result = await access().manage({
        pageType: 'quests',
        action: 'update',
        entryKey: 'missing',
        data: { status: 'ended' },
      });

      expect(result).toMatchObject({ success: false, error: expect.stringContaining('missing') });
    });

    it('writes nothing when write operations are disabled', async () => {
      const journal = questJournal();
      stubWorld({ journals: [journal], allowWrites: false });

      const result = await access().manage({
        pageType: 'quests',
        action: 'update',
        entryKey: 'q1',
        data: { status: 'ended' },
      });

      expect(result).toMatchObject({ success: false, error: expect.stringContaining('denied') });
      expect(journal.pages.contents[0].update).not.toHaveBeenCalled();
    });

    it('keeps the system-maintained trackers read-only', async () => {
      stubWorld({});

      const result = await access().manage({
        pageType: 'aptracker',
        action: 'create',
        data: { itemName: 'x' },
      });

      expect(result).toMatchObject({ success: false, error: expect.stringContaining('read-only') });
    });
  });

  describe('helpers', () => {
    it('wraps plain text in paragraphs and leaves HTML alone', () => {
      expect(textToHtml('One\nline <3\n\nTwo')).toBe('<p>One<br>line &lt;3</p><p>Two</p>');
      expect(textToHtml('<p>Already <em>HTML</em></p>')).toBe('<p>Already <em>HTML</em></p>');
    });

    it('reduces HTML to text and shortens it', () => {
      expect(htmlToText('<p>Tom &amp; Jerry</p><p>Next&nbsp;line</p>')).toBe(
        'Tom & Jerry\nNext line'
      );
      expect(htmlToText('<p>abcdefghij</p>', 5)).toBe('abcde…');
    });

    it('reads months as 1-based numbers or names', () => {
      stubWorld({});
      expect(parseMonth(1)).toBe(0);
      expect(parseMonth('Rahja')).toBe(11);
      expect(parseMonth('Namenlose Tage')).toBe(12);
      expect(parseMonth('7')).toBe(6);
      expect(() => parseMonth(0)).toThrow();
      expect(() => parseMonth('Smarch')).toThrow();
    });
  });
});
