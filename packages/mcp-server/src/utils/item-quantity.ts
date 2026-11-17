/**
 * Read an item's quantity as a plain number.
 *
 * Systems store it in two shapes: a number (dnd5e, pf2e) or an object with a
 * `value` field (DSA5, WFRP4e: `system.quantity.value`). Returning the raw
 * field leaks `{ value: 1 }` into tool output for the object shape.
 * Returns undefined when the item has no usable quantity.
 */
export function readItemQuantity(raw: unknown): number | undefined {
  const value = raw !== null && typeof raw === 'object' ? (raw as { value?: unknown }).value : raw;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) {
    return Number(value);
  }
  return undefined;
}
