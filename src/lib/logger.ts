import { pino } from 'pino';

export const logger = pino({
  level: process.env.LOG_LEVEL ?? 'info',
  redact: ['req.headers["x-webhook-token"]', 'req.headers.authorization', '*.apikey', '*.base64'],
  ...(process.env.NODE_ENV === 'production'
    ? {}
    : { transport: { target: 'pino-pretty', options: { singleLine: true } } }),
});
