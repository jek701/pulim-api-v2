import { randomUUID } from 'node:crypto';
import pinoHttp from 'pino-http';
import { logger } from '../utils/logger';

export const requestLogger = pinoHttp({
  logger,
  // Correlate logs/responses: reuse an incoming X-Request-Id or mint one.
  genReqId: (req, res) => {
    const incoming = req.headers['x-request-id'];
    const id = (typeof incoming === 'string' && incoming) || randomUUID();
    res.setHeader('X-Request-Id', id);
    return id;
  },
  // Never log credentials.
  redact: {
    paths: [
      'req.headers.authorization',
      'req.headers.cookie',
      'req.headers.x-telegram-bot-api-secret-token',
      'req.body.firebaseIdToken',
    ],
    remove: true,
  },
});
