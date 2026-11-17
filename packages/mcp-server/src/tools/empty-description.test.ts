/**
 * An empty description stored as `{ value: '' }` (DSA5, WFRP4e, …) fell through
 * `description.value || description` to the object itself, which then came back as the
 * string '{"value":""}' (get-compendium-item) or as an object (get-character-entity).
 */

import { describe, expect, it, vi } from 'vitest';
import { CharacterTools } from './character.js';
import { CompendiumTools } from './compendium.js';

const logger: any = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  child: () => logger,
};

describe('empty item descriptions', () => {
  it('get-compendium-item returns an empty string', async () => {
    const query = vi.fn().mockResolvedValue({
      id: 'i1',
      name: 'Holzbearbeitung',
      type: 'skill',
      pack: 'dsa5.skills',
      packLabel: 'Talente',
      system: { description: { value: '' } },
    });
    const tools = new CompendiumTools({ foundryClient: { query } as any, logger });

    const full = await tools.handleGetCompendiumItem({ packId: 'dsa5.skills', itemId: 'i1' });
    expect(full.description).toBe('');
    expect(full.fullDescription).toBe('');

    const compact = await tools.handleGetCompendiumItem({
      packId: 'dsa5.skills',
      itemId: 'i1',
      compact: true,
    });
    expect(compact.description).toBe('');
  });

  it('get-compendium-item still reads a filled description', async () => {
    const query = vi.fn().mockResolvedValue({
      id: 'i2',
      name: 'Sword',
      type: 'weapon',
      system: { description: { value: '<p>Sharp.</p>' } },
    });
    const tools = new CompendiumTools({ foundryClient: { query } as any, logger });

    const full = await tools.handleGetCompendiumItem({ packId: 'p', itemId: 'i2' });
    expect(full.description).toBe('Sharp.');
  });

  it('get-character-entity returns an empty string', async () => {
    const query = vi.fn().mockResolvedValue({
      success: true,
      entityType: 'item',
      entity: {
        id: 'sw1',
        name: 'Langschwert',
        type: 'meleeweapon',
        system: { description: { value: '' } },
      },
    });
    const tools = new CharacterTools({ foundryClient: { query } as any, logger });

    const result: any = await tools.handleGetCharacterEntity({
      characterIdentifier: 'Held',
      entityIdentifier: 'sw1',
    });
    expect(result.description).toBe('');
  });
});
