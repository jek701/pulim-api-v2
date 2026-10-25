import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * Per-request idempotency state. The `Idempotency-Key` middleware opens it; the SQL
 * transaction runner commits the key marker in the same transaction as the first
 * effect, so there is never an effect without its marker.
 */
export interface IdempotencyContext {
  uid: string;
  /** Document id of the marker (sha256 of `uid:key`). */
  markerId: string;
  key: string;
  method: string;
  path: string;
  requestHash: string;
  /** An expired marker still occupies the row: overwrite instead of insert. */
  overwrite: boolean;
  /** Set once a committed transaction carried the marker. */
  claimed: boolean;
}
export const idempotencyStorage = new AsyncLocalStorage<IdempotencyContext>();

/** Thrown by the transaction runner when the marker already exists (a concurrent or repeated request). */
export class IdempotencyConflict extends Error {
  constructor() {
    super('Idempotency key already used');
    this.name = 'IdempotencyConflict';
  }
}
