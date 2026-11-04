import { logger } from '../utils/logger';
const samples = new Map<string, number[]>();
export function recordPushLatency(input: {
  type: string;
  eventAt: number;
  enqueuedAt: number;
  sendAt: number;
  responseAt: number;
  status: number;
}): void {
  const values = samples.get(input.type) ?? [];
  values.push(input.responseAt - input.eventAt);
  if (values.length > 500) values.shift();
  samples.set(input.type, values);
  const sorted = [...values].sort((a, b) => a - b);
  const percentile = (p: number) => sorted[Math.max(0, Math.ceil(sorted.length * p) - 1)];
  logger.info(
    {
      type: input.type,
      status: input.status,
      eventToEnqueuedMs: input.enqueuedAt - input.eventAt,
      enqueuedToSendMs: input.sendAt - input.enqueuedAt,
      apnsResponseMs: input.responseAt - input.sendAt,
      eventToResponseMs: input.responseAt - input.eventAt,
      p50Ms: percentile(0.5),
      p95Ms: percentile(0.95),
      samples: values.length,
    },
    'notify.push.latency',
  );
}
