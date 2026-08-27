/**
 * Sentry has to be initialised before anything else is imported, which is why
 * this lives in its own file and is loaded with `node --import ./instrument.js`.
 *
 * With no DSN set the SDK stays inert, so the service still runs locally for
 * anyone who has not wired up Sentry yet.
 */
import * as Sentry from '@sentry/node';

const dsn = process.env.SENTRY_DSN;

if (dsn) {
  Sentry.init({
    dsn,
    environment: process.env.NODE_ENV ?? 'development',
    // Tag every event with a release so a Sentry issue can say which deploy
    // introduced it - the agent reads this in stage 1.
    release: process.env.SENTRY_RELEASE ?? 'cart-service@1.0.0',
    tracesSampleRate: 1.0,
    sendDefaultPii: false,
  });
} else {
  console.warn('SENTRY_DSN not set - errors will not be reported to Sentry.');
}
