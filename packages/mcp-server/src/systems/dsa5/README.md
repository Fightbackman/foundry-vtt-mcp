# DSA5 System Adapter

DSA5 (Das Schwarze Auge 5) support for Foundry VTT MCP integration.

## Overview

This adapter implements the v0.6.0 Registry Pattern to provide system-specific support for DSA5 characters and creatures in the Foundry VTT MCP server.

## Features

### Character Statistics Extraction

- **8 Eigenschaften (Attributes):** MU, KL, IN, CH, FF, GE, KO, KK
- **LeP (Lebensenergie):** Life points tracking
- **AsP (Astralenergie):** Mana/spell energy for spellcasters
- **KaP (Karmaenergie):** Karma energy for blessed ones
- **Talente (Skills):** All character skills with values and check attributes
- **Erfahrungsgrad (Experience Level):** 1-7 level classification based on Adventure Points

### Creature Index

- Full compendium indexing for DSA5 creatures
- Species, culture, profession metadata
- Combat statistics (LeP, Parade, Ausweichen, Rüstung)
- Spellcasting and resource detection

### Filter System

Supports filtering creatures by:

- `level`: Experience level 1-7 (e.g., `{level: 3}` for Experienced)
- `species`: Species/race (e.g., `{species: "Mensch"}`)
- `culture`: Culture background (e.g., `{culture: "Mittelreich"}`)
- `size`: Size category (tiny, small, medium, large, huge)
- `hasSpells`: Boolean - has spellcasting abilities
- `traits`: Array of special abilities/traits to match

### Structured Journals

The DSA5 system stores several kinds of campaign notes as structured journal pages instead
of text. Two tools cover them (`tools/dsa5/journals.ts`, Foundry side in
`foundry-module/src/dsa5-journals.ts`):

- `dsa5-journal-read` — overview of all such pages, filtered entry lists, or one entry in full
- `dsa5-journal-manage` — create, update or delete one entry

| `pageType`     | DSA5 page type        | Collection in `page.system` | Writable |
| -------------- | --------------------- | --------------------------- | -------- |
| `personae`     | `dsapersonaedramatis` | `personae`                  | yes      |
| `quests`       | `dsaquestlog`         | `quests`                    | yes      |
| `calendar`     | `dsacalendar`         | `calendarentries`           | yes      |
| `citydetails`  | `citydetails`         | `details`                   | yes      |
| `aptracker`    | `dsaaptracker`        | `entries`                   | no       |
| `moneytracker` | `dsamoneytracker`     | `entries`                   | no       |

Behaviour worth knowing:

- Numeric choices are exposed by name (quest status `open` / `ended` / `failed`, priority
  `main` / `side` / `personal`, audience `party` / `players` / `gm`, event category, persona
  kind) and months are 1-based (1 = Praios … 12 = Rahja, 13 = Nameless Days) or a month name.
- A new entry goes to the page that was named, or to the only page of its type. With no such
  page, a journal and page are created under the system's default name. Personae, quest and
  calendar journals are added to the system's almanac settings (`calendarActors`,
  `questlogJournals`, `calendarJournals`), as the system does itself.
- Linking a persona to an actor lets the system fill name, image, faction and subtitle from
  that actor; values passed explicitly are applied afterwards. With `linkActorNotes`, notes
  are stored on the actor (`system.details.notes.value`), not on the journal entry.
- Quest dates are partial: only the parts passed are written. Calendar events always store a
  complete date, from which the system derives the day of the year.
- New quests and events start hidden from players, matching the system's own "new entry".

## Architecture

### Files

```
systems/dsa5/
├── adapter.ts         (378 lines) - SystemAdapter implementation
├── constants.ts       (201 lines) - Field paths, mappings, experience levels
├── filters.ts         (202 lines) - Zod schemas, filter matching logic
├── filters.test.ts    (102 lines) - Unit tests for filters
├── index-builder.ts   (319 lines) - IndexBuilder implementation
├── index.ts           (46 lines)  - Public API exports
└── README.md          - This file
```

### Key Classes

**DSA5Adapter** (`adapter.ts`)

- Implements `SystemAdapter` interface (11 methods)
- Runs in MCP server (Node.js context)
- Handles filtering, formatting, character stat extraction

**DSA5IndexBuilder** (`index-builder.ts`)

- Implements `IndexBuilder` interface
- Runs in Foundry module (browser context)
- Builds enhanced creature indexes from compendium packs

## DSA5 Field Mappings

Checked against the system's data models (dsa5-foundryVTT 8.x, `modules/data/actor`).
Many values the sheet shows are **derived at runtime** and are not stored on the actor;
writing them has no effect. `manage-actors` therefore maps its shorthands onto the stored
parts (see `describeActorSchema` in `adapter.ts`).

### Eigenschaften (8 Attributes)

```
system.characteristics.<mu|kl|in|ch|ff|ge|ko|kk>
  .initial   stored   base value (default 8)
  .advances  stored   purchased increases
  .modifier  stored   temporary modifier
  .value     derived  initial + advances + modifier + gear
```

MU Mut/Courage, KL Klugheit/Cleverness, IN Intuition, CH Charisma, FF Fingerfertigkeit/Dexterity,
GE Gewandtheit/Agility, KO Konstitution/Constitution, KK Körperkraft/Strength.

### Status & Resources

```
system.status.wounds.value        stored   current LeP
system.status.wounds.initial      stored   base LeP (creatures: the whole pool)
system.status.wounds.max          derived  character/npc: initial + 2×KO + advances + modifier
                                           creature:      initial + advances + modifier
system.status.wounds.current      derived  intermediate base of that formula, NOT the current LeP
system.status.astralenergy.*      AsP, same layout (value = current, max derived)
system.status.karmaenergy.*       KaP, same layout
system.status.fatePoints.value    stored   Schicksalspunkte left (.current = base maximum)
```

### Profile

```
system.details.species.value     → Species (Mensch, Elf, Zwerg...)
system.details.culture.value     → Culture
system.details.career.value      → Profession (IMPORTANT: "career", not "profession"!)
system.details.experience.total  → Total Adventure Points (AP)
system.details.experience.spent  → Spent AP (available = total − spent, derived)
system.creatureClass.value       → Creature class (creatures only)
```

### Combat

```
system.status.size.value          tiny | small | average | big | giant
system.status.speed.initial       stored   base GS (.max derived)
system.status.initiative.current  stored   base INI of a creature
system.status.initiative.value    derived  heroes: (MU + GE) / 2 + modifier
system.status.dodge.max           derived  GE / 2 + modifier (all actor types)
system.status.soulpower.max       derived  SK (creatures store .value)
system.status.toughness.max       derived  ZK (creatures store .value)
system.totalArmor                 derived  RS from equipped armor items
```

### Skills/Talente

```
Items with type "skill" (Talent) or "combatskill" (Kampftechnik)
Value: item.system.talentValue.value
Check: item.system.characteristic1..3.value (e.g. kl / kl / in)
```

## Experience Levels (Erfahrungsgrad)

DSA5 classifies heroes by their total Adventure Points (AP). The thresholds are the
starting AP of hero creation and match the system's own
`DSA5_Utility.experienceDescription`:

| Level | Name (DE)        | Name (EN)     | AP Range    |
| ----- | ---------------- | ------------- | ----------- |
| 1     | Unerfahren       | Inexperienced | 0 - 999     |
| 2     | Durchschnittlich | Average       | 1000 - 1099 |
| 3     | Erfahren         | Experienced   | 1100 - 1199 |
| 4     | Kompetent        | Competent     | 1200 - 1399 |
| 5     | Meisterlich      | Masterful     | 1400 - 1699 |
| 6     | Brillant         | Brilliant     | 1700 - 2099 |
| 7     | Legendär         | Legendary     | 2100+       |

## Usage Examples

### Filter by Experience Level

```typescript
import { matchesDSA5Filters } from './filters.js';

const filters = { level: 3 }; // Experienced characters only
const matches = matchesDSA5Filters(creature, filters);
```

### Extract Character Stats

```typescript
import { DSA5Adapter } from './adapter.js';

const adapter = new DSA5Adapter();
const stats = adapter.extractCharacterStats(actorData);
// Returns: { attributes, resources, skills, profile, physical }
```

### Build Creature Index

```typescript
import { DSA5IndexBuilder } from './index-builder.js';

const builder = new DSA5IndexBuilder();
const index = await builder.buildIndex(packs, force);
```

## Creature Discovery (`list-creatures-by-criteria`)

In a DSA5 world the Foundry module indexes every Actor compendium
(`packages/foundry-module/src/dsa5-creature-index.ts`, driven by the enhanced creature index
in `data-access.ts`) and `list-creatures-by-criteria` filters that index. Actors of type
`creature`, `npc` and `character` are indexed from the prepared documents, so derived values
such as the maximum LeP, Ausweichen and Rüstungsschutz are the ones the sheet shows.

DSA5 has no challenge rating or level for creatures; these criteria apply instead:

| Criterion       | Matches                                                                                         |
| --------------- | ----------------------------------------------------------------------------------------------- |
| `creatureClass` | Part of the creature class on the sheet, case-insensitive (`"Tier"`, `"Dämon"`, `"Untot"`, …)   |
| `species`       | Part of the species of an NPC or character (`"Elf"`, `"Zwerg"`, …)                              |
| `actorType`     | `creature`, `npc` or `character`                                                                |
| `size`          | `tiny`, `small`, `average`, `big`, `giant` (`medium` / `large` / `huge` are mapped onto them)   |
| `hitPoints`     | Maximum Lebensenergie, exact or `{min, max}`                                                    |
| `hasSpells`     | Has AsP or KaP, or owns spells, rituals, liturgies or ceremonies                                |
| `creatureType`  | The tool's generic type filter: part of the creature class, or of the species for NPCs / heroes |

Results are sorted by LeP and carry class or species / profession, size, LeP, AsP / KaP, SK, ZK,
Ausweichen, RS, GS, INI and the names of a creature's traits. The index is persisted per world
and rebuilt when a pack changes, like the index of the other systems.

The `DSA5IndexBuilder` and `filters.ts` in this folder predate that integration and are not
used at runtime.

## Conditions

`toggle-token-condition` and `get-available-conditions` use DSA5's own condition API (`actor.addCondition` / `actor.removeCondition`, implemented in `packages/foundry-module/src/dsa5-conditions.ts`), not `toggleStatusEffect`, which in DSA5 adds one level per call.

- Many conditions have levels (usually 1–4; `get-available-conditions` reports `maxLevel`). Each level is the sum of an **automatic** share, which the system sets itself (pain from lost LeP, encumbrance from armour, stupor from brawling), and a **manual** share.
- `level: N` sets the total to N by changing only the manual share. It is capped at the maximum, and cannot go below the automatic share; both cases return a warning.
- `active: true` adds level 1 if the condition is missing and otherwise leaves it as it is. `active: false` or `level: 0` removes it, except for automatic levels: the system recalculates those after every effect change and would re-apply them at once, so they stay and a warning says so.
- Conditions can be named by id or by localized name, case-insensitively (`inpain`, or `Schmerz` / `Pain` depending on the world's language).
- The system only applies conditions to an unlinked token while that token is drawn on the canvas; otherwise the tool returns an error instead of silently doing nothing.
- `get-character` lists each effect's `statuses` and, for leveled conditions, `level` and `maxLevel`.

## Rolls and item use

DSA5 checks are not d20 + modifier rolls, so the generic roll paths call the DSA5 system's own test pipeline instead (`packages/foundry-module/src/dsa5-rolls.ts`). The system computes the result and posts its normal chat card.

- **`request-player-rolls`** posts the system's own roll request card (the one the GM's "request roll" dialog creates). `rollType: "skill"` requests a skill check (Talentprobe, `rollTarget` = skill name or item id), `rollType: "ability"` an attribute check (Eigenschaftsprobe, `rollTarget` = MU/KL/IN/CH/FF/GE/KO/KK, the English abbreviation or the localized name). `rollModifier` must be a whole number; positive makes the check easier, negative harder. Other roll types (save, attack, initiative, custom) return an error. The designated player gets the system's roll dialog with the modifier filled in; if no owner is online the card waits and the GM can use "Roll on Behalf" or "Resend". The tool returns once the card is posted, not when the player has rolled; the outcome and quality level appear on the card.
- **`dsa5-roll-check`** rolls as the GM for any actor, NPC or creature, without a dialog: `skill`, `attribute`, `attack` / `parry` (weapon, creature trait, combat skill or `weaponless`), `dodge` and `spell` (spell, liturgy, ritual, ceremony). It returns the dice and target values, the outcome, quality level and remaining skill points, damage on an attack hit, and the AsP/KaP cost for spells. Targeted tokens turn an attack into an opposed test; a parry or dodge by the attacked token (pass its token id when it is unlinked) resolves that test as on the sheet.
- **`use-item`** does what the character sheet does: weapons and attack traits roll an attack, spells/liturgies/rituals/ceremonies their casting test, skills a skill check, consumables and plants are consumed, everything else is posted to chat. Its result includes the roll summary.

Limitations:

1. Without a dialog only the system's automatic modifiers (active effects, conditions) and the given modifier apply. Inputs the roll dialog asks for, such as the multiple-defense penalty, target size, reach comparison, combat maneuvers and spell modifications, are not applied; include them in the modifier.
2. Spell and liturgy costs are reported but not deducted. In DSA5 the caster pays them from the chat card's context menu; `dsa5-apply-damage` with `action: "pay-cost"` does that step (see below).
3. Falling damage and group checks are not covered. Regeneration is rolled by `dsa5-apply-damage` (see below).

## Damage, healing and energy

**`dsa5-apply-damage`** changes LeP, AsP and KaP through the system (`packages/foundry-module/src/dsa5-damage.ts`), so armor, brawling points, pain and the system's `preApplyDamage` hooks apply as when the GM uses the sheet or the chat card. Every result reports LeP/AsP/KaP before and after, the maximum, the armor used and the conditions DSA5 added, removed or changed (e.g. pain levels, incapacitated). An unlinked token is addressed by its token id; the change lands on that token only.

- `damage` with `messageId` applies the damage of an opposed test from its result card by running the card's own context menu entry: `armor: true` (default) is "apply damage as TP" (TP minus the RS DSA5 computed for the defender), `armor: false` is "apply damage as SP". The id of an attack or defense card linked to exactly one result works too; a still pending test, a test the defender won and an already applied card are refused. `dsa5-roll-check` attack, parry and dodge results that are part of an opposed test now include an `opposed` block with the state (pending/resolved), the winner, the damage (rolled TP, RS, after armor) and the result card id. A damage card (trap, plain dice roll) is applied to `actor`, or to its speaker.
- `damage` with `actor` and `amount` (a number or a dice formula) applies damage directly; with armor the target's RS (`Actordsa5.armorValue`) is subtracted, as DSA5 does for damage cards.
- `heal` restores LeP (`Actor#applyDamage` with a negative amount) or, with `resource`, AsP/KaP (`Actor#applyMana`); DSA5 caps both at the maximum.
- `spend` pays AsP/KaP with `Actor#applyMana`, which refuses when the actor has too few.
- `pay-cost` pays the cost of a spell, ritual, liturgy or ceremony card with the card's "Pay AsP/KaP" entry (which also starts tracking maintained spells). An insufficient pool is refused before the system is called, because DSA5 marks the card as paid even when the payment fails.
- `regenerate` rolls the regeneration test (`setupRegeneration` + `basicTest`, as the sheet's button) with the dialog's inputs as parameters (`campsite`, `interruption`, `badEnvironment`, `modifier`, `resources`) and applies the card with `RegenerationHelper`; `apply: false` only rolls, and `messageId` applies a rolled card.

Limitations:

1. The chat card actions are not exported by the system bundle; the bridge collects them from the `getChatMessageContextOptions` hook DSA5 uses to build the chat context menu and identifies them by their visibility check (`canHurt`, `canHurtSP`, `canCostMana`). If a future DSA5 version renames those, the tool reports that the action is unavailable instead of guessing.
2. With charged power sources (Kraftspeicher) DSA5 asks in a dialog how to split an AsP cost. `pay-cost` refuses then (pay from the card in Foundry); `spend` pays from the actor's own AsP only.
3. A negative regeneration result needs a confirmation in DSA5; as when it is declined, negative values are treated as 0.
4. Regeneration special abilities that are dialog checkboxes (e.g. the fixed-die options) and homunculus blood baths are not offered.
5. Dependent conditions (incapacitated at pain level IV) are added by the system shortly after the LeP change; the report waits up to about a second for them.

## Actor Creation Defaults

DSA5 adds its per-actor defaults in the static `Actordsa5.create`: all skills and combat skills from the skills compendium, the coin items, 0 fate points for non-heroes and a starting LeP of 16. Foundry's core `Actor.create` / `Actor.createDocuments` never call that override, so the module (`packages/foundry-module/src/dsa5-actor-create.ts`) creates each actor through `CONFIG.Actor.documentClass.create` instead. This is used by `manage-actors` (`action: "create"`) and by `import-dsa5-actor-from-json` for mapped formats (not for raw Foundry exports, which are taken as-is like Foundry's own JSON import).

- `Actordsa5.create` skips every default once `items` is present, so caller items are added after creation. An item of type `skill`, `combatskill` or `money` whose name matches a default (case-insensitive) updates that default instead of adding a duplicate; the caller's fields win.
- The system's fixed 16 LeP only fit an unmodified hero. Unless `system.status.wounds.value` is given (an explicit value, even 0, is kept), the stored LeP of characters, NPCs and creatures are set to the derived maximum, which depends on KO, `wounds.initial` and items. AsP and KaP are left alone, as the system does not set them for new actors either.
- Group, vehicle and merchant/loot types go through the same system path and get exactly what the system gives them.
- `create-actor-from-compendium` and `create-dsa5-character-from-archetype` copy a compendium actor with its items, which matches what the system does for an actor created with items; they are unchanged.

## Combat View in `get-character`

Rüstungsschutz, Belastung and the AT / PA / FK and damage of each weapon are derived when the character sheet renders; the actor stores only the parts (`system.totalArmor` is just the bonus from effects). The bridge module therefore computes them in Foundry with the system's own code (`packages/foundry-module/src/dsa5-combat.ts`) and sends them as `dsa5Combat`, which `combat.ts` shapes for the response:

- `actor.prepareSheet()` — the worn melee weapons (incl. shield parry, off-hand modifiers, damage over the Schadensschwelle), worn ranged weapons with the loaded ammunition, a creature's natural attacks (`trait` items of type meleeAttack / rangeAttack), worn armor and Raufen values.
- `Actordsa5.armorValue(actor)` — total Rüstungsschutz as damage application uses it (also counts creature armor traits).
- `system.condition.encumbered` / `system.armorEncumbrance` — the active Belastung level and the part caused by armor.
- `DSA5Payment._actorsMoney(actor)` — the currency total in Silbertaler (Mammon is not counted) and the coins carried.

`get-character` then reports `stats.armor`, `stats.encumbrance`, `stats.combat` (`armor`, `encumbrance`, `meleeWeapons`, `rangedWeapons`, `naturalAttacks`, `brawling`) and `stats.money`; `basicInfo` repeats Rüstungsschutz and Belastung. The values are what the sheet shows, before situational roll modifiers (Belastung, Schmerz and other conditions are applied when rolling). Character, NPC and creature actors only. With an older bridge module only Rüstungsschutz is estimated from the worn armor items. `search-character-items` reads `system.worn.value` as `equipped` and `system.quantity.value` as `quantity`, and its `equipped` category returns only worn weapons, armor and wearable equipment.

## Integration Points

The DSA5 adapter is registered in two places:

1. **MCP Server** (`backend.ts`):

   ```typescript
   const { DSA5Adapter } = await import('./systems/dsa5/adapter.js');
   systemRegistry.register(new DSA5Adapter());
   ```

2. **Foundry Module** (browser context - future integration):
   ```typescript
   const { DSA5IndexBuilder } = await import('./systems/dsa5/index-builder.js');
   indexBuilderRegistry.register(new DSA5IndexBuilder());
   ```

## Testing

Unit tests are provided in `filters.test.ts`:

```bash
npm test -- filters.test.ts
```

## Localization

The DSA5 adapter provides German UI text by default:

- "DSA5 Kreaturen-Index wird erstellt..."
- "Erfahrungsgrad: Erfahren (Experienced)"
- German attribute names with English translations

## Known Limitations

1. **Wounds Field Change:** In v0.6.1, `system.status.wounds.value` is used directly (not inverted). Previous versions used inversion logic.
2. **Career vs Profession:** DSA5 uses `system.details.career.value`, not `profession`
3. **Creature index:** DSA5 has no level or challenge rating for creatures; filter by creature class, size and Lebensenergie instead (see Creature Discovery above)

## Contributing

When extending DSA5 support:

1. Add new filter fields to `DSA5FiltersSchema` in `filters.ts`
2. Update `matchesDSA5Filters()` logic
3. Add corresponding fields to `DSA5CreatureIndex` in `types.ts`
4. Update `extractCreatureData()` in `index-builder.ts`
5. Add unit tests

## Version History

- **v0.6.1** (2025-11-27): Initial DSA5 adapter for Registry Pattern
  - SystemAdapter + IndexBuilder implementation
  - Experience Level 1-7 support
  - Full filter system with 6 filter types
  - 1,248 lines of code across 6 files

## License

Same as parent project (foundry-vtt-mcp)

## References

- [DSA5 Foundry System](https://foundryvtt.com/packages/dsa5)
- [Registry Pattern Design Doc](../../docs/registry-pattern.md) (if exists)
- [GitHub Issue #11](https://github.com/adambdooley/foundry-vtt-mcp/issues/11) - Multi-system support discussion
