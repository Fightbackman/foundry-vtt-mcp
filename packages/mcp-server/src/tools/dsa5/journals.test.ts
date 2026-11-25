import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DSA5JournalTools } from './journals.js';

function makeTools() {
  const query = vi.fn(async (_name: string, data: any) => ({ success: true, echoed: data }));
  const logger: any = { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() };
  logger.child = () => logger;
  const tools = new DSA5JournalTools({ foundryClient: { query } as any, logger });
  return { tools, query };
}

describe('DSA5 journal tools', () => {
  let tools: DSA5JournalTools;
  let query: ReturnType<typeof makeTools>['query'];

  beforeEach(() => {
    ({ tools, query } = makeTools());
  });

  it('exposes a read tool and a manage tool', () => {
    const definitions = tools.getToolDefinitions();

    expect(definitions.map(definition => definition.name)).toEqual([
      'dsa5-journal-read',
      'dsa5-journal-manage',
    ]);
    for (const definition of definitions) {
      expect(definition.description).toContain('[DSA5 only]');
      expect(definition.inputSchema.type).toBe('object');
    }
  });

  describe('dsa5-journal-read', () => {
    it('reads the overview when called without arguments', async () => {
      const result = await tools.handleRead(undefined);

      expect(result.success).toBe(true);
      expect(query).toHaveBeenCalledWith('foundry-mcp-bridge.dsa5ReadJournals', {});
    });

    it('forwards the page type and filters', async () => {
      await tools.handleRead({ pageType: 'quests', status: 'open', limit: 10 });

      expect(query).toHaveBeenCalledWith('foundry-mcp-bridge.dsa5ReadJournals', {
        pageType: 'quests',
        status: 'open',
        limit: 10,
      });
    });

    it('rejects unknown page types and arguments without calling Foundry', async () => {
      const badType = await tools.handleRead({ pageType: 'spells' });
      const badArgument = await tools.handleRead({ pageType: 'quests', query: 'amulet' });

      expect(badType).toMatchObject({ success: false, error: expect.stringContaining('pageType') });
      expect(badArgument.success).toBe(false);
      expect(query).not.toHaveBeenCalled();
    });
  });

  describe('dsa5-journal-manage', () => {
    it('forwards a valid create', async () => {
      const args = {
        pageType: 'quests',
        action: 'create',
        data: {
          title: 'Find the amulet',
          status: 'open',
          startDate: { day: 3, month: 'Praios' },
          objectives: ['Ask around', { text: 'Enter the sewers', status: 'done' }],
          links: { add: [{ ref: 'Rondrian', visible: false }] },
        },
      };

      const result = await tools.handleManage(args);

      expect(result.success).toBe(true);
      expect(query).toHaveBeenCalledWith('foundry-mcp-bridge.dsa5ManageJournal', args);
    });

    it('lets a persona take its name from the linked actor', async () => {
      const result = await tools.handleManage({
        pageType: 'personae',
        action: 'create',
        data: { actor: 'Rondrian' },
      });

      expect(result.success).toBe(true);
    });

    it('forwards a location create and lets a bound source stand in for the name', async () => {
      const full = {
        pageType: 'locations',
        action: 'create',
        data: {
          name: 'Trackenborn',
          kind: 'settlement',
          region: ['Eisenwald', 'Kosch'],
          tags: 'village, mine',
          parent: 'Kosch',
          players: ['Alrik'],
          image: null,
        },
      };
      const fromSource = {
        pageType: 'locations',
        action: 'create',
        data: { source: 'JournalEntry.abc' },
      };

      expect((await tools.handleManage(full)).success).toBe(true);
      expect((await tools.handleManage(fromSource)).success).toBe(true);
      expect(query).toHaveBeenCalledWith('foundry-mcp-bridge.dsa5ManageJournal', full);
    });

    it('reads locations with a kind filter', async () => {
      await tools.handleRead({ pageType: 'locations', kind: 'dungeon', faction: 'Eisenwald' });

      expect(query).toHaveBeenCalledWith('foundry-mcp-bridge.dsa5ReadJournals', {
        pageType: 'locations',
        kind: 'dungeon',
        faction: 'Eisenwald',
      });
    });

    it.each([
      [
        'a create without the entry name',
        { pageType: 'quests', action: 'create', data: { summary: 'x' } },
        'data.title',
      ],
      [
        'a persona without name or actor',
        { pageType: 'personae', action: 'create', data: { faction: 'x' } },
        'data.name',
      ],
      [
        'a create with an entry key',
        { pageType: 'quests', action: 'create', entryKey: 'k', data: { title: 'x' } },
        'entryKey',
      ],
      [
        'an update without an entry key',
        { pageType: 'quests', action: 'update', data: { status: 'ended' } },
        'entryKey',
      ],
      ['an update without data', { pageType: 'quests', action: 'update', entryKey: 'k' }, 'data'],
      [
        'a delete with data',
        { pageType: 'quests', action: 'delete', entryKey: 'k', data: { title: 'x' } },
        'data',
      ],
      [
        'a field the page type does not have',
        { pageType: 'calendar', action: 'update', entryKey: 'k', data: { faction: 'x' } },
        'data',
      ],
      [
        'an unknown status',
        { pageType: 'quests', action: 'update', entryKey: 'k', data: { status: 'done' } },
        'data.status',
      ],
      [
        'a contact level out of range',
        {
          pageType: 'personae',
          action: 'update',
          entryKey: 'k',
          data: { socialContacts: [{ hero: 'Alrike', level: 12 }] },
        },
        'socialContacts',
      ],
      [
        'a month out of range',
        { pageType: 'calendar', action: 'update', entryKey: 'k', data: { date: { month: 14 } } },
        'data.date.month',
      ],
      [
        'a quality out of range',
        { pageType: 'citydetails', action: 'update', entryKey: 'k', data: { quality: 6 } },
        'data.quality',
      ],
      [
        'a location without name or source',
        { pageType: 'locations', action: 'create', data: { region: 'Kosch' } },
        'data.name or data.source',
      ],
      [
        'an unknown location kind',
        { pageType: 'locations', action: 'update', entryKey: 'k', data: { kind: 'castle' } },
        'data.kind',
      ],
      [
        'the system field name faction on a location',
        { pageType: 'locations', action: 'update', entryKey: 'k', data: { faction: 'Kosch' } },
        'data',
      ],
      [
        'a write to a tracker page',
        { pageType: 'aptracker', action: 'create', data: { itemName: 'x' } },
        'pageType',
      ],
    ])('rejects %s', async (_label, args, expectedPath) => {
      const result = await tools.handleManage(args);

      expect(result.success).toBe(false);
      expect(result.error).toContain(expectedPath);
      expect(query).not.toHaveBeenCalled();
    });

    it('accepts null to clear a date, unlink an actor or remove a contact', async () => {
      const quest = await tools.handleManage({
        pageType: 'quests',
        action: 'update',
        entryKey: 'k',
        data: { targetDate: null, image: null },
      });
      const persona = await tools.handleManage({
        pageType: 'personae',
        action: 'update',
        entryKey: 'k',
        data: { actor: null, socialContacts: [{ hero: 'Alrike', level: null }] },
      });

      expect(quest.success).toBe(true);
      expect(persona.success).toBe(true);
    });

    it('returns the error when Foundry cannot be reached', async () => {
      query.mockRejectedValueOnce(new Error('Foundry VTT module not connected'));

      const result = await tools.handleManage({
        pageType: 'quests',
        action: 'delete',
        entryKey: 'k',
      });

      expect(result).toEqual({ success: false, error: 'Foundry VTT module not connected' });
    });
  });
});
