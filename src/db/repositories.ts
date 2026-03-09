/**
 * Репозитории для работы с PostgreSQL
 */

import type { DatabaseInstance } from './schema';
import type {
  Talk,
  TalkInput,
  Congregation,
  UserCongregation,
  TalkPlan,
  TalkStats,
  SpeakerStats,
  DefaultTalkTitle,
  TalkYearMatrixRow,
  ScheduleException,
  ScheduleExceptionInput,
  ScheduleExceptionType,
  PendingGrant,
} from './types';
import { getTodayYmdUtc, toYmdString } from '../utils/date';

// --- Общины ---

export function congregationsRepo(db: DatabaseInstance) {
  return {
    async create(
      name: string,
      options?: { meeting_weekday?: number; meeting_time?: string }
    ): Promise<number> {
      const meetingWeekday = options?.meeting_weekday ?? 0;
      const meetingTime = options?.meeting_time ?? '10:00';
      const result = await db.query(
        `INSERT INTO congregations (name, meeting_weekday, meeting_time)
         VALUES ($1, $2, $3)
         RETURNING id`,
        [name, meetingWeekday, meetingTime]
      );
      return result.rows[0].id as number;
    },
    async getById(id: number): Promise<Congregation | undefined> {
      const result = await db.query('SELECT * FROM congregations WHERE id = $1', [id]);
      return result.rows[0] as Congregation | undefined;
    },
    async getByName(name: string): Promise<Congregation | undefined> {
      const result = await db.query('SELECT * FROM congregations WHERE name = $1', [name]);
      return result.rows[0] as Congregation | undefined;
    },
    async listAll(): Promise<Congregation[]> {
      const result = await db.query('SELECT * FROM congregations ORDER BY name');
      return result.rows as Congregation[];
    },
    async updateName(id: number, name: string): Promise<void> {
      await db.query('UPDATE congregations SET name = $1 WHERE id = $2', [name, id]);
    },
    async updateSchedule(id: number, meetingWeekday: number, meetingTime: string): Promise<void> {
      await db.query(
        'UPDATE congregations SET meeting_weekday = $1, meeting_time = $2 WHERE id = $3',
        [meetingWeekday, meetingTime, id]
      );
    },
  };
}

// --- Общий список названий речей по умолчанию ---

export function defaultTalkTitlesRepo(db: DatabaseInstance) {
  return {
    async listAll(): Promise<DefaultTalkTitle[]> {
      const result = await db.query(
        'SELECT talk_number, title, updated_at FROM default_talk_titles ORDER BY talk_number'
      );
      return result.rows as DefaultTalkTitle[];
    },
    async getByNumber(talkNumber: number): Promise<DefaultTalkTitle | undefined> {
      const result = await db.query(
        'SELECT talk_number, title, updated_at FROM default_talk_titles WHERE talk_number = $1',
        [talkNumber]
      );
      return result.rows[0] as DefaultTalkTitle | undefined;
    },
    async updateTitle(talkNumber: number, title: string): Promise<void> {
      await db.query(
        "UPDATE default_talk_titles SET title = $1, updated_at = NOW() WHERE talk_number = $2",
        [title, talkNumber]
      );
    },
  };
}

// --- План речей по общине ---

export function talkPlansRepo(db: DatabaseInstance) {
  return {
    async create(congregationId: number, talkNumber: number, title: string): Promise<number> {
      const result = await db.query(
        'INSERT INTO talk_plans (congregation_id, talk_number, title) VALUES ($1, $2, $3) RETURNING id',
        [congregationId, talkNumber, title]
      );
      return result.rows[0].id as number;
    },
    async upsert(congregationId: number, talkNumber: number, title: string): Promise<void> {
      const existing = await db.query(
        'SELECT id FROM talk_plans WHERE congregation_id = $1 AND talk_number = $2',
        [congregationId, talkNumber]
      );
      if (existing.rows[0]) {
        await db.query('UPDATE talk_plans SET title = $1 WHERE id = $2', [
          title,
          (existing.rows[0] as { id: number }).id,
        ]);
      } else {
        await db.query(
          'INSERT INTO talk_plans (congregation_id, talk_number, title) VALUES ($1, $2, $3)',
          [congregationId, talkNumber, title]
        );
      }
    },
    async getById(id: number): Promise<TalkPlan | undefined> {
      const result = await db.query('SELECT * FROM talk_plans WHERE id = $1', [id]);
      return result.rows[0] as TalkPlan | undefined;
    },
    async getByNumber(congregationId: number, talkNumber: number): Promise<TalkPlan | undefined> {
      const result = await db.query(
        'SELECT * FROM talk_plans WHERE congregation_id = $1 AND talk_number = $2',
        [congregationId, talkNumber]
      );
      return result.rows[0] as TalkPlan | undefined;
    },
    async listByCongregation(congregationId: number): Promise<TalkPlan[]> {
      const result = await db.query(
        'SELECT * FROM talk_plans WHERE congregation_id = $1 ORDER BY talk_number',
        [congregationId]
      );
      return result.rows as TalkPlan[];
    },
    async updateTitle(id: number, title: string): Promise<void> {
      await db.query('UPDATE talk_plans SET title = $1 WHERE id = $2', [title, id]);
    },
    async delete(id: number): Promise<void> {
      await db.query('DELETE FROM talk_plans WHERE id = $1', [id]);
    },
    async deleteByNumber(congregationId: number, talkNumber: number): Promise<void> {
      await db.query(
        'DELETE FROM talk_plans WHERE congregation_id = $1 AND talk_number = $2',
        [congregationId, talkNumber]
      );
    },
  };
}

/** Элемент объединённого списка речей по общине. */
export interface MergedPlanItem {
  talk_number: number;
  title: string;
  planId?: number;
}

/** Объединённый список: default_talk_titles с переопределениями из talk_plans. */
export async function getMergedPlansForCongregation(
  db: DatabaseInstance,
  congregationId: number
): Promise<MergedPlanItem[]> {
  const defaultList = await defaultTalkTitlesRepo(db).listAll();
  const overrides = await talkPlansRepo(db).listByCongregation(congregationId);
  const overrideMap = new Map(overrides.map((p) => [p.talk_number, { title: p.title, id: p.id }]));
  return defaultList.map((d) => {
    const ov = overrideMap.get(d.talk_number);
    return {
      talk_number: d.talk_number,
      title: ov?.title ?? d.title,
      planId: ov?.id,
    };
  });
}

/** Название речи по номеру из списка по умолчанию. */
export async function getTitleForTalk(
  db: DatabaseInstance,
  talkNumber: number
): Promise<string | undefined> {
  const def = await defaultTalkTitlesRepo(db).getByNumber(talkNumber);
  return def?.title;
}

// --- Доступ пользователей к общинам ---

export function userCongregationsRepo(db: DatabaseInstance) {
  return {
    async grant(userId: number, username: string | null, congregationId: number): Promise<void> {
      await db.query(
        `INSERT INTO user_congregations (user_id, username, congregation_id, granted_at)
         VALUES ($1, $2, $3, NOW())
         ON CONFLICT (user_id, congregation_id) DO UPDATE SET username = $2, granted_at = NOW()`,
        [userId, username ?? null, congregationId]
      );
    },
    async getCongregationsForUser(userId: number): Promise<UserCongregation[]> {
      const result = await db.query(
        `SELECT uc.user_id, uc.username, uc.congregation_id, uc.granted_at
         FROM user_congregations uc
         JOIN congregations c ON c.id = uc.congregation_id
         WHERE uc.user_id = $1`,
        [userId]
      );
      return result.rows as UserCongregation[];
    },
    async getCongregationIdsForUser(userId: number): Promise<number[]> {
      const result = await db.query(
        'SELECT congregation_id FROM user_congregations WHERE user_id = $1',
        [userId]
      );
      return result.rows.map((r: { congregation_id: number }) => r.congregation_id);
    },
    async hasAccess(userId: number, congregationId: number): Promise<boolean> {
      const result = await db.query(
        'SELECT 1 FROM user_congregations WHERE user_id = $1 AND congregation_id = $2',
        [userId, congregationId]
      );
      return result.rows.length > 0;
    },
  };
}

export function pendingGrantsRepo(db: DatabaseInstance) {
  return {
    async add(username: string, congregationId: number): Promise<void> {
      await db.query(
        `INSERT INTO pending_grants (username, congregation_id)
         VALUES ($1, $2)
         ON CONFLICT (username, congregation_id) DO NOTHING`,
        [username, congregationId]
      );
    },
    async consume(username: string): Promise<number[]> {
      const result = await db.query(
        `DELETE FROM pending_grants
         WHERE username = $1
         RETURNING congregation_id`,
        [username]
      );
      return (result.rows as Array<{ congregation_id: number }>).map((row) => row.congregation_id);
    },
    async listByUsername(username: string): Promise<PendingGrant[]> {
      const result = await db.query(
        `SELECT id, username, congregation_id, created_at
         FROM pending_grants
         WHERE username = $1
         ORDER BY created_at ASC`,
        [username]
      );
      return result.rows as PendingGrant[];
    },
  };
}

// --- Исключения по датам (выходные события) ---

export class TalkDateValidationError extends Error {
  readonly code = 'TALK_DATE_NOT_ALLOWED';
  constructor(
    public readonly date: string,
    public readonly expectedWeekday: number
  ) {
    super(`Дата ${date} не разрешена для публичной речи`);
    this.name = 'TalkDateValidationError';
  }
}

export class TalkDateBlockedByEventError extends Error {
  readonly code = 'TALK_DATE_BLOCKED_BY_EVENT';
  constructor(
    public readonly date: string,
    public readonly exceptionType: ScheduleExceptionType
  ) {
    super(`Дата ${date} занята событием ${exceptionType}`);
    this.name = 'TalkDateBlockedByEventError';
  }
}

export class TalkDateDuplicateError extends Error {
  readonly code = 'TALK_DATE_DUPLICATE';
  constructor(public readonly date: string) {
    super(`На дату ${date} уже есть запланированная публичная речь`);
    this.name = 'TalkDateDuplicateError';
  }
}

function getUtcDayOfWeek(ymd: string): number {
  const [y, m, d] = ymd.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

function toYmdUtc(date: Date): string {
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, '0');
  const d = String(date.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function getWeekendPair(ymd: string): { saturday: string; sunday: string } {
  const [year, month, day] = ymd.split('-').map(Number);
  const utc = new Date(Date.UTC(year, month - 1, day));
  const dow = utc.getUTCDay();
  const saturdayShift = dow === 6 ? 0 : dow === 0 ? -1 : -(dow + 1);
  const saturday = new Date(utc);
  saturday.setUTCDate(saturday.getUTCDate() + saturdayShift);
  const sunday = new Date(saturday);
  sunday.setUTCDate(sunday.getUTCDate() + 1);
  return { saturday: toYmdUtc(saturday), sunday: toYmdUtc(sunday) };
}

async function getBlockingWeekendEvent(
  db: DatabaseInstance,
  congregationId: number,
  date: string
): Promise<ScheduleExceptionType | null> {
  const { saturday, sunday } = getWeekendPair(date);
  const result = await db.query(
    `SELECT exception_type
     FROM schedule_exceptions
     WHERE congregation_id = $1
       AND date IN ($2, $3)
       AND exception_type IN ('district_congress', 'memorial')
     ORDER BY date
     LIMIT 1`,
    [congregationId, saturday, sunday]
  );
  const row = result.rows[0] as { exception_type: ScheduleExceptionType } | undefined;
  return row?.exception_type ?? null;
}

async function validateTalkDateOrThrow(
  db: DatabaseInstance,
  congregationId: number,
  date: string
): Promise<void> {
  const congregationResult = await db.query(
    'SELECT meeting_weekday FROM congregations WHERE id = $1',
    [congregationId]
  );
  const congregation = congregationResult.rows[0] as { meeting_weekday: number } | undefined;
  if (!congregation) {
    throw new Error(`Собрание ${congregationId} не найдено`);
  }
  const actualWeekday = getUtcDayOfWeek(date);
  if (actualWeekday !== congregation.meeting_weekday) {
    throw new TalkDateValidationError(date, congregation.meeting_weekday);
  }

  const blockedBy = await getBlockingWeekendEvent(db, congregationId, date);
  if (blockedBy) {
    throw new TalkDateBlockedByEventError(date, blockedBy);
  }
}

export function scheduleExceptionsRepo(db: DatabaseInstance) {
  return {
    async add(input: ScheduleExceptionInput): Promise<number> {
      const result = await db.query(
        `INSERT INTO schedule_exceptions (congregation_id, date, exception_type, note)
         VALUES ($1, $2, $3, $4)
         RETURNING id`,
        [input.congregation_id, input.date, input.exception_type, input.note ?? null]
      );
      return result.rows[0].id as number;
    },
    async upsert(input: ScheduleExceptionInput): Promise<void> {
      await db.query(
        `INSERT INTO schedule_exceptions (congregation_id, date, exception_type, note)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (congregation_id, date)
         DO UPDATE SET exception_type = EXCLUDED.exception_type, note = EXCLUDED.note`,
        [input.congregation_id, input.date, input.exception_type, input.note ?? null]
      );
    },
    async getByDate(congregationId: number, date: string): Promise<ScheduleException | undefined> {
      const result = await db.query(
        `SELECT
           id,
           congregation_id,
           date::text as date,
           exception_type,
           note,
           created_at::text as created_at
         FROM schedule_exceptions
         WHERE congregation_id = $1 AND date = $2`,
        [congregationId, date]
      );
      return result.rows[0] as ScheduleException | undefined;
    },
    async listByCongregation(
      congregationId: number,
      options?: { fromDate?: string; toDate?: string }
    ): Promise<ScheduleException[]> {
      let sql = `SELECT
          id,
          congregation_id,
          date::text as date,
          exception_type,
          note,
          created_at::text as created_at
        FROM schedule_exceptions
        WHERE congregation_id = $1`;
      const params: (number | string)[] = [congregationId];
      if (options?.fromDate) {
        sql += ` AND date >= $${params.length + 1}`;
        params.push(options.fromDate);
      }
      if (options?.toDate) {
        sql += ` AND date <= $${params.length + 1}`;
        params.push(options.toDate);
      }
      sql += ' ORDER BY date, id';
      const result = await db.query(sql, params);
      return result.rows as ScheduleException[];
    },
    async removeByDate(congregationId: number, date: string): Promise<boolean> {
      const result = await db.query(
        'DELETE FROM schedule_exceptions WHERE congregation_id = $1 AND date = $2',
        [congregationId, date]
      );
      return (result.rowCount ?? 0) > 0;
    },
    async removeByDates(congregationId: number, dates: string[]): Promise<number> {
      if (dates.length === 0) return 0;
      const result = await db.query(
        'DELETE FROM schedule_exceptions WHERE congregation_id = $1 AND date = ANY($2::date[])',
        [congregationId, dates]
      );
      return result.rowCount ?? 0;
    },
    async getWeekendEvents(congregationId: number, date: string): Promise<ScheduleException[]> {
      const { saturday, sunday } = getWeekendPair(date);
      const result = await db.query(
        `SELECT
           id,
           congregation_id,
           date::text as date,
           exception_type,
           note,
           created_at::text as created_at
         FROM schedule_exceptions
         WHERE congregation_id = $1
           AND date IN ($2, $3)
         ORDER BY date`,
        [congregationId, saturday, sunday]
      );
      return result.rows as ScheduleException[];
    },
  };
}

// --- Публичные речи ---

export function talksRepo(db: DatabaseInstance) {
  return {
    async create(input: TalkInput): Promise<number> {
      await validateTalkDateOrThrow(db, input.congregation_id, input.date);
      let result;
      try {
        result = await db.query(
          `INSERT INTO talks (congregation_id, date, song_number, talk_number, title, speaker_name, speaker_phone)
           VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
          [
            input.congregation_id,
            input.date,
            input.song_number,
            input.talk_number,
            input.title,
            input.speaker_name,
            input.speaker_phone,
          ]
        );
      } catch (error) {
        const pgError = error as { code?: string; constraint?: string; message?: string };
        if (pgError.code === '23505' || (pgError.message ?? '').toLowerCase().includes('duplicate')) {
          throw new TalkDateDuplicateError(input.date);
        }
        throw error;
      }
      return result.rows[0].id as number;
    },
    async update(id: number, input: Partial<TalkInput>): Promise<void> {
      if (input.date !== undefined) {
        let congregationId = input.congregation_id;
        if (congregationId === undefined) {
          const existing = await db.query('SELECT congregation_id FROM talks WHERE id = $1', [id]);
          congregationId = (existing.rows[0] as { congregation_id: number } | undefined)?.congregation_id;
        }
        if (congregationId !== undefined) {
          await validateTalkDateOrThrow(db, congregationId, input.date);
        }
      }

      const fields: string[] = [];
      const values: unknown[] = [];
      let pos = 1;
      if (input.date !== undefined) {
        fields.push(`date = $${pos++}`);
        values.push(input.date);
      }
      if (input.song_number !== undefined) {
        fields.push(`song_number = $${pos++}`);
        values.push(input.song_number);
      }
      if (input.talk_number !== undefined) {
        fields.push(`talk_number = $${pos++}`);
        values.push(input.talk_number);
      }
      if (input.title !== undefined) {
        fields.push(`title = $${pos++}`);
        values.push(input.title);
      }
      if (input.speaker_name !== undefined) {
        fields.push(`speaker_name = $${pos++}`);
        values.push(input.speaker_name);
      }
      if (input.speaker_phone !== undefined) {
        fields.push(`speaker_phone = $${pos++}`);
        values.push(input.speaker_phone);
      }
      if (fields.length === 0) return;
      fields.push('updated_at = NOW()');
      values.push(id);
      const sql = `UPDATE talks SET ${fields.join(', ')} WHERE id = $${pos}`;
      try {
        await db.query(sql, values);
      } catch (error) {
        const pgError = error as { code?: string; constraint?: string; message?: string };
        if (pgError.code === '23505' || (pgError.message ?? '').toLowerCase().includes('duplicate')) {
          throw new TalkDateDuplicateError(input.date ?? '');
        }
        throw error;
      }
    },
    async delete(id: number): Promise<void> {
      await db.query('DELETE FROM notifications_sent WHERE talk_id = $1', [id]);
      await db.query('DELETE FROM talks WHERE id = $1', [id]);
    },
    async getById(id: number): Promise<Talk | undefined> {
      const result = await db.query(
        `SELECT
           id,
           congregation_id,
           date::text as date,
           song_number,
           talk_number,
           title,
           speaker_name,
           speaker_phone,
           created_at::text as created_at,
           updated_at::text as updated_at
         FROM talks
         WHERE id = $1`,
        [id]
      );
      const row = result.rows[0];
      if (!row) return undefined;
      return row as Talk;
    },
    async listByCongregation(
      congregationId: number,
      options?: { fromDate?: string; toDate?: string }
    ): Promise<Talk[]> {
      let sql = `SELECT
        id,
        congregation_id,
        date::text as date,
        song_number,
        talk_number,
        title,
        speaker_name,
        speaker_phone,
        created_at::text as created_at,
        updated_at::text as updated_at
      FROM talks WHERE congregation_id = $1`;
      const params: (number | string)[] = [congregationId];
      if (options?.fromDate) {
        sql += ` AND date >= $${params.length + 1}`;
        params.push(options.fromDate);
      }
      if (options?.toDate) {
        sql += ` AND date <= $${params.length + 1}`;
        params.push(options.toDate);
      }
      sql += ' ORDER BY date, id';
      const result = await db.query(sql, params);
      return result.rows as Talk[];
    },
    async listUpcoming(fromDate: string, toDate: string): Promise<Talk[]> {
      const result = await db.query(
        `SELECT
           id,
           congregation_id,
           date::text as date,
           song_number,
           talk_number,
           title,
           speaker_name,
           speaker_phone,
           created_at::text as created_at,
           updated_at::text as updated_at
         FROM talks
         WHERE date >= $1 AND date <= $2
         ORDER BY date`,
        [fromDate, toDate]
      );
      return result.rows as Talk[];
    },
    async listUpcomingByCongregation(
      congregationId: number,
      fromDate: string
    ): Promise<Talk[]> {
      const result = await db.query(
        `SELECT
           id,
           congregation_id,
           date::text as date,
           song_number,
           talk_number,
           title,
           speaker_name,
           speaker_phone,
           created_at::text as created_at,
           updated_at::text as updated_at
         FROM talks
         WHERE congregation_id = $1 AND date >= $2
         ORDER BY date`,
        [congregationId, fromDate]
      );
      return result.rows as Talk[];
    },
    async listPastByNumber(congregationId: number, talkNumber: number): Promise<Talk[]> {
      const today = getTodayYmdUtc();
      const result = await db.query(
        `SELECT
           id,
           congregation_id,
           date::text as date,
           song_number,
           talk_number,
           title,
           speaker_name,
           speaker_phone,
           created_at::text as created_at,
           updated_at::text as updated_at
         FROM talks
         WHERE congregation_id = $1 AND talk_number = $2 AND date <= $3
         ORDER BY date DESC`,
        [congregationId, talkNumber, today]
      );
      return result.rows as Talk[];
    },
  };
}

// --- Статистика ---

export async function getTalkStats(
  db: DatabaseInstance,
  congregationId: number
): Promise<TalkStats[]> {
  const today = getTodayYmdUtc();
  const result = await db.query(
    `WITH grouped AS (
      SELECT
        talk_number,
        title,
        COUNT(*)::int as total_count,
        MAX(date) as last_date
      FROM talks
      WHERE congregation_id = $1 AND date <= $2
      GROUP BY talk_number, title
    ),
    latest_talk AS (
      SELECT
        t.talk_number,
        t.title,
        MAX(t.id) as last_id
      FROM talks t
      JOIN grouped g
        ON g.talk_number = t.talk_number
        AND g.title = t.title
        AND g.last_date = t.date
      WHERE t.congregation_id = $1
      GROUP BY t.talk_number, t.title
    )
    SELECT
      g.talk_number,
      g.title,
      g.total_count,
      g.last_date as last_date,
      t.speaker_name as last_speaker
    FROM grouped g
    LEFT JOIN latest_talk lt
      ON lt.talk_number = g.talk_number
      AND lt.title = g.title
    LEFT JOIN talks t
      ON t.id = lt.last_id
    ORDER BY g.talk_number`,
    [congregationId, today]
  );
  const rows = result.rows as Array<{
    talk_number: number;
    title: string;
    total_count: number;
    last_date: string | Date | null;
    last_speaker: string | null;
  }>;
  return rows.map((r) => {
    const lastDate = r.last_date ? toYmdString(r.last_date) : null;
    return {
      talk_id: 0,
      talk_number: r.talk_number,
      title: r.title,
      total_count: r.total_count,
      last_date: lastDate,
      last_speaker: r.last_speaker ?? null,
    };
  });
}

export async function getSpeakerStats(
  db: DatabaseInstance,
  congregationId: number
): Promise<SpeakerStats[]> {
  const today = getTodayYmdUtc();
  const result = await db.query(
    `SELECT speaker_name, speaker_phone, COUNT(*)::int as total_talks
     FROM talks
     WHERE congregation_id = $1 AND date <= $2
     GROUP BY speaker_name, speaker_phone
     ORDER BY total_talks DESC`,
    [congregationId, today]
  );
  return result.rows as SpeakerStats[];
}

function formatDateForMatrix(isoDate: string): string {
  const [, m, d] = isoDate.split('-').map(Number);
  const day = String(d).padStart(2, '0');
  const month = String(m).padStart(2, '0');
  return `${day}.${month}`;
}

export async function getTalkStatsByYearMatrix(
  db: DatabaseInstance,
  congregationId: number,
  options?: { fromYear?: number; toYear?: number }
): Promise<TalkYearMatrixRow[]> {
  const today = getTodayYmdUtc();
  const result = await db.query(
    'SELECT talk_number, date::text FROM talks WHERE congregation_id = $1 AND date <= $2 ORDER BY talk_number, date',
    [congregationId, today]
  );
  const rows = result.rows as { talk_number: number; date: string }[];
  const titles = await defaultTalkTitlesRepo(db).listAll();
  const fromYear = options?.fromYear ?? 2020;
  const toYear = options?.toYear ?? new Date().getFullYear() + 1;

  const byTalk: Map<number, Map<number, string[]>> = new Map();
  for (const t of titles) {
    byTalk.set(t.talk_number, new Map());
  }
  for (const r of rows) {
    const year = parseInt(r.date.slice(0, 4), 10);
    if (year < fromYear || year > toYear) continue;
    const formatted = formatDateForMatrix(r.date);
    let yearMap = byTalk.get(r.talk_number);
    if (!yearMap) {
      yearMap = new Map();
      byTalk.set(r.talk_number, yearMap);
    }
    const arr = yearMap.get(year) ?? [];
    arr.push(formatted);
    yearMap.set(year, arr);
  }

  return titles.map((t) => {
    const yearMap = byTalk.get(t.talk_number) ?? new Map();
    const datesByYear: Record<number, string> = {};
    for (let y = fromYear; y <= toYear; y++) {
      const dates = yearMap.get(y);
      if (dates?.length) datesByYear[y] = dates.join(', ');
    }
    return {
      talk_number: t.talk_number,
      title: t.title,
      datesByYear,
    };
  });
}

// --- Уведомления ---

export function notificationsRepo(db: DatabaseInstance) {
  return {
    async markSent(talkId: number, type: string): Promise<void> {
      await db.query(
        `INSERT INTO notifications_sent (talk_id, type, sent_at)
         VALUES ($1, $2, NOW())
         ON CONFLICT (talk_id, type) DO UPDATE SET sent_at = NOW()`,
        [talkId, type]
      );
    },
    async wasSent(talkId: number, type: string): Promise<boolean> {
      const result = await db.query(
        'SELECT 1 FROM notifications_sent WHERE talk_id = $1 AND type = $2',
        [talkId, type]
      );
      return result.rows.length > 0;
    },
  };
}
