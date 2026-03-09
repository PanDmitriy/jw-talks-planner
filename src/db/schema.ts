/**
 * Создание схемы базы данных PostgreSQL
 */

import { Pool } from 'pg';
import { DEFAULT_TALK_TITLES } from './defaultTalkTitles';
import { runMigrations } from './migrations';

export type DatabaseInstance = Pool;

export async function initDatabase(connectionUrl: string): Promise<DatabaseInstance> {
  const pool = new Pool({ connectionString: connectionUrl });

  await runMigrations(pool);
  for (const { number: talk_number, title } of DEFAULT_TALK_TITLES) {
    await pool.query(
      `INSERT INTO default_talk_titles (talk_number, title)
       VALUES ($1, $2)
       ON CONFLICT (talk_number) DO NOTHING`,
      [talk_number, title]
    );
  }

  return pool;
}
