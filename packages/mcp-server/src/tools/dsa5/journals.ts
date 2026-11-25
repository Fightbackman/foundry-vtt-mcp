import { z } from 'zod';
import { FoundryClient } from '../../foundry-client.js';
import { Logger } from '../../logger.js';

export interface DSA5JournalToolsOptions {
  foundryClient: FoundryClient;
  logger: Logger;
}

const READ_PAGE_TYPES = [
  'personae',
  'quests',
  'calendar',
  'citydetails',
  'aptracker',
  'moneytracker',
  'locations',
] as const;
const WRITE_PAGE_TYPES = ['personae', 'quests', 'calendar', 'citydetails', 'locations'] as const;
const LOCATION_KINDS = [
  'settlement',
  'landmark',
  'dungeon',
  'region',
  'building',
  'other',
] as const;

const readSchema = z
  .object({
    pageType: z.enum(READ_PAGE_TYPES).optional(),
    page: z.string().min(1).optional(),
    journal: z.string().min(1).optional(),
    entryKey: z.string().min(1).optional(),
    search: z.string().min(1).optional(),
    faction: z.string().min(1).optional(),
    tag: z.string().min(1).optional(),
    status: z.enum(['open', 'ended', 'failed']).optional(),
    kind: z.string().min(1).optional(),
    visible: z.boolean().optional(),
    limit: z.number().int().min(1).max(200).optional(),
  })
  .strict();

const tags = z.union([z.array(z.string()), z.string()]);
const month = z.union([z.number().int().min(1).max(13), z.string().min(1)]);

const personaeData = z
  .object({
    name: z.string().min(1),
    kind: z.enum(['person', 'creature']),
    actor: z.string().nullable(),
    subtitle: z.string(),
    faction: z.string(),
    tags,
    description: z.string(),
    notes: z.string(),
    img: z.string(),
    visible: z.boolean(),
    important: z.boolean(),
    garadan: z.number().int().min(0).max(6),
    showGaradanGMOnly: z.boolean(),
    showSpecies: z.boolean(),
    showCulture: z.boolean(),
    showProfession: z.boolean(),
    showActorDescription: z.boolean(),
    linkActorNotes: z.boolean(),
    socialContacts: z.array(
      z
        .object({
          hero: z.string().min(1),
          level: z.number().int().min(1).max(9).nullable(),
        })
        .strict()
    ),
  })
  .partial()
  .strict();

const partialDate = z
  .object({
    day: z.number().int().min(1).nullable(),
    month: month.nullable(),
    year: z.number().int().nullable(),
  })
  .partial()
  .strict()
  .nullable();

const objectiveStatus = z.enum(['open', 'done', 'failed']);
const newObjective = z.union([
  z.string().min(1),
  z
    .object({
      text: z.string().min(1),
      status: objectiveStatus.optional(),
      visible: z.boolean().optional(),
    })
    .strict(),
]);
const newLink = z.union([
  z.string().min(1),
  z.object({ ref: z.string().min(1), visible: z.boolean().optional() }).strict(),
]);

const questData = z
  .object({
    title: z.string().min(1),
    summary: z.string(),
    details: z.string(),
    gmNotes: z.string(),
    status: z.enum(['open', 'ended', 'failed']),
    priority: z.enum(['main', 'side', 'personal']),
    audience: z.enum(['party', 'players', 'gm']),
    players: z.array(z.string().min(1)),
    visible: z.boolean(),
    pinToTop: z.boolean(),
    chapter: z.string(),
    location: z.string(),
    tags,
    image: z.string().nullable(),
    startDate: partialDate,
    targetDate: partialDate,
    completionDate: partialDate,
    objectives: z.union([
      z.array(newObjective),
      z
        .object({
          add: z.array(newObjective),
          update: z.array(
            z
              .object({
                key: z.string().min(1),
                text: z.string().min(1).optional(),
                status: objectiveStatus.optional(),
                visible: z.boolean().optional(),
              })
              .strict()
          ),
          remove: z.array(z.string().min(1)),
        })
        .partial()
        .strict(),
    ]),
    links: z.union([
      z.array(newLink),
      z
        .object({ add: z.array(newLink), remove: z.array(z.string().min(1)) })
        .partial()
        .strict(),
    ]),
  })
  .partial()
  .strict();

const calendarData = z
  .object({
    title: z.string().min(1),
    content: z.string(),
    location: z.string(),
    date: z
      .object({ day: z.number().int().min(1), month, year: z.number().int() })
      .partial()
      .strict(),
    endDay: z.number().int().min(1).nullable(),
    category: z.enum(['general', 'holiday', 'anniversary', 'historical', 'milestone']),
    visible: z.boolean(),
    recurring: z.boolean(),
  })
  .partial()
  .strict();

const rating = z.number().int().min(0).max(5).nullable();
const cityDetailData = z
  .object({
    name: z.string().min(1),
    kind: z.enum([
      'temples',
      'inns',
      'taverns',
      'crafts',
      'merchants',
      'services',
      'healers',
      'travellers',
    ]),
    typeText: z.string(),
    description: z.string(),
    gmNotes: z.string(),
    img: z.string(),
    visible: z.boolean(),
    quality: rating,
    price: rating,
  })
  .partial()
  .strict();

const locationData = z
  .object({
    name: z.string().min(1),
    subtitle: z.string(),
    kind: z.enum(LOCATION_KINDS),
    region: tags,
    description: z.string(),
    notes: z.string(),
    img: z.string(),
    image: z.string().nullable(),
    tags,
    visible: z.boolean(),
    important: z.boolean(),
    players: z.array(z.string().min(1)),
    parent: z.string().nullable(),
    source: z.string().nullable(),
  })
  .partial()
  .strict();

const dataSchemas = {
  personae: personaeData,
  quests: questData,
  calendar: calendarData,
  citydetails: cityDetailData,
  locations: locationData,
} as const;

/** Field a new entry needs; some types can take their name from a linked document instead. */
const requiredOnCreate: Record<(typeof WRITE_PAGE_TYPES)[number], string> = {
  personae: 'name',
  quests: 'title',
  calendar: 'title',
  citydetails: 'name',
  locations: 'name',
};
/** Field that can stand in for the required one on create. */
const alternativeOnCreate: Partial<Record<(typeof WRITE_PAGE_TYPES)[number], string>> = {
  personae: 'actor',
  locations: 'source',
};

const manageSchema = z
  .object({
    pageType: z.enum(WRITE_PAGE_TYPES),
    action: z.enum(['create', 'update', 'delete']),
    entryKey: z.string().min(1).optional(),
    page: z.string().min(1).optional(),
    journal: z.string().min(1).optional(),
    pageName: z.string().min(1).optional(),
    data: z.record(z.unknown()).optional(),
  })
  .strict()
  .superRefine((input, ctx) => {
    const issue = (path: (string | number)[], message: string) =>
      ctx.addIssue({ code: z.ZodIssueCode.custom, path, message });

    if (input.action === 'create' && input.entryKey) {
      issue(['entryKey'], 'entryKey is not supported for create');
    }
    if (input.action !== 'create' && !input.entryKey) {
      issue(['entryKey'], `entryKey is required for ${input.action}`);
    }
    if (input.action === 'delete') {
      if (input.data) issue(['data'], 'data is not supported for delete');
      return;
    }
    if (!input.data || Object.keys(input.data).length === 0) {
      issue(['data'], `data is required for ${input.action} and must contain at least one field`);
      return;
    }

    const parsed = dataSchemas[input.pageType].safeParse(input.data);
    if (!parsed.success) {
      for (const dataIssue of parsed.error.issues) {
        issue(['data', ...dataIssue.path], dataIssue.message);
      }
      return;
    }

    if (input.action === 'create') {
      const required = requiredOnCreate[input.pageType];
      const alternative = alternativeOnCreate[input.pageType];
      if (!input.data[required] && !(alternative && input.data[alternative])) {
        issue(
          ['data', required],
          alternative
            ? `data.${required} or data.${alternative} is required for create`
            : `data.${required} is required for create`
        );
      }
    }
  });

const describeIssues = (error: z.ZodError) =>
  error.issues.map(issue => `${issue.path.join('.') || '(root)'}: ${issue.message}`).join('; ');

/**
 * DSA5 structured journal tools.
 *
 * The DSA5 system stores its Dramatis Personae, quest log, almanac events and city details
 * as structured journal pages rather than text, which the generic journal tools cannot
 * read or write. These two tools read those pages and create, update and delete their
 * entries.
 */
export class DSA5JournalTools {
  private foundryClient: FoundryClient;
  private logger: Logger;

  constructor({ foundryClient, logger }: DSA5JournalToolsOptions) {
    this.foundryClient = foundryClient;
    this.logger = logger.child({ component: 'DSA5JournalTools' });
  }

  getToolDefinitions() {
    return [
      {
        name: 'dsa5-journal-read',
        description:
          '[DSA5 only] Read the structured journal pages of the DSA5 system: Dramatis Personae ' +
          '("personae": NPCs and creatures with faction, tags, linked actor, notes and their ' +
          'relationship to each hero), the quest log ("quests": status, objectives, dates, ' +
          'linked actors/items/journals), almanac events ("calendar"), city details ' +
          '("citydetails": temples, inns, merchants, … with quality and price level), almanac ' +
          'locations ("locations", DSA5 8.2+: places with region, kind, parent location and ' +
          'linked journal or Atlas marker), and the ' +
          'read-only AP and money logs ("aptracker", "moneytracker"). These pages hold no text, ' +
          'so list-journals and search-journals cannot read them. Call without pageType for an ' +
          'overview of all such pages; with pageType to list entries (summaries, filterable); ' +
          'add entryKey for one entry in full, including HTML. Dates use day, month (1 = Praios ' +
          '… 12 = Rahja, 13 = Nameless Days) and year.',
        inputSchema: {
          type: 'object',
          properties: {
            pageType: {
              type: 'string',
              enum: [...READ_PAGE_TYPES],
              description: 'Kind of page to read. Omit for an overview of all DSA5 pages.',
            },
            page: {
              type: 'string',
              description: 'Optional page UUID, id or name to read only that page.',
            },
            journal: {
              type: 'string',
              description: 'Optional journal id or name to read only pages in that journal.',
            },
            entryKey: {
              type: 'string',
              description: 'Key of a single entry to return in full detail.',
            },
            search: {
              type: 'string',
              description: 'Case-insensitive text to find anywhere in an entry.',
            },
            faction: {
              type: 'string',
              description: 'personae: part of the faction name. locations: part of the region.',
            },
            tag: { type: 'string', description: 'personae / quests / locations: exact tag.' },
            status: {
              type: 'string',
              enum: ['open', 'ended', 'failed'],
              description: 'quests: only quests with this status.',
            },
            kind: {
              type: 'string',
              description:
                'personae: "person" or "creature". citydetails: temples, inns, taverns, crafts, ' +
                'merchants, services, healers or travellers. locations: settlement, landmark, ' +
                'dungeon, region, building or other.',
            },
            visible: {
              type: 'boolean',
              description: 'Only entries that are (true) or are not (false) visible to players.',
            },
            limit: {
              type: 'number',
              description: 'Maximum number of entries to return (default 50, max 200).',
            },
          },
          additionalProperties: false,
        },
      },
      {
        name: 'dsa5-journal-manage',
        description:
          '[DSA5 only] Create, update or delete one entry on a DSA5 structured journal page: a ' +
          'Dramatis Personae entry ("personae"), a quest ("quests"), an almanac event ' +
          '("calendar"), a city detail ("citydetails") or an almanac location ("locations", ' +
          'DSA5 8.2+). On create, the entry goes to the ' +
          'given page, or to the only page of that type; if none exists a journal and page are ' +
          'created and added to the DSA5 almanac. update and delete need entryKey (from ' +
          'dsa5-journal-read); update changes only the fields passed in data. Text fields ' +
          'accept plain text or HTML. New quests, events and locations start hidden from players unless ' +
          'visible is true. Needs Allow Write Operations.\n' +
          'data fields by pageType:\n' +
          '- personae: name, kind (person|creature), actor (name, id or UUID of the actor to ' +
          'link, null to unlink; the system then fills name, image, faction and subtitle from ' +
          'it unless you pass them), subtitle, faction, tags (list), description, notes (stored ' +
          'on the linked actor when linkActorNotes is on), img, visible, important, garadan ' +
          '(0-4 or 6), showGaradanGMOnly, showSpecies, showCulture, showProfession, ' +
          'showActorDescription, linkActorNotes, socialContacts [{hero, level 1-9 or null to ' +
          'remove}] (1 = unquenchable hatred, 5 = neutral, 9 = deep love).\n' +
          '- quests: title, summary, details, gmNotes, status (open|ended|failed), priority ' +
          '(main|side|personal), audience (party|players|gm), players (user names, for audience ' +
          '"players"), visible, pinToTop, chapter, location, tags, image, startDate / targetDate ' +
          '/ completionDate ({day?, month?, year?}, any part may be omitted; null clears), ' +
          'objectives (a list of texts to add, or {add:[{text,status,visible}], ' +
          'update:[{key,text,status,visible}], remove:[key]} with status open|done|failed), ' +
          'links (a list of names/UUIDs of actors, items, journals or pages to add, or ' +
          '{add:[{ref,visible}], remove:[key or uuid]}).\n' +
          '- calendar: title, content, location, date {day, month, year} (defaults to the ' +
          'current world date), endDay (last day of a multi-day event in the same month), ' +
          'category (general|holiday|anniversary|historical|milestone), visible, recurring ' +
          '(repeats every year).\n' +
          '- citydetails: name, kind (temples|inns|taverns|crafts|merchants|services|healers|' +
          'travellers), typeText, description, gmNotes, img, visible, quality (0 poor - 5 ' +
          'exceptional, or null), price (0 very cheap, 2 average, 5 usury, or null).\n' +
          '- locations: name, subtitle, kind (settlement|landmark|dungeon|region|building|' +
          'other), region (one or more regions the location is grouped under), description, ' +
          'notes (player notes), img (icon), image (banner, null to clear), tags, visible ' +
          '(true shares with all players), players (user names: share with only these), ' +
          'important, parent (the containing location by name, entryKey or UUID, null to ' +
          'clear), source (name or UUID of the journal, page or Atlas marker the location ' +
          'stands for; on create it fills name and image; null to unbind).\n' +
          'Months are 1 = Praios … 12 = Rahja, 13 = Nameless Days, or the month name.',
        inputSchema: {
          type: 'object',
          properties: {
            pageType: {
              type: 'string',
              enum: [...WRITE_PAGE_TYPES],
              description: 'Kind of entry to manage.',
            },
            action: {
              type: 'string',
              enum: ['create', 'update', 'delete'],
              description: 'Operation to perform.',
            },
            entryKey: {
              type: 'string',
              description: 'Required for update and delete: the entry key from dsa5-journal-read.',
            },
            page: {
              type: 'string',
              description: 'Optional target page UUID, id or name.',
            },
            journal: {
              type: 'string',
              description:
                'Optional journal id or name. On create, a journal with this name is created ' +
                'when none exists.',
            },
            pageName: {
              type: 'string',
              description: 'create only: name of the page to use or create.',
            },
            data: {
              type: 'object',
              additionalProperties: true,
              description:
                'Entry fields for create and update; see the tool description for the fields ' +
                'of each pageType.',
            },
          },
          required: ['pageType', 'action'],
          additionalProperties: false,
        },
      },
    ];
  }

  async handleRead(args: unknown): Promise<any> {
    const parsed = readSchema.safeParse(args ?? {});
    if (!parsed.success) {
      return { success: false, error: `Invalid arguments: ${describeIssues(parsed.error)}` };
    }

    this.logger.info('Reading DSA5 journal pages', { pageType: parsed.data.pageType });
    try {
      return await this.foundryClient.query('foundry-mcp-bridge.dsa5ReadJournals', parsed.data);
    } catch (error) {
      this.logger.error('Failed to read DSA5 journal pages', error);
      return { success: false, error: error instanceof Error ? error.message : 'Unknown error' };
    }
  }

  async handleManage(args: unknown): Promise<any> {
    const parsed = manageSchema.safeParse(args);
    if (!parsed.success) {
      return { success: false, error: `Invalid arguments: ${describeIssues(parsed.error)}` };
    }

    this.logger.info('Managing DSA5 journal entry', {
      pageType: parsed.data.pageType,
      action: parsed.data.action,
    });
    try {
      return await this.foundryClient.query('foundry-mcp-bridge.dsa5ManageJournal', parsed.data);
    } catch (error) {
      this.logger.error('Failed to manage DSA5 journal entry', error);
      return { success: false, error: error instanceof Error ? error.message : 'Unknown error' };
    }
  }
}
