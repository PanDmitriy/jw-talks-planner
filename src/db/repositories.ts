/**
 * Репозитории для работы с таблицами SQLite
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
} from './types';

// --- Общины ---

export function congregationsRepo(db: DatabaseInstance) {
  return {
    create(name: string): number {
      const stmt = db.prepare('INSERT INTO congregations (name) VALUES (?)');
      const result = stmt.run(name);
      return result.lastInsertRowid as number;
    },
    getById(id: number): Congregation | undefined {
      return db.prepare('SELECT * FROM congregations WHERE id = ?').get(id) as Congregation | undefined;
    },
    getByName(name: string): Congregation | undefined {
      return db.prepare('SELECT * FROM congregations WHERE name = ?').get(name) as Congregation | undefined;
    },
    listAll(): Congregation[] {
      return db.prepare('SELECT * FROM congregations ORDER BY name').all() as Congregation[];
    },
    updateName(id: number, name: string): void {
      db.prepare('UPDATE congregations SET name = ? WHERE id = ?').run(name, id);
    },
  };
}

// --- Общий список названий речей по умолчанию (для всех общин, редактируемый) ---

export function defaultTalkTitlesRepo(db: DatabaseInstance) {
  return {
    listAll(): DefaultTalkTitle[] {
      return db
        .prepare('SELECT talk_number, title, updated_at FROM default_talk_titles ORDER BY talk_number')
        .all() as DefaultTalkTitle[];
    },
    getByNumber(talkNumber: number): DefaultTalkTitle | undefined {
      return db
        .prepare('SELECT talk_number, title, updated_at FROM default_talk_titles WHERE talk_number = ?')
        .get(talkNumber) as DefaultTalkTitle | undefined;
    },
    updateTitle(talkNumber: number, title: string): void {
      db.prepare(
        "UPDATE default_talk_titles SET title = ?, updated_at = datetime('now') WHERE talk_number = ?"
      ).run(title, talkNumber);
    },
  };
}

// --- План речей (номер + название по общине; переопределения над общим списком) ---

export function talkPlansRepo(db: DatabaseInstance) {
  return {
    create(congregationId: number, talkNumber: number, title: string): number {
      const stmt = db.prepare(
        'INSERT INTO talk_plans (congregation_id, talk_number, title) VALUES (?, ?, ?)'
      );
      const result = stmt.run(congregationId, talkNumber, title);
      return result.lastInsertRowid as number;
    },
    getById(id: number): TalkPlan | undefined {
      return db.prepare('SELECT * FROM talk_plans WHERE id = ?').get(id) as TalkPlan | undefined;
    },
    getByNumber(congregationId: number, talkNumber: number): TalkPlan | undefined {
      return db
        .prepare('SELECT * FROM talk_plans WHERE congregation_id = ? AND talk_number = ?')
        .get(congregationId, talkNumber) as TalkPlan | undefined;
    },
    listByCongregation(congregationId: number): TalkPlan[] {
      return db
        .prepare('SELECT * FROM talk_plans WHERE congregation_id = ? ORDER BY talk_number')
        .all(congregationId) as TalkPlan[];
    },
    updateTitle(id: number, title: string): void {
      db.prepare('UPDATE talk_plans SET title = ? WHERE id = ?').run(title, id);
    },
    delete(id: number): void {
      db.prepare('DELETE FROM talk_plans WHERE id = ?').run(id);
    },
    deleteByNumber(congregationId: number, talkNumber: number): void {
      db.prepare('DELETE FROM talk_plans WHERE congregation_id = ? AND talk_number = ?').run(
        congregationId,
        talkNumber
      );
    },
  };
}

/** Название речи по номеру из общего списка (для всех общин). */
export function getTitleForTalk(db: DatabaseInstance, talkNumber: number): string | undefined {
  const def = defaultTalkTitlesRepo(db).getByNumber(talkNumber);
  return def?.title;
}

// --- Доступ пользователей к общинам ---

export function userCongregationsRepo(db: DatabaseInstance) {
  return {
    grant(userId: number, username: string | null, congregationId: number): void {
      const stmt = db.prepare(
        'INSERT OR REPLACE INTO user_congregations (user_id, username, congregation_id, granted_at) VALUES (?, ?, ?, datetime(\'now\'))'
      );
      stmt.run(userId, username ?? null, congregationId);
    },
    getCongregationsForUser(userId: number): UserCongregation[] {
      return db
        .prepare(
          'SELECT uc.*, c.name as congregation_name FROM user_congregations uc JOIN congregations c ON c.id = uc.congregation_id WHERE uc.user_id = ?'
        )
        .all(userId) as unknown as UserCongregation[];
    },
    getCongregationIdsForUser(userId: number): number[] {
      const rows = db.prepare('SELECT congregation_id FROM user_congregations WHERE user_id = ?').all(userId) as {
        congregation_id: number;
      }[];
      return rows.map((r) => r.congregation_id);
    },
    hasAccess(userId: number, congregationId: number): boolean {
      const row = db.prepare('SELECT 1 FROM user_congregations WHERE user_id = ? AND congregation_id = ?').get(userId, congregationId);
      return !!row;
    },
  };
}

// --- Публичные речи ---

export function talksRepo(db: DatabaseInstance) {
  return {
    create(input: TalkInput): number {
      const stmt = db.prepare(`
        INSERT INTO talks (congregation_id, date, song_number, talk_number, title, speaker_name, speaker_phone)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `);
      const result = stmt.run(
        input.congregation_id,
        input.date,
        input.song_number,
        input.talk_number,
        input.title,
        input.speaker_name,
        input.speaker_phone
      );
      return result.lastInsertRowid as number;
    },
    update(id: number, input: Partial<TalkInput>): void {
      const fields: string[] = [];
      const values: unknown[] = [];
      if (input.date !== undefined) {
        fields.push('date = ?');
        values.push(input.date);
      }
      if (input.song_number !== undefined) {
        fields.push('song_number = ?');
        values.push(input.song_number);
      }
      if (input.talk_number !== undefined) {
        fields.push('talk_number = ?');
        values.push(input.talk_number);
      }
      if (input.title !== undefined) {
        fields.push('title = ?');
        values.push(input.title);
      }
      if (input.speaker_name !== undefined) {
        fields.push('speaker_name = ?');
        values.push(input.speaker_name);
      }
      if (input.speaker_phone !== undefined) {
        fields.push('speaker_phone = ?');
        values.push(input.speaker_phone);
      }
      if (fields.length === 0) return;
      fields.push("updated_at = datetime('now')");
      values.push(id);
      const sql = `UPDATE talks SET ${fields.join(', ')} WHERE id = ?`;
      db.prepare(sql).run(...values);
    },
    delete(id: number): void {
      db.prepare('DELETE FROM talks WHERE id = ?').run(id);
      db.prepare('DELETE FROM notifications_sent WHERE talk_id = ?').run(id);
    },
    getById(id: number): Talk | undefined {
      return db.prepare('SELECT * FROM talks WHERE id = ?').get(id) as Talk | undefined;
    },
    listByCongregation(congregationId: number, options?: { fromDate?: string; toDate?: string }): Talk[] {
      let sql = 'SELECT * FROM talks WHERE congregation_id = ?';
      const params: (number | string)[] = [congregationId];
      if (options?.fromDate) {
        sql += ' AND date >= ?';
        params.push(options.fromDate);
      }
      if (options?.toDate) {
        sql += ' AND date <= ?';
        params.push(options.toDate);
      }
      sql += ' ORDER BY date, id';
      return db.prepare(sql).all(...params) as Talk[];
    },
    /** Список предстоящих речей (для уведомлений) */
    listUpcoming(fromDate: string, toDate: string): Talk[] {
      return db
        .prepare('SELECT * FROM talks WHERE date >= ? AND date <= ? ORDER BY date')
        .all(fromDate, toDate) as Talk[];
    },
    /** Все предстоящие речи по общине (дата >= сегодня) */
    listUpcomingByCongregation(congregationId: number, fromDate: string): Talk[] {
      return db
        .prepare('SELECT * FROM talks WHERE congregation_id = ? AND date >= ? ORDER BY date')
        .all(congregationId, fromDate) as Talk[];
    },
  };
}

// --- Статистика (по прошедшим речам, date <= сегодня) ---

export function getTalkStats(db: DatabaseInstance, congregationId: number): TalkStats[] {
  const today = new Date().toISOString().slice(0, 10);
  const rows = db
    .prepare(
      `
    SELECT talk_number, title,
           COUNT(*) as total_count,
           MAX(date) as last_date
    FROM talks
    WHERE congregation_id = ? AND date <= ?
    GROUP BY talk_number, title
    ORDER BY talk_number
  `
    )
    .all(congregationId, today) as (TalkStats & { last_date: string })[];

  return rows.map((r) => {
    let last_speaker: string | null = null;
    if (r.last_date) {
      const last = db
        .prepare(
          'SELECT speaker_name FROM talks WHERE congregation_id = ? AND date <= ? AND talk_number = ? AND title = ? ORDER BY date DESC LIMIT 1'
        )
        .get(congregationId, today, r.talk_number, r.title) as { speaker_name: string } | undefined;
      last_speaker = last?.speaker_name ?? null;
    }
    return {
      talk_id: 0,
      talk_number: r.talk_number,
      title: r.title,
      total_count: r.total_count,
      last_date: r.last_date ?? null,
      last_speaker,
    };
  });
}

export function getSpeakerStats(db: DatabaseInstance, congregationId: number): SpeakerStats[] {
  const today = new Date().toISOString().slice(0, 10);
  return db
    .prepare(
      `
    SELECT speaker_name, speaker_phone, COUNT(*) as total_talks
    FROM talks
    WHERE congregation_id = ? AND date <= ?
    GROUP BY speaker_name, speaker_phone
    ORDER BY total_talks DESC
  `
    )
    .all(congregationId, today) as SpeakerStats[];
}

// --- Уведомления (чтобы не слать дважды) ---

export function notificationsRepo(db: DatabaseInstance) {
  return {
    markSent(talkId: number, type: string): void {
      db.prepare('INSERT OR REPLACE INTO notifications_sent (talk_id, type, sent_at) VALUES (?, ?, datetime(\'now\'))').run(
        talkId,
        type
      );
    },
    wasSent(talkId: number, type: string): boolean {
      const row = db.prepare('SELECT 1 FROM notifications_sent WHERE talk_id = ? AND type = ?').get(talkId, type);
      return !!row;
    },
  };
}
