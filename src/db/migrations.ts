import type { DatabaseInstance } from './schema';

interface Migration {
  id: string;
  statements: string[];
}

const MIGRATIONS: Migration[] = [
  {
    id: '001_base_schema',
    statements: [
      `CREATE TABLE IF NOT EXISTS default_talk_titles (
        talk_number INTEGER PRIMARY KEY,
        title TEXT NOT NULL,
        updated_at TIMESTAMPTZ DEFAULT NOW()
      );`,
      `CREATE TABLE IF NOT EXISTS congregations (
        id SERIAL PRIMARY KEY,
        name TEXT NOT NULL UNIQUE,
        meeting_weekday SMALLINT NOT NULL DEFAULT 0 CHECK (meeting_weekday BETWEEN 0 AND 6),
        meeting_time TIME NOT NULL DEFAULT '10:00',
        created_at TIMESTAMPTZ DEFAULT NOW()
      );`,
      `CREATE TABLE IF NOT EXISTS user_congregations (
        user_id BIGINT NOT NULL,
        username TEXT,
        congregation_id INTEGER NOT NULL REFERENCES congregations(id),
        granted_at TIMESTAMPTZ DEFAULT NOW(),
        PRIMARY KEY (user_id, congregation_id)
      );`,
      `CREATE TABLE IF NOT EXISTS talk_plans (
        id SERIAL PRIMARY KEY,
        congregation_id INTEGER NOT NULL REFERENCES congregations(id),
        talk_number INTEGER NOT NULL,
        title TEXT NOT NULL,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE(congregation_id, talk_number)
      );`,
      `CREATE TABLE IF NOT EXISTS schedule_exceptions (
        id SERIAL PRIMARY KEY,
        congregation_id INTEGER NOT NULL REFERENCES congregations(id),
        date DATE NOT NULL,
        exception_type TEXT NOT NULL CHECK (
          exception_type IN (
            'rs_visit',
            'district_congress',
            'memorial',
            'special_talk_before_memorial',
            'bethel_speaker_visit'
          )
        ),
        note TEXT,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE(congregation_id, date)
      );`,
      `CREATE TABLE IF NOT EXISTS talks (
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
      );`,
      `CREATE TABLE IF NOT EXISTS notifications_sent (
        talk_id INTEGER NOT NULL REFERENCES talks(id) ON DELETE CASCADE,
        type TEXT NOT NULL,
        sent_at TIMESTAMPTZ DEFAULT NOW(),
        PRIMARY KEY (talk_id, type)
      );`,
    ],
  },
  {
    id: '002_hardening_and_pending_grants',
    statements: [
      `ALTER TABLE congregations ADD COLUMN IF NOT EXISTS meeting_weekday SMALLINT;`,
      `ALTER TABLE congregations ADD COLUMN IF NOT EXISTS meeting_time TIME;`,
      `UPDATE congregations SET meeting_weekday = 0 WHERE meeting_weekday IS NULL;`,
      `UPDATE congregations SET meeting_time = '10:00' WHERE meeting_time IS NULL;`,
      `ALTER TABLE congregations
        ALTER COLUMN meeting_weekday SET NOT NULL,
        ALTER COLUMN meeting_time SET NOT NULL;`,
      `ALTER TABLE schedule_exceptions DROP CONSTRAINT IF EXISTS schedule_exceptions_exception_type_check;`,
      `ALTER TABLE schedule_exceptions
        ADD CONSTRAINT schedule_exceptions_exception_type_check
        CHECK (
          exception_type IN (
            'rs_visit',
            'district_congress',
            'memorial',
            'special_talk_before_memorial',
            'bethel_speaker_visit'
          )
        );`,
      `DELETE FROM schedule_exceptions WHERE EXTRACT(DOW FROM date) NOT IN (0, 6);`,
      `CREATE TABLE IF NOT EXISTS pending_grants (
        id SERIAL PRIMARY KEY,
        username TEXT NOT NULL,
        congregation_id INTEGER NOT NULL REFERENCES congregations(id) ON DELETE CASCADE,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE (username, congregation_id)
      );`,
      `DELETE FROM talks
       WHERE id IN (
         SELECT newer.id
         FROM talks newer
         JOIN talks older
           ON newer.congregation_id = older.congregation_id
          AND newer.date = older.date
          AND newer.id > older.id
       );`,
      `ALTER TABLE talks
        ADD CONSTRAINT talks_unique_congregation_date
        UNIQUE (congregation_id, date);`,
    ],
  },
];

export async function runMigrations(db: DatabaseInstance): Promise<void> {
  await db.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  const result = await db.query('SELECT id FROM schema_migrations');
  const applied = new Set((result.rows as Array<{ id: string }>).map((row) => row.id));

  for (const migration of MIGRATIONS) {
    if (applied.has(migration.id)) continue;
    await db.query('BEGIN');
    try {
      for (const statement of migration.statements) {
        try {
          await db.query(statement);
        } catch (error) {
          const pgError = error as { code?: string; constraint?: string };
          const isDuplicateConstraint =
            statement.includes('talks_unique_congregation_date') && pgError.code === '42710';
          if (!isDuplicateConstraint) {
            throw error;
          }
        }
      }
      await db.query('INSERT INTO schema_migrations (id) VALUES ($1)', [migration.id]);
      await db.query('COMMIT');
    } catch (error) {
      await db.query('ROLLBACK');
      throw error;
    }
  }
}
