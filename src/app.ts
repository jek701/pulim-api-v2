import express from 'express';
import helmet from 'helmet';
import cors, { type CorsOptions } from 'cors';
import { corsOrigins, isProd } from './config/env';
import { requestLogger } from './middleware/requestContext';
import { errorHandler } from './middleware/errorHandler';
import { notFound } from './middleware/notFound';
import { mountRoutes } from './routes';

// In dev, tunnels (ngrok / cloudflare) and localhost rotate hosts/ports, so allow
// them by pattern instead of forcing CORS_ORIGINS edits on every restart.
const DEV_ORIGIN_PATTERNS = [
  /^https?:\/\/localhost(:\d+)?$/,
  /^https?:\/\/127\.0\.0\.1(:\d+)?$/,
  /\.ngrok-free\.app$/,
  /\.ngrok\.app$/,
  /\.ngrok\.io$/,
  /\.trycloudflare\.com$/,
];

function buildCorsOptions(): CorsOptions {
  return {
    credentials: false,
    origin(origin, callback) {
      // Non-browser callers (curl, server-to-server) send no Origin.
      if (!origin) return callback(null, true);
      if (corsOrigins.includes(origin)) return callback(null, true);
      if (!isProd && DEV_ORIGIN_PATTERNS.some((re) => re.test(origin))) return callback(null, true);
      // No explicit allowlist configured => allow all (dev convenience).
      if (corsOrigins.length === 0) return callback(null, true);
      return callback(null, false);
    },
  };
}

export function createApp() {
  const app = express();

  app.disable('x-powered-by');
  // Trust a single reverse proxy / load balancer (correct client IP for rate limiting).
  app.set('trust proxy', 1);
  app.use(helmet());
  app.use(cors(buildCorsOptions()));
  app.use(requestLogger);
  app.use(express.json({ limit: '1mb' }));

  mountRoutes(app);

  app.use(notFound);
  app.use(errorHandler);

  return app;
}
