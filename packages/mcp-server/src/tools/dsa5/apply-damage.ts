import { z } from 'zod';
import { FoundryClient } from '../../foundry-client.js';
import { Logger } from '../../logger.js';

export interface DSA5ApplyDamageToolsOptions {
  foundryClient: FoundryClient;
  logger: Logger;
}

const ACTIONS = ['damage', 'heal', 'regenerate', 'spend', 'pay-cost'] as const;
const RESOURCES = ['LeP', 'AsP', 'KaP'] as const;
const CAMPSITES = ['normal', 'bad', 'good'] as const;
const INTERRUPTIONS = ['none', 'small', 'big'] as const;
const MESSAGE_MODES = ['public', 'gm', 'blind', 'self'] as const;

const amountSchema = z.union([z.number().int(), z.string().trim().min(1)]);

const applyDamageSchema = z
  .object({
    action: z.enum(ACTIONS),
    actor: z.string().min(1).optional(),
    messageId: z.string().min(1).optional(),
    amount: amountSchema.optional(),
    armor: z.boolean().optional(),
    resource: z.enum(RESOURCES).optional(),
    resources: z.array(z.enum(RESOURCES)).min(1).optional(),
    campsite: z.enum(CAMPSITES).optional(),
    interruption: z.enum(INTERRUPTIONS).optional(),
    badEnvironment: z.boolean().optional(),
    modifier: z.number().int().optional(),
    apply: z.boolean().optional(),
    messageMode: z.enum(MESSAGE_MODES).optional(),
  })
  .strict();

type ApplyDamageArgs = z.infer<typeof applyDamageSchema>;

/** Argument combinations each action needs; checked here so mistakes fail before Foundry. */
function missingArguments(args: ApplyDamageArgs): string | undefined {
  switch (args.action) {
    case 'damage':
      if (!args.messageId && (!args.actor || args.amount === undefined)) {
        return 'action "damage" needs "messageId" (an opposed result or damage card) or "actor" with "amount".';
      }
      return undefined;
    case 'heal':
      if (!args.actor || args.amount === undefined) {
        return 'action "heal" needs "actor" and "amount".';
      }
      return undefined;
    case 'spend':
      if (!args.actor || args.amount === undefined || !args.resource) {
        return 'action "spend" needs "actor", "amount" and "resource" ("AsP" or "KaP").';
      }
      if (args.resource === 'LeP')
        return 'action "spend" works on AsP or KaP; use "damage" for LeP.';
      return undefined;
    case 'pay-cost':
      if (!args.messageId)
        return 'action "pay-cost" needs "messageId" of the spell or liturgy card.';
      return undefined;
    case 'regenerate':
      if (!args.actor && !args.messageId) {
        return 'action "regenerate" needs "actor" (roll a regeneration) or "messageId" (apply a rolled one).';
      }
      return undefined;
    default:
      return undefined;
  }
}

/**
 * DSA5 damage, healing, regeneration and AsP/KaP handled by the system itself (its chat card
 * actions, Actor#applyDamage / applyMana and the regeneration test) in the bridge module.
 */
export class DSA5ApplyDamageTools {
  private foundryClient: FoundryClient;
  private logger: Logger;

  constructor({ foundryClient, logger }: DSA5ApplyDamageToolsOptions) {
    this.foundryClient = foundryClient;
    this.logger = logger.child({ component: 'DSA5ApplyDamageTools' });
  }

  getToolDefinitions() {
    return [
      {
        name: 'dsa5-apply-damage',
        description:
          '[DSA5 only] Change LeP, AsP and KaP the way DSA5 does, so armor, pain, brawling ' +
          'points and the system\'s hooks apply. Actions: "damage" applies the damage of an ' +
          'opposed test from its result card (messageId from dsa5-roll-check\'s "opposed" ' +
          'result; the defender comes from the card), or "amount" (number or dice formula) to ' +
          "an actor/token; armor: true (default) reduces the TP by the target's armor (RS), " +
          'false applies them as SP. "heal" restores an amount of LeP (or AsP/KaP with ' +
          '"resource"), never above the maximum. "regenerate" rolls the regeneration test ' +
          '(campsite, interruption, badEnvironment, modifier) and applies it, or applies a ' +
          'rolled regeneration card (messageId). "spend" pays AsP/KaP and fails when the actor ' +
          'has too few. "pay-cost" pays the AsP/KaP cost of a spell, ritual, liturgy or ' +
          'ceremony card cast with dsa5-roll-check or use-item. Returns LeP/AsP/KaP before and ' +
          'after, the armor used and conditions DSA5 added or changed (e.g. pain).',
        inputSchema: {
          type: 'object',
          properties: {
            action: {
              type: 'string',
              enum: [...ACTIONS],
              description: 'What to do',
            },
            actor: {
              type: 'string',
              description:
                'Actor name or id, or a scene token id: for an unlinked token (e.g. a creature ' +
                'placed several times) pass the token id so the change lands on that token.',
            },
            messageId: {
              type: 'string',
              description:
                'Chat message id: for "damage" the opposed result card (an attack or defense ' +
                'card linked to exactly one result works too); for "pay-cost" the spell / ' +
                'liturgy card; for "regenerate" a regeneration card to apply.',
            },
            amount: {
              oneOf: [{ type: 'integer' }, { type: 'string' }],
              description:
                'For "damage", "heal" and "spend": a positive whole number or a dice formula ' +
                'such as "1d6+2" (rolled once).',
            },
            armor: {
              type: 'boolean',
              description:
                'For "damage": true (default) = damage as TP, reduced by armor (RS) as DSA5 ' +
                '"apply damage as TP"; false = as SP, ignoring armor.',
            },
            resource: {
              type: 'string',
              enum: [...RESOURCES],
              description: 'For "heal" (default LeP) and "spend" (AsP or KaP).',
            },
            resources: {
              type: 'array',
              items: { type: 'string', enum: [...RESOURCES] },
              description:
                'For "regenerate": pools to regenerate (default all the actor has; AsP only for ' +
                'spellcasters, KaP only for blessed ones).',
            },
            campsite: {
              type: 'string',
              enum: [...CAMPSITES],
              description: 'For "regenerate": camp location (bad -1, good +1). Default normal.',
            },
            interruption: {
              type: 'string',
              enum: [...INTERRUPTIONS],
              description: 'For "regenerate": rest interrupted (small -1, big -2). Default none.',
            },
            badEnvironment: {
              type: 'boolean',
              description: 'For "regenerate": bad environment halves the result.',
            },
            modifier: {
              type: 'integer',
              description: 'For "regenerate": extra modifier to every regenerated pool.',
            },
            apply: {
              type: 'boolean',
              description:
                'For "regenerate": false only rolls and posts the card (apply later with its ' +
                'messageId). Default true.',
            },
            messageMode: {
              type: 'string',
              enum: [...MESSAGE_MODES],
              description: 'For "regenerate": chat visibility of the roll card.',
            },
          },
          required: ['action'],
        },
      },
    ];
  }

  async handleApplyDamage(args: unknown) {
    const parsed = applyDamageSchema.safeParse(args);
    if (!parsed.success) {
      const detail = parsed.error.issues
        .map(i => `${i.path.join('.') || '(root)'}: ${i.message}`)
        .join('; ');
      return { success: false, error: `Invalid arguments: ${detail}` };
    }
    const missing = missingArguments(parsed.data);
    if (missing) return { success: false, error: missing };

    const { actor, ...rest } = parsed.data;
    this.logger.info('Applying DSA5 damage/energy change', {
      action: rest.action,
      actor,
      messageId: rest.messageId,
    });
    try {
      return await this.foundryClient.query('foundry-mcp-bridge.dsa5ApplyDamage', {
        ...rest,
        ...(actor ? { actorIdentifier: actor } : {}),
      });
    } catch (error) {
      this.logger.error('Failed to apply DSA5 damage', error);
      return { success: false, error: error instanceof Error ? error.message : 'Unknown error' };
    }
  }
}
