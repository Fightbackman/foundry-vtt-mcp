import { z } from 'zod';
import { FoundryClient } from '../../foundry-client.js';
import { Logger } from '../../logger.js';

export interface DSA5RollCheckToolsOptions {
  foundryClient: FoundryClient;
  logger: Logger;
}

const CHECK_TYPES = ['skill', 'attribute', 'attack', 'parry', 'dodge', 'spell'] as const;
const MESSAGE_MODES = ['public', 'gm', 'blind', 'self'] as const;

const rollCheckSchema = z
  .object({
    actor: z.string().min(1),
    check: z.enum(CHECK_TYPES),
    name: z.string().min(1).optional(),
    modifier: z.number().int().optional(),
    targets: z.array(z.string().min(1)).optional(),
    messageMode: z.enum(MESSAGE_MODES).optional(),
  })
  .strict();

/**
 * DSA5 check rolled by the GM for an actor, NPC or creature, without the system's
 * modifier dialog. The roll itself runs through DSA5's own test pipeline in the bridge
 * module, which also posts the normal chat card.
 */
export class DSA5RollCheckTools {
  private foundryClient: FoundryClient;
  private logger: Logger;

  constructor({ foundryClient, logger }: DSA5RollCheckToolsOptions) {
    this.foundryClient = foundryClient;
    this.logger = logger.child({ component: 'DSA5RollCheckTools' });
  }

  getToolDefinitions() {
    return [
      {
        name: 'dsa5-roll-check',
        description:
          '[DSA5 only] Roll a DSA5 check for an actor, NPC or creature as the GM, without a ' +
          "dialog, using the system's own test, and post its normal chat card. Checks: " +
          '"skill" (Talentprobe, 3d20 -> quality level and remaining skill points), "attribute" ' +
          '(Eigenschaftsprobe, 1d20 against MU/KL/IN/CH/FF/GE/KO/KK), "attack" / "parry" with a ' +
          'weapon, creature trait or combat skill (or "weaponless"; an attack hit includes the ' +
          'damage roll), "dodge", and "spell" (spell, liturgy, ritual or ceremony; the AsP/KaP ' +
          'cost is reported but, as in DSA5, paid from the chat card). Returns dice, target ' +
          'values, outcome (critical/success/failure/botch), quality level and damage. Only the ' +
          "given modifier and the actor's active effects apply: dialog-only inputs (multiple " +
          'defense penalty, target size, reach, maneuvers, spell modifications) are not, so ' +
          'fold them into "modifier". To ask a PLAYER to roll, use request-player-rolls; to ' +
          'use an item the way the sheet does, use use-item.',
        inputSchema: {
          type: 'object',
          properties: {
            actor: {
              type: 'string',
              description:
                'Actor name or id, or a scene token id for an unlinked token. To parry or dodge ' +
                'an attack made against an unlinked token, pass that token id: DSA5 links the ' +
                'defense to the pending attack through the token, and the opposed result is ' +
                'posted to chat.',
            },
            check: {
              type: 'string',
              enum: [...CHECK_TYPES],
              description: 'What to roll',
            },
            name: {
              type: 'string',
              description:
                'Skill name (e.g. "Climbing"), attribute (e.g. "MU", "KK", "Courage"), weapon / ' +
                'trait / combat skill name or "weaponless" for attack and parry, or the spell / ' +
                'liturgy name. Item ids work too. Not used for dodge.',
            },
            modifier: {
              type: 'integer',
              description:
                'Whole-number modifier: positive makes the check easier (Erleichterung), ' +
                'negative harder (Erschwernis). Default 0.',
            },
            targets: {
              type: 'array',
              items: { type: 'string' },
              description:
                'Token names or ids on the current scene to target first; an attack against a ' +
                'target becomes an opposed test as on the sheet.',
            },
            messageMode: {
              type: 'string',
              enum: [...MESSAGE_MODES],
              description:
                'Chat visibility of the roll card (default: the core roll mode setting). "gm" ' +
                'shows it to the GM only (and the owner), "blind" hides the result from the roller.',
            },
          },
          required: ['actor', 'check'],
        },
      },
    ];
  }

  async handleRollCheck(args: unknown) {
    const parsed = rollCheckSchema.safeParse(args);
    if (!parsed.success) {
      const detail = parsed.error.issues
        .map(i => `${i.path.join('.') || '(root)'}: ${i.message}`)
        .join('; ');
      return { success: false, error: `Invalid arguments: ${detail}` };
    }

    const { actor, check, name, modifier, targets, messageMode } = parsed.data;
    if (check !== 'dodge' && !name) {
      return { success: false, error: `"name" is required for check "${check}".` };
    }

    this.logger.info('Rolling DSA5 check', { actor, check, name, modifier });
    try {
      return await this.foundryClient.query('foundry-mcp-bridge.dsa5RollCheck', {
        actorIdentifier: actor,
        check,
        name,
        modifier,
        targets,
        messageMode,
      });
    } catch (error) {
      this.logger.error('Failed to roll DSA5 check', error);
      return { success: false, error: error instanceof Error ? error.message : 'Unknown error' };
    }
  }
}
