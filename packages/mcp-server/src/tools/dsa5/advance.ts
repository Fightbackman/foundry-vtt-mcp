import { z } from 'zod';
import { FoundryClient } from '../../foundry-client.js';
import { Logger } from '../../logger.js';

export interface DSA5AdvanceToolsOptions {
  foundryClient: FoundryClient;
  logger: Logger;
}

const advanceSchema = z
  .object({
    action: z.enum(['raise', 'lower', 'preview', 'award']),
    actor: z.string().min(1).optional(),
    target: z.string().min(1).optional(),
    steps: z.number().int().min(1).max(50).optional(),
    toValue: z.number().int().min(0).optional(),
    free: z.boolean().optional(),
    ignoreMaximum: z.boolean().optional(),
    actors: z.array(z.string().min(1)).optional(),
    party: z.boolean().optional(),
    amount: z.number().int().min(1).optional(),
    reason: z.string().max(500).optional(),
    postToChat: z.boolean().optional(),
  })
  .strict();

/**
 * dsa5-advance: spend and refund Abenteuerpunkte (AP) through the DSA5 system's own
 * advancement, preview costs, and award AP the way the system's GM menu does.
 */
export class DSA5AdvanceTools {
  private foundryClient: FoundryClient;
  private logger: Logger;

  constructor({ foundryClient, logger }: DSA5AdvanceToolsOptions) {
    this.foundryClient = foundryClient;
    this.logger = logger.child({ component: 'DSA5AdvanceTools' });
  }

  getToolDefinitions() {
    return [
      {
        name: 'dsa5-advance',
        description:
          '[DSA5 only] Advance a hero with Abenteuerpunkte (AP) by the rules, exactly like the ' +
          '"+"/"-" buttons on the DSA5 character sheet. action "raise"/"lower": change a talent ' +
          '(skill), combat technique, spell, liturgy, ritual or ceremony (item name as stored on ' +
          'the actor, or item id), an attribute (mu, kl, in, ch, ff, ge, ko, kk or its localized ' +
          'name such as "Mut"), or bought LeP/AsP/KaP, by `steps` or to `toValue`. Each step pays ' +
          '(or refunds) the AP from the system cost table for the Steigerungsfaktor, checks free ' +
          "AP and the system's maximum and writes the system's AP tracker entry. A multi-step " +
          'raise stops cleanly when AP or the maximum run out and reports how far it got. ' +
          'action "preview": the same plan and costs without writing anything. action "award": ' +
          'give AP to `actors` and/or the whole `party` (primary party, else the GM-menu tracked ' +
          'actors, else player-owned actors); familiars get 25 % and pets 10 % like the GM menu, ' +
          'and a chat message is posted. `free: true` is a GM ruling: the value changes without ' +
          'AP (logged in the tracker with cost 0) and still respects the maximum unless ' +
          '`ignoreMaximum: true`. Only characters, familiars and pets have AP; npcs and ' +
          'creatures are refused (edit them with manage-actors). raise, lower and award require ' +
          'Allow Write Operations; preview does not.',
        inputSchema: {
          type: 'object',
          properties: {
            action: {
              type: 'string',
              enum: ['raise', 'lower', 'preview', 'award'],
              description:
                'raise/lower a value, preview a raise (or a lowering with toValue) without ' +
                'writing, or award AP.',
            },
            actor: {
              type: 'string',
              description: 'raise/lower/preview: actor name or id.',
            },
            target: {
              type: 'string',
              description:
                'raise/lower/preview: what to change — item name or id (skill, combat technique, ' +
                'spell, liturgy, ritual, ceremony), attribute key or localized name, or ' +
                'LeP/AsP/KaP (bought points).',
            },
            steps: {
              type: 'integer',
              minimum: 1,
              maximum: 50,
              description: 'Number of steps (default 1). Do not combine with toValue.',
            },
            toValue: {
              type: 'integer',
              minimum: 0,
              description:
                'Target value instead of steps. Attributes count initial + advances (what the ' +
                'sheet raises), bought points count the points bought.',
            },
            free: {
              type: 'boolean',
              description:
                'GM ruling: change the value without paying or refunding AP (tracker entry ' +
                'with cost 0).',
            },
            ignoreMaximum: {
              type: 'boolean',
              description: "Only with free: true — allow going above the system's maximum.",
            },
            actors: {
              type: 'array',
              items: { type: 'string' },
              description: 'award: actor names or ids to receive AP.',
            },
            party: {
              type: 'boolean',
              description:
                "award: also include the party (the system GM menu's default list: primary " +
                'party, else tracked actors, else player-owned actors).',
            },
            amount: {
              type: 'integer',
              minimum: 1,
              description: 'award: AP per hero (familiars 25 %, pets 10 %, at least 1).',
            },
            reason: {
              type: 'string',
              description: 'award: optional reason, added to the chat message.',
            },
            postToChat: {
              type: 'boolean',
              description: 'award: post the award to chat like the GM menu (default true).',
            },
          },
          required: ['action'],
        },
      },
    ];
  }

  async handleAdvance(args: unknown) {
    const parsed = advanceSchema.safeParse(args);
    if (!parsed.success) {
      const detail = parsed.error.issues
        .map(i => `${i.path.join('.') || '(root)'}: ${i.message}`)
        .join('; ');
      return { success: false, error: `Invalid arguments: ${detail}` };
    }
    const data = parsed.data;

    if (data.action === 'award') {
      if (data.amount === undefined) {
        return { success: false, error: 'award needs amount (a positive integer)' };
      }
      if (!data.actors?.length && !data.party) {
        return { success: false, error: 'award needs actors and/or party: true' };
      }
      this.logger.info('Awarding DSA5 AP', { amount: data.amount, party: data.party });
      try {
        return await this.foundryClient.query('foundry-mcp-bridge.dsa5AwardAP', {
          actors: data.actors,
          party: data.party,
          amount: data.amount,
          reason: data.reason,
          postToChat: data.postToChat,
        });
      } catch (error) {
        this.logger.error('Failed to award DSA5 AP', error);
        return { success: false, error: error instanceof Error ? error.message : 'Unknown error' };
      }
    }

    if (!data.actor || !data.target) {
      return { success: false, error: `${data.action} needs actor and target` };
    }
    if (data.steps !== undefined && data.toValue !== undefined) {
      return { success: false, error: 'Provide either steps or toValue, not both' };
    }
    if (data.ignoreMaximum && !data.free) {
      return { success: false, error: 'ignoreMaximum requires free: true' };
    }

    this.logger.info('DSA5 advancement', {
      action: data.action,
      actor: data.actor,
      target: data.target,
    });
    try {
      return await this.foundryClient.query('foundry-mcp-bridge.dsa5Advance', {
        action: data.action,
        actor: data.actor,
        target: data.target,
        steps: data.steps,
        toValue: data.toValue,
        free: data.free,
        ignoreMaximum: data.ignoreMaximum,
      });
    } catch (error) {
      this.logger.error('DSA5 advancement failed', error);
      return { success: false, error: error instanceof Error ? error.message : 'Unknown error' };
    }
  }
}
