import express from 'express';
import * as Sentry from '@sentry/node';

import { quote } from './cart.js';

const PRODUCTS = [
  { sku: 'TEA-001', name: 'Assam loose leaf, 250g', price: 899 },
  { sku: 'MUG-014', name: 'Stoneware mug', price: 1450 },
  { sku: 'POT-002', name: 'Cast iron teapot', price: 4200 },
];

export function createApp() {
  const app = express();
  app.use(express.json());

  app.get('/health', (_req, res) => {
    res.json({ status: 'ok' });
  });

  app.get('/products', (_req, res) => {
    res.json({ products: PRODUCTS });
  });

  /**
   * Price a cart.
   *
   *   POST /cart/quote
   *   { "items": [{ "sku": "TEA-001", "price": 899, "quantity": 2 }],
   *     "discountCode": "WELCOME10" }
   */
  app.post('/cart/quote', (req, res) => {
    res.json(quote(req.body));
  });

  // Reports anything the routes throw to Sentry, then falls through to the
  // handler below. Must sit after the routes.
  Sentry.setupExpressErrorHandler(app);

  app.use((error, _req, res, _next) => {
    console.error(error);
    res.status(500).json({ error: 'Internal Server Error' });
  });

  return app;
}

// Only listen when run directly, so the tests can import the app.
if (process.argv[1]?.endsWith('server.js')) {
  const port = Number(process.env.PORT ?? 3000);
  createApp().listen(port, () => {
    console.log(`cart-service listening on http://localhost:${port}`);
  });
}
