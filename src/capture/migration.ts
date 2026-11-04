import { sql, type Kysely } from 'kysely';
import { IKPU_SEEDS } from './seeds';

/** DDL only. Importing this module must never load application env or credentials. */
export async function migrateCapture(db: Kysely<any>): Promise<void> {
  await sql`CREATE TABLE IF NOT EXISTS merchants (
    tin VARCHAR(14) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY,
    name VARCHAR(255) NULL, address VARCHAR(500) NULL, oked VARCHAR(32) NULL,
    seen_count BIGINT UNSIGNED NOT NULL DEFAULT 0, first_seen BIGINT NOT NULL,
    last_seen BIGINT NOT NULL, status VARCHAR(16) NOT NULL DEFAULT 'unknown',
    standard_key VARCHAR(64) NULL
  ) ENGINE=InnoDB`.execute(db);
  await sql`CREATE TABLE IF NOT EXISTS merchant_category_votes (
    tin VARCHAR(14) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    standard_key VARCHAR(64) NOT NULL, weight_sum DECIMAL(14,2) NOT NULL DEFAULT 0,
    voter_count INT UNSIGNED NOT NULL DEFAULT 0, ai_weight DECIMAL(14,2) NOT NULL DEFAULT 0,
    PRIMARY KEY (tin, standard_key)
  ) ENGINE=InnoDB`.execute(db);
  await sql`CREATE TABLE IF NOT EXISTS merchant_latest_votes (
    tin VARCHAR(14) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    voter_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    standard_key VARCHAR(64) NOT NULL, weight DECIMAL(4,2) NOT NULL,
    updated_at BIGINT NOT NULL, PRIMARY KEY (tin, voter_hash)
  ) ENGINE=InnoDB`.execute(db);
  await sql`CREATE TABLE IF NOT EXISTS merchant_user_category (
    uid VARBINARY(512) NOT NULL, tin VARCHAR(14) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    category_id VARBINARY(2048) NOT NULL, updated_at BIGINT NOT NULL,
    PRIMARY KEY (uid, tin)
  ) ENGINE=InnoDB`.execute(db);
  await sql`CREATE TABLE IF NOT EXISTS ikpu_category_map (
    prefix VARCHAR(17) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY,
    standard_key VARCHAR(64) NULL, source VARCHAR(16) NOT NULL,
    updated_at BIGINT NOT NULL
  ) ENGINE=InnoDB`.execute(db);
  await sql`CREATE TABLE IF NOT EXISTS capture_usage (
    uid VARBINARY(512) NOT NULL, month CHAR(7) CHARACTER SET ascii NOT NULL,
    count INT UNSIGNED NOT NULL DEFAULT 0, PRIMARY KEY (uid, month)
  ) ENGINE=InnoDB`.execute(db);
  await sql`CREATE TABLE IF NOT EXISTS capture_receipt_cache (
    receipt_key CHAR(64) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY,
    receipt_json JSON NOT NULL, expires_at BIGINT NOT NULL,
    INDEX capture_cache_expiry (expires_at)
  ) ENGINE=InnoDB`.execute(db);
  await sql`CREATE TABLE IF NOT EXISTS capture_learning (
    transaction_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY,
    learned_at BIGINT NOT NULL
  ) ENGINE=InnoDB`.execute(db);
  await sql`CREATE TABLE IF NOT EXISTS capture_owner_summary (
    week CHAR(10) CHARACTER SET ascii NOT NULL,
    owner_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    claimed_at BIGINT NOT NULL, PRIMARY KEY (week, owner_hash)
  ) ENGINE=InnoDB`.execute(db);
  const columns = await sql<{ COLUMN_NAME: string }>`SELECT COLUMN_NAME FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'transactions' AND COLUMN_NAME = 'capture_receipt_key'`.execute(db);
  if (!columns.rows.length) {
    // Generated from JSON so old writers and buffered document writes cannot erase the projection.
    await sql`ALTER TABLE transactions ADD COLUMN capture_receipt_key VARCHAR(64)
      CHARACTER SET ascii COLLATE ascii_bin GENERATED ALWAYS AS (
        CASE WHEN JSON_TYPE(JSON_EXTRACT(data_json, '$.capture.receiptKey')) = 'STRING'
          THEN LEFT(JSON_UNQUOTE(JSON_EXTRACT(data_json, '$.capture.receiptKey')), 64)
          ELSE NULL END
      ) STORED`.execute(db);
  }
  const indexes = await sql<{ INDEX_NAME: string }>`SELECT INDEX_NAME FROM information_schema.STATISTICS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'transactions' AND INDEX_NAME = 'capture_owner_receipt'`.execute(db);
  if (!indexes.rows.length) {
    // user_id is VARBINARY(2048); the prefix keeps the composite below MySQL's 3072-byte limit.
    await sql`CREATE INDEX capture_owner_receipt ON transactions (user_id(512), capture_receipt_key)`.execute(db);
  }
  for (const seed of IKPU_SEEDS) {
    await sql`INSERT IGNORE INTO ikpu_category_map (prefix, standard_key, source, updated_at)
      VALUES (${seed.prefix}, ${seed.standardKey}, 'seed', ${Date.now()})`.execute(db);
  }
}
