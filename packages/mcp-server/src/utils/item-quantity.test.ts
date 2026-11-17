import { describe, expect, it } from 'vitest';
import { readItemQuantity } from './item-quantity.js';

describe('readItemQuantity', () => {
  it('returns plain numbers unchanged (dnd5e, pf2e)', () => {
    expect(readItemQuantity(3)).toBe(3);
    expect(readItemQuantity(0)).toBe(0);
  });

  it('unwraps the { value } shape (DSA5, WFRP4e)', () => {
    expect(readItemQuantity({ value: 1 })).toBe(1);
    expect(readItemQuantity({ value: 20 })).toBe(20);
    expect(readItemQuantity({ value: 0 })).toBe(0);
  });

  it('accepts numeric strings', () => {
    expect(readItemQuantity('5')).toBe(5);
    expect(readItemQuantity({ value: '7' })).toBe(7);
  });

  it('returns undefined for missing or unusable values', () => {
    expect(readItemQuantity(undefined)).toBeUndefined();
    expect(readItemQuantity(null)).toBeUndefined();
    expect(readItemQuantity({})).toBeUndefined();
    expect(readItemQuantity({ value: null })).toBeUndefined();
    expect(readItemQuantity('')).toBeUndefined();
    expect(readItemQuantity('many')).toBeUndefined();
  });
});
