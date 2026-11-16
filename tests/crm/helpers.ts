import express, { type Router } from 'express';
import { IncomingMessage, ServerResponse } from 'node:http';
import { Socket } from 'node:net';
import { ZodError } from 'zod';
import { AppError } from '../../src/utils/AppError';

export async function request(
  router: Router,
  options: {
    method?: string;
    url?: string;
    body?: unknown;
    headers?: Record<string, string>;
    extra?: Record<string, unknown>;
  } = {},
) {
  const req = new IncomingMessage(new Socket());
  req.method = options.method ?? 'POST';
  req.url = options.url ?? '/';
  req.headers = options.headers ?? {};
  Object.assign(req, {
    body: options.body,
    rawBody: Buffer.from(JSON.stringify(options.body ?? {})),
    ...options.extra,
  });
  const res = new ServerResponse(req);
  const app = express();
  app.use(router);
  app.use((error: unknown, _req: unknown, response: express.Response, _next: unknown) => {
    response
      .status(error instanceof ZodError ? 400 : error instanceof AppError ? error.statusCode : 500)
      .json({ code: error instanceof AppError ? error.code : 'VALIDATION_ERROR' });
  });
  return new Promise<{ status: number; body: any }>((resolve, reject) => {
    res.end = ((body?: any) => {
      resolve({ status: res.statusCode, body: body ? JSON.parse(String(body)) : null });
      return res;
    }) as typeof res.end;
    app(req, res, reject);
  });
}

export function documentMock(state: { records: Map<string, any>; tail: Promise<unknown> }) {
  const key = (ref: any) => `${ref.table}/${ref.id}`;
  const snapshot = (ref: any) => ({
    id: ref.id,
    key: ref,
    exists: state.records.has(key(ref)),
    data: structuredClone(state.records.get(key(ref))),
  });
  const apply = (ref: any, patch: any, replace = false) => {
    const row = replace ? {} : structuredClone(state.records.get(key(ref)) ?? {});
    for (const [path, value] of Object.entries(patch)) {
      const parts = path.split('.');
      let target = row;
      for (const part of parts.slice(0, -1)) target = target[part] ??= {};
      target[parts.at(-1)!] = value;
    }
    state.records.set(key(ref), row);
  };
  return {
    queryTable: (table: string) => ({ table }),
    documentKey: (query: any, id: string) => ({
      table: typeof query === 'string' ? query : query.table,
      id,
    }),
    filterQuery: (query: any, field: string, op: string, value: unknown) => ({
      ...query,
      filters: [...(query.filters ?? []), { field, op, value }],
    }),
    orderQuery: (query: any) => query,
    limitQuery: (query: any) => query,
    Timestamp: { fromMillis: (n: number) => n },
    patchValue: { increment: (n: number) => n },
    saveDocument: async (ref: any, patch: any) => apply(ref, patch),
    readDocument: async (ref: any) => {
      if (ref.id) return snapshot(ref);
      const rows = [...state.records.entries()]
        .filter(
          ([id, data]) =>
            id.startsWith(`${ref.table}/`) &&
            (ref.filters ?? []).every((f: any) =>
              f.op === '=='
                ? data[f.field] === f.value
                : f.op === '<='
                  ? data[f.field] <= f.value
                  : true,
            ),
        )
        .map(([id]) => snapshot({ table: ref.table, id: id.slice(ref.table.length + 1) }));
      return { rows, empty: !rows.length, size: rows.length };
    },
    runSqlTransaction: (work: (tx: any) => Promise<any>) => {
      const result = state.tail.then(async () => {
        const writes: Array<() => void> = [];
        const result = await work({
          read: async (ref: any) => {
            if (writes.length) throw new Error('Read after write');
            return snapshot(ref);
          },
          insert: (ref: any, data: any) =>
            writes.push(() => {
              if (state.records.has(key(ref))) throw new Error('Duplicate insert');
              apply(ref, data, true);
            }),
          patch: (ref: any, patch: any) => writes.push(() => apply(ref, patch)),
          save: (ref: any, patch: any, options?: any) =>
            writes.push(() => apply(ref, patch, !options?.merge)),
          remove: (ref: any) => writes.push(() => state.records.delete(key(ref))),
        });
        writes.forEach((write) => write());
        return result;
      });
      state.tail = result.catch(() => undefined);
      return result;
    },
  };
}
