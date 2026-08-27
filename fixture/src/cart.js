/**
 * Cart pricing.
 *
 * All money is handled in minor units (pence) as integers. Floating-point
 * pounds are how you end up billing someone £19.999999.
 */

const DISCOUNTS = {
  WELCOME10: { type: 'percent', value: 10 },
  FIVERFF: { type: 'fixed', value: 500 },
};

/** Price of a single line, in pence. */
export function lineTotal(item) {
  return item.price * item.quantity;
}

/** Sum of every line in the cart, in pence. */
export function subtotal(items) {
  return items.reduce((sum, item) => sum + lineTotal(item), 0);
}

/** Apply a discount code to a subtotal. Unknown codes are ignored. */
export function applyDiscount(amount, code) {
  const discount = DISCOUNTS[code];
  if (!discount) return amount;

  const reduced =
    discount.type === 'percent'
      ? amount - Math.round((amount * discount.value) / 100)
      : amount - discount.value;

  return Math.max(0, reduced);
}

/** Delivery is free once the order is big enough to be worth it. */
export function deliveryFor(amount) {
  return amount >= 5000 ? 0 : 499;
}

/**
 * Price a whole cart.
 *
 * Returns the subtotal, the discount applied, delivery, and the final total -
 * everything the checkout page needs to render a receipt.
 */
export function quote(cart) {
  const items = cart.items;

  const sub = subtotal(items);
  const discounted = applyDiscount(sub, cart.discountCode);
  const delivery = deliveryFor(discounted);

  return {
    currency: cart.currency ?? 'GBP',
    itemCount: items.length,
    subtotal: sub,
    discount: sub - discounted,
    delivery,
    total: discounted + delivery,
  };
}
