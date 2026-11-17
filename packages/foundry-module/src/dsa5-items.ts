/**
 * DSA5 item fields for search-character-items.
 *
 * DSA5 stores the quantity as `system.quantity.value` and whether an item is worn / wielded
 * as `system.worn.value`; it has no `equipped` field. Its equipment item types also differ
 * from the dnd5e / PF2e ones the generic search knows.
 */

/** The system's equipment item types (DSA5.equipmentCategories) plus coins. */
export const DSA5_EQUIPMENT_TYPES = new Set([
  'meleeweapon',
  'rangeweapon',
  'equipment',
  'ammunition',
  'armor',
  'poison',
  'consumable',
  'plant',
  'book',
  'money',
]);

/**
 * Quantity and worn state of a DSA5 equipment item, or undefined for other item types.
 * `equipped` is only set for items that can be worn: weapons, armor and wearable equipment.
 */
export function dsa5EquipmentFields(
  item: any
): { quantity: number; equipped?: boolean } | undefined {
  if (!DSA5_EQUIPMENT_TYPES.has(item?.type)) return undefined;
  const system = item.system ?? {};
  const rawQuantity = system.quantity?.value ?? system.quantity;
  const quantity =
    typeof rawQuantity === 'number' && Number.isFinite(rawQuantity) ? rawQuantity : 1;

  const wearable =
    ['meleeweapon', 'rangeweapon', 'armor'].includes(item.type) ||
    (item.type === 'equipment' && system.worn?.wearable === true);
  return wearable ? { quantity, equipped: system.worn?.value === true } : { quantity };
}
