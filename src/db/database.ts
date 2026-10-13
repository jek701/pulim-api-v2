import { Kysely, MysqlDialect, sql } from 'kysely';
import { createPool } from 'mysql2';

let singleton: Kysely<any> | undefined;
/** Lazy: importing pure domain helpers does not connect or load application .env. */
export function database(): Kysely<any> {
  if (singleton) return singleton;
  const { MYSQL_HOST, MYSQL_DATABASE, MYSQL_USER, MYSQL_PASSWORD } = process.env;
  if (!MYSQL_HOST || !MYSQL_DATABASE || !MYSQL_USER || MYSQL_PASSWORD === undefined) {
    throw new Error('Explicit MYSQL_HOST, MYSQL_DATABASE, MYSQL_USER, MYSQL_PASSWORD are required');
  }
  const port = Number(process.env.MYSQL_PORT || 3306);
  const connectionLimit = Number(process.env.MYSQL_CONNECTION_LIMIT || 5);
  if (
    !Number.isInteger(port) ||
    port < 1 ||
    port > 65535 ||
    !Number.isInteger(connectionLimit) ||
    connectionLimit < 1 ||
    connectionLimit > 50
  ) {
    throw new Error('Invalid MySQL port or pool limit');
  }
  singleton = new Kysely({
    dialect: new MysqlDialect({
      pool: createPool({
        host: MYSQL_HOST,
        port,
        database: MYSQL_DATABASE,
        user: MYSQL_USER,
        password: MYSQL_PASSWORD,
        connectionLimit,
        waitForConnections: true,
        queueLimit: 100,
        charset: 'utf8mb4',
        timezone: 'Z',
        supportBigNumbers: true,
        bigNumberStrings: true,
        jsonStrings: true,
        enableKeepAlive: true,
        ...(process.env.MYSQL_SSL === 'true' ? { ssl: {} } : {}),
      }),
    }),
  });
  return singleton;
}
export async function checkDatabase(): Promise<void> {
  await sql`SELECT version FROM schema_migrations WHERE version = '001_document_tables'`
    .execute(database())
    .then((result) => {
      if (result.rows.length !== 1) throw new Error('Database schema is not ready');
    });
}
export async function closeDatabase(): Promise<void> {
  const current = singleton;
  singleton = undefined;
  await current?.destroy();
}
