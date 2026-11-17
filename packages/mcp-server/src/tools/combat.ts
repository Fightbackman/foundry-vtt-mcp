import { z } from 'zod';
import { FoundryClient } from '../foundry-client.js';
import { Logger } from '../logger.js';

export interface CombatToolsOptions {
  foundryClient: FoundryClient;
  logger: Logger;
}

const ACTIONS = [
  'state',
  'create',
  'add',
  'start',
  'initiative',
  'next-turn',
  'previous-turn',
  'next-round',
  'previous-round',
  'update-combatant',
  'remove-combatant',
  'activate',
  'end',
] as const;

const INITIATIVE_MODES = ['all', 'npcs', 'missing'] as const;
const MESSAGE_MODES = ['public', 'gm', 'blind', 'self'] as const;

const manageCombatSchema = z
  .object({
    action: z.enum(ACTIONS),
    combat: z.string().min(1).optional(),
    scene: z.string().min(1).optional(),
    name: z.string().min(1).optional(),
    tokens: z.array(z.string().min(1)).optional(),
    tokenSet: z.enum(['all', 'hostile-and-friendly']).optional(),
    rollInitiative: z.enum([...INITIATIVE_MODES, 'none']).optional(),
    begin: z.boolean().optional(),
    mode: z.enum(INITIATIVE_MODES).optional(),
    combatants: z.array(z.string().min(1)).optional(),
    set: z.array(z.object({ combatant: z.string().min(1), value: z.number() }).strict()).optional(),
    messageMode: z.enum(MESSAGE_MODES).optional(),
    defeated: z.boolean().optional(),
    hidden: z.boolean().optional(),
  })
  .strict()
  .superRefine((args, ctx) => {
    const need = (ok: boolean, message: string) => {
      if (!ok) ctx.addIssue({ code: z.ZodIssueCode.custom, message });
    };
    if (args.action === 'create' || args.action === 'add') {
      need(!!args.tokens?.length || !!args.tokenSet, `${args.action} needs "tokens" or "tokenSet"`);
    }
    if (args.action === 'update-combatant') {
      need(!!args.combatants?.length, 'update-combatant needs "combatants"');
      need(
        args.defeated !== undefined || args.hidden !== undefined,
        'update-combatant needs "defeated" and/or "hidden"'
      );
    }
    if (args.action === 'remove-combatant') {
      need(!!args.combatants?.length, 'remove-combatant needs "combatants"');
    }
  });

/**
 * manage-combat: run an encounter from the combat tracker — create it from scene tokens,
 * roll or set initiative, advance turns and rounds, mark combatants defeated or hidden,
 * and end it. All changes run browser-side through the core Combat document methods, so
 * a system's own rules for those steps (DSA5's round-start effects and defense counts)
 * apply as they do from the tracker.
 */
export class CombatTools {
  private foundryClient: FoundryClient;
  private logger: Logger;

  constructor({ foundryClient, logger }: CombatToolsOptions) {
    this.foundryClient = foundryClient;
    this.logger = logger.child({ component: 'CombatTools' });
  }

  getToolDefinitions() {
    return [
      {
        name: 'manage-combat',
        description:
          'Run an encounter in the combat tracker. Actions: "state" (read: round, turn, whose ' +
          'turn it is and the combatants in initiative order; also lists the other encounters on ' +
          'the scene), "create" (new encounter on the current or a named scene from token ids or ' +
          'names and/or a tokenSet, optionally rolling initiative and starting it right away), ' +
          '"add" (more tokens into an existing encounter), "start", "initiative" (roll through ' +
          "the game system's own formula for all / NPCs / those without a value / named " +
          'combatants, or set values by hand with "set"), "next-turn", "previous-turn", ' +
          '"next-round", "previous-round" (report who is up and what changed on the combatants, ' +
          'e.g. damage, effects that ran out, chat cards the system posted), "update-combatant" ' +
          '(defeated / hidden, like the tracker buttons), "remove-combatant", "activate" (make an ' +
          'encounter the shown one) and "end" (delete the encounter, without the confirmation ' +
          'dialog). Tokens already in the encounter or not on the scene are reported per token. ' +
          'The encounter is the active one on the scene unless "combat" names it by id or name. ' +
          'In DSA5 worlds each combatant also shows LeP, conditions with levels, defenses made ' +
          'this round with the resulting penalty, and actions used. Everything except "state" ' +
          'needs Allow Write Operations. Attacks, defenses and damage are not part of this tool.',
        inputSchema: {
          type: 'object',
          properties: {
            action: { type: 'string', enum: [...ACTIONS], description: 'What to do.' },
            combat: {
              type: 'string',
              description:
                'Encounter id or name. Default: the active encounter on the scene (or the only one).',
            },
            scene: {
              type: 'string',
              description: 'Scene id or name. Default: the active scene.',
            },
            name: { type: 'string', description: 'create: name for the new encounter.' },
            tokens: {
              type: 'array',
              items: { type: 'string' },
              description:
                'create/add: token ids or token names on the scene. A name shared by several ' +
                'tokens adds all of them.',
            },
            tokenSet: {
              type: 'string',
              enum: ['all', 'hostile-and-friendly'],
              description:
                'create/add: "all" tokens on the scene, or "hostile-and-friendly" (hostile and ' +
                'friendly tokens plus any a player owns; leaves out neutral and secret ones).',
            },
            rollInitiative: {
              type: 'string',
              enum: [...INITIATIVE_MODES, 'none'],
              description: 'create/add: roll initiative right after adding (default none).',
            },
            begin: {
              type: 'boolean',
              description: 'create/add: start the encounter (round 1) right away.',
            },
            mode: {
              type: 'string',
              enum: [...INITIATIVE_MODES],
              description:
                'initiative: "all" rerolls everyone, "npcs" rolls for combatants without a ' +
                'player owner that have no initiative yet, "missing" (default) rolls for everyone ' +
                'without initiative.',
            },
            combatants: {
              type: 'array',
              items: { type: 'string' },
              description:
                'initiative / update-combatant / remove-combatant: combatant ids, token ids, ' +
                'actor ids or names.',
            },
            set: {
              type: 'array',
              description: 'initiative: set values by hand (e.g. a player rolled at the table).',
              items: {
                type: 'object',
                properties: {
                  combatant: { type: 'string', description: 'Combatant id, token id or name.' },
                  value: { type: 'number', description: 'Initiative value.' },
                },
                required: ['combatant', 'value'],
                additionalProperties: false,
              },
            },
            messageMode: {
              type: 'string',
              enum: [...MESSAGE_MODES],
              description:
                'Initiative rolls: chat visibility of the roll messages. Default: public, and GM ' +
                'only for hidden combatants.',
            },
            defeated: { type: 'boolean', description: 'update-combatant: mark (not) defeated.' },
            hidden: {
              type: 'boolean',
              description: 'update-combatant: hide from / show to players.',
            },
          },
          required: ['action'],
        },
      },
    ];
  }

  async handleManageCombat(args: unknown) {
    const parsed = manageCombatSchema.safeParse(args);
    if (!parsed.success) {
      const detail = parsed.error.issues
        .map(i => `${i.path.join('.') || '(root)'}: ${i.message}`)
        .join('; ');
      return { success: false, error: `Invalid arguments: ${detail}` };
    }
    this.logger.info('Managing combat', { action: parsed.data.action });
    try {
      return await this.foundryClient.query('foundry-mcp-bridge.manageCombat', parsed.data);
    } catch (error) {
      this.logger.error('Failed to manage combat', error);
      return { success: false, error: error instanceof Error ? error.message : 'Unknown error' };
    }
  }
}
