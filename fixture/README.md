# cart-service

A tiny checkout service for a tea shop. It prices a cart, applies a discount code, and works out delivery.

It also has a bug in it.

This is the service under repair for **Licence to Patch** — the on-call agent in the repository above it. The agent needs a real service, with a real test suite, throwing a real error into Sentry. That's this.

It lives inside the agent's own repository, which would normally be dangerous: the agent could rewrite the approval gate that restrains it. It cannot, because `LTP_WRITE_PATHS=fixture/**` confines every write to this directory. See [the write perimeter](../README.md#the-write-perimeter).

## Run it

```bash
cd fixture
npm install
npm start          # http://localhost:3000
npm test           # 14 tests, all passing
```

## The API

```bash
# List the catalogue
curl localhost:3000/products

# Price a cart
curl -X POST localhost:3000/cart/quote \
  -H 'Content-Type: application/json' \
  -d '{"items":[{"sku":"TEA-001","price":899,"quantity":2}],"discountCode":"WELCOME10"}'
```

```json
{
  "currency": "GBP",
  "itemCount": 1,
  "subtotal": 1798,
  "discount": 180,
  "delivery": 499,
  "total": 2117
}
```

Money is in pence, as integers, throughout.

## Reproducing the bug

A client that opens the checkout page before adding anything sends a cart with no `items` array:

```bash
curl -X POST localhost:3000/cart/quote \
  -H 'Content-Type: application/json' \
  -d '{"currency":"GBP"}'
```

```
HTTP 500

TypeError: Cannot read properties of undefined (reading 'reduce')
    at subtotal (src/cart.js:20:16)
    at quote (src/cart.js:50:15)
    at src/server.js:32:14
```

The existing test suite passes, because every test supplies an `items` array. That's exactly the shape of bug that reaches production: the happy path is covered, the missing-field path is not.

## Wiring up Sentry

```bash
cp .env.example .env     # add your SENTRY_DSN
npm start
```

Sentry is initialised in `instrument.js`, loaded via `node --import` before anything else — that ordering is required by the SDK. With no DSN set the SDK stays inert and the service still runs.

Once the DSN is set, triggering the bug above creates a Sentry issue with the stack trace, the culprit frame, and the release. Note its short ID — that is what gets handed to the agent, from the repository root:

```bash
cd ..
npm run dispatch -- CART-SERVICE-1A
```

## Layout

```
instrument.js      Sentry init, imported before the app
src/cart.js        pricing logic  ← the bug lives here
src/server.js      Express routes
src/cart.test.js   the suite the agent has to keep green
```

## Licence

MIT
