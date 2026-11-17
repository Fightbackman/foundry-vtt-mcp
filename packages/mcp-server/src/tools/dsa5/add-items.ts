import { z } from 'zod';
import { FoundryClient } from '../../foundry-client.js';
import { Logger } from '../../logger.js';

export interface DSA5AddItemsToolsOptions {
  foundryClient: FoundryClient;
  logger: Logger;
}

const itemSchema = z
  .object({
    uuid: z.string().min(1).optional(),
    name: z.string().min(1).optional(),
    type: z.string().min(1).optional(),
    pack: z.string().min(1).optional(),
    quantity: z.number().int().positive().optional(),
    step: z.number().int().positive().optional(),
    adoption: z.string().min(1).optional(),
    adoptionDetail: z.string().min(1).optional(),
    free: z.boolean().optional(),
  })
  .strict()
  .refine(item => item.uuid || item.name, { message: 'each item needs a uuid or a name' });

const addItemsSchema = z
  .object({
    actor: z.string().min(1),
    action: z.enum(['add', 'remove']).optional(),
    items: z.array(itemSchema).min(1),
    free: z.boolean().optional(),
  })
  .strict();

/**
 * DSA5 add-items tool. The work happens in the Foundry module (dsa5-add-items.ts), which
 * calls the DSA5 system's own drop handling; this layer validates and forwards.
 */
export class DSA5AddItemsTools {
  private foundryClient: FoundryClient;
  private logger: Logger;

  constructor({ foundryClient, logger }: DSA5AddItemsToolsOptions) {
    this.foundryClient = foundryClient;
    this.logger = logger.child({ component: 'DSA5AddItemsTools' });
  }

  getToolDefinitions() {
    return [
      {
        name: 'dsa5-add-items',
        description:
          '[DSA5 only] Add items to an actor exactly like dropping them on the DSA5 character ' +
          "sheet, or remove them like the sheet's delete. The full item is copied (effects and " +
          'flags included). Advantages, disadvantages and special abilities go through the ' +
          'system rules: AP cost per step, "step" for the level, "adoption" for items whose ' +
          'sheet dialog asks for a choice (e.g. a Talent; refused with the valid choices when ' +
          'missing), and adding one the actor already has raises its step. Spells, liturgies, ' +
          'rituals, ceremonies, cantrips and blessings cost AP from their Steigerungsfaktor. ' +
          'Weapons, armor, equipment, ammunition, consumables, poisons stack onto an equal ' +
          'item ("quantity" sets the amount); money is added to the existing coins; item ' +
          'packages are resolved; diseases, traits (creatures), skills and the like are added ' +
          'once. AP are booked and the AP tracker written like on the sheet; without enough free ' +
          'AP the item is refused, "free": true adds it without AP (GM ruling). Species, culture ' +
          'and career need the system wizard and are refused. Each item is given by "uuid" or ' +
          'by "name" (exact, case-insensitive, searched in world items and compendiums; ' +
          '"type"/"pack" narrow it; ambiguous names are refused with candidates). ' +
          'action "remove" deletes items from the actor by name or id with the sheet\'s AP ' +
          'refund. Needs Allow Write Operations. Reports per item what was created or stacked, ' +
          'AP charged, free AP before/after, effects and tracker status.',
        inputSchema: {
          type: 'object',
          properties: {
            actor: { type: 'string', description: 'Actor name or id' },
            action: {
              type: 'string',
              enum: ['add', 'remove'],
              description: 'add (default) or remove',
            },
            free: {
              type: 'boolean',
              description: 'Default for all items: add without AP cost (GM ruling)',
            },
            items: {
              type: 'array',
              minItems: 1,
              description: 'Items to add (or, with action remove, to remove from the actor)',
              items: {
                type: 'object',
                properties: {
                  uuid: {
                    type: 'string',
                    description:
                      "Item UUID (world item, compendium entry or another actor's item). For " +
                      'remove: the item id or UUID on the actor.',
                  },
                  name: {
                    type: 'string',
                    description:
                      'Item name (e.g. "Zäher Hund", "Dukat"). "Begabung" also finds "Begabung ()". ' +
                      'For remove: the name of the item on the actor.',
                  },
                  type: {
                    type: 'string',
                    description:
                      'Item type to narrow the name (advantage, disadvantage, specialability, ' +
                      'spell, liturgy, meleeweapon, equipment, ammunition, consumable, money, ...)',
                  },
                  pack: {
                    type: 'string',
                    description:
                      'Compendium id or label fragment to search, or "world" for world items only',
                  },
                  quantity: {
                    type: 'integer',
                    minimum: 1,
                    description: 'Stackable items and money: how many to add',
                  },
                  step: {
                    type: 'integer',
                    minimum: 1,
                    description:
                      'Advantages, disadvantages, special abilities: the step (level) to end up ' +
                      'with; the AP for every step are charged',
                  },
                  adoption: {
                    type: 'string',
                    description:
                      'The choice the sheet asks for (e.g. a Talent like "Klettern", a spell, or ' +
                      'free text), for items that need one',
                  },
                  adoptionDetail: {
                    type: 'string',
                    description:
                      'Special abilities: the free-text detail of the adoption dialog (e.g. the ' +
                      'skill specialization)',
                  },
                  free: {
                    type: 'boolean',
                    description: 'Add this item without AP cost (overrides the top-level free)',
                  },
                },
                additionalProperties: false,
              },
            },
          },
          required: ['actor', 'items'],
        },
      },
    ];
  }

  async handleAddItems(args: unknown) {
    const parsed = addItemsSchema.safeParse(args);
    if (!parsed.success) {
      const detail = parsed.error.issues
        .map(i => `${i.path.join('.') || '(root)'}: ${i.message}`)
        .join('; ');
      return { success: false, error: `Invalid arguments: ${detail}` };
    }
    const data = parsed.data;
    this.logger.info('DSA5 add-items', {
      actor: data.actor,
      action: data.action ?? 'add',
      count: data.items.length,
    });
    try {
      return await this.foundryClient.query('foundry-mcp-bridge.dsa5AddItems', data);
    } catch (error) {
      this.logger.error('DSA5 add-items failed', error);
      return { success: false, error: error instanceof Error ? error.message : 'Unknown error' };
    }
  }
}
