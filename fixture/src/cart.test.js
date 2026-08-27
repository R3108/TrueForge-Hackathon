import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { lineTotal, subtotal, applyDiscount, deliveryFor, quote } from './cart.js';

const items = [
  { sku: 'TEA-001', price: 899, quantity: 2 },
  { sku: 'MUG-014', price: 1450, quantity: 1 },
];

describe('lineTotal', () => {
  test('multiplies price by quantity', () => {
    assert.equal(lineTotal({ price: 899, quantity: 2 }), 1798);
  });

  test('a single unit costs its price', () => {
    assert.equal(lineTotal({ price: 1450, quantity: 1 }), 1450);
  });
});

describe('subtotal', () => {
  test('sums every line', () => {
    assert.equal(subtotal(items), 3248);
  });

  test('an empty cart costs nothing', () => {
    assert.equal(subtotal([]), 0);
  });
});

describe('applyDiscount', () => {
  test('takes a percentage off', () => {
    assert.equal(applyDiscount(3248, 'WELCOME10'), 2923);
  });

  test('takes a fixed amount off', () => {
    assert.equal(applyDiscount(3248, 'FIVERFF'), 2748);
  });

  test('ignores an unknown code', () => {
    assert.equal(applyDiscount(3248, 'NOPE'), 3248);
  });

  test('never goes below zero', () => {
    assert.equal(applyDiscount(200, 'FIVERFF'), 0);
  });
});

describe('deliveryFor', () => {
  test('charges delivery on a small order', () => {
    assert.equal(deliveryFor(3248), 499);
  });

  test('is free once the order is big enough', () => {
    assert.equal(deliveryFor(5000), 0);
  });
});

describe('quote', () => {
  test('prices a cart end to end', () => {
    const result = quote({ items, currency: 'GBP' });

    assert.deepEqual(result, {
      currency: 'GBP',
      itemCount: 2,
      subtotal: 3248,
      discount: 0,
      delivery: 499,
      total: 3747,
    });
  });

  test('applies a discount code', () => {
    const result = quote({ items, discountCode: 'WELCOME10' });

    assert.equal(result.subtotal, 3248);
    assert.equal(result.discount, 325);
    assert.equal(result.total, 3422);
  });

  test('defaults the currency to GBP', () => {
    assert.equal(quote({ items }).currency, 'GBP');
  });

  test('a big order ships free', () => {
    const result = quote({ items: [{ price: 4200, quantity: 2 }] });

    assert.equal(result.delivery, 0);
    assert.equal(result.total, 8400);
  });
});
