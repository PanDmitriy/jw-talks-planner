/**
 * Создание схемы базы данных PostgreSQL
 */

import { Pool } from 'pg';
import { DEFAULT_TALK_TITLES } from './defaultTalkTitles';

export type DatabaseInstance = Pool;

export async function initDatabase(connectionUrl: string): Promise<DatabaseInstance> {
  const pool = new Pool({ connectionString: connectionUrl });

  await pool.query(`
    CREATE TABLE IF NOT EXISTS default_talk_titles (
      talk_number INTEGER PRIMARY KEY,
      title TEXT NOT NULL,
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);

  const countResult = await pool.query('SELECT COUNT(*) as c FROM default_talk_titles');
  const count = parseInt(String(countResult.rows[0]?.c ?? 0), 10);
  if (count === 0) {
    for (const { number: talk_number, title } of DEFAULT_TALK_TITLES) {
      await pool.query(
        'INSERT INTO default_talk_titles (talk_number, title) VALUES ($1, $2)',
        [talk_number, title]
      );
    }
  }

  await pool.query(`
    CREATE TABLE IF NOT EXISTS congregations (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS user_congregations (
      user_id BIGINT NOT NULL,
      username TEXT,
      congregation_id INTEGER NOT NULL REFERENCES congregations(id),
      granted_at TIMESTAMPTZ DEFAULT NOW(),
      PRIMARY KEY (user_id, congregation_id)
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS talk_plans (
      id SERIAL PRIMARY KEY,
      congregation_id INTEGER NOT NULL REFERENCES congregations(id),
      talk_number INTEGER NOT NULL,
      title TEXT NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(congregation_id, talk_number)
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS talks (
      id SERIAL PRIMARY KEY,
      congregation_id INTEGER NOT NULL REFERENCES congregations(id),
      date DATE NOT NULL,
      song_number INTEGER NOT NULL,
      talk_number INTEGER NOT NULL,
      title TEXT NOT NULL,
      speaker_name TEXT NOT NULL,
      speaker_phone TEXT NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS notifications_sent (
      talk_id INTEGER NOT NULL REFERENCES talks(id) ON DELETE CASCADE,
      type TEXT NOT NULL,
      sent_at TIMESTAMPTZ DEFAULT NOW(),
      PRIMARY KEY (talk_id, type)
    );
  `);

  return pool;
}
