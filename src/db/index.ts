import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import Database from "better-sqlite3";
import { GatewayStorageError } from "../errors/gateway-error.js";

export interface DatabaseOptions {
  filename: string;
  busyTimeoutMs?: number;
}

export type SqliteDatabase = Database.Database;

export class GatewayDatabase {
  readonly connection: SqliteDatabase;

  constructor(options: DatabaseOptions) {
    let connection: SqliteDatabase | undefined;
    try {
      const filename = resolve(options.filename);
      mkdirSync(dirname(filename), { recursive: true });

      connection = new Database(filename);
      connection.pragma(`busy_timeout = ${options.busyTimeoutMs ?? 5_000}`);
      connection.pragma("journal_mode = WAL");
      connection.pragma("synchronous = NORMAL");
      connection.pragma("foreign_keys = ON");

      connection.exec(`
        CREATE TABLE IF NOT EXISTS token_usage (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          tenant_id TEXT NOT NULL,
          token_count INTEGER NOT NULL CHECK (token_count > 0),
          timestamp_ms INTEGER NOT NULL
        );

        CREATE INDEX IF NOT EXISTS idx_token_usage_tenant_timestamp
          ON token_usage (tenant_id, timestamp_ms);
      `);
      this.connection = connection;
    } catch {
      if (connection?.open) connection.close();
      throw new GatewayStorageError();
    }
  }

  close(): void {
    if (this.connection.open) {
      this.connection.close();
    }
  }
}

export function createGatewayDatabase(options: DatabaseOptions): GatewayDatabase {
  return new GatewayDatabase(options);
}
