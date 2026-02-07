/**
 * Создание схемы базы данных SQLite
 */

import Database from 'better-sqlite3';
import * as path from 'path';
import * as fs from 'fs';
import { DEFAULT_TALK_TITLES } from './defaultTalkTitles';

/** Тип экземпляра БД (better-sqlite3 экспортирует конструктор) */
export type DatabaseInstance = InstanceType<typeof Database>;

export function initDatabase(dbPath: string): DatabaseInstance {
  const dir = path.dirname(dbPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  const db = new Database(dbPath);

  // Общий список названий речей по умолчанию (доступен всем, можно редактировать)
  db.exec(`
    CREATE TABLE IF NOT EXISTS default_talk_titles (
      talk_number INTEGER PRIMARY KEY,
      title TEXT NOT NULL,
      updated_at TEXT DEFAULT (datetime('now'))
    );
  `);
  const countDefault = db.prepare('SELECT COUNT(*) as c FROM default_talk_titles').get() as { c: number };
  if (countDefault.c === 0) {
    const insert = db.prepare('INSERT INTO default_talk_titles (talk_number, title) VALUES (?, ?)');
    for (const { number: talk_number, title } of DEFAULT_TALK_TITLES) {
      insert.run(talk_number, title);
    }
  }

  // Общины
  db.exec(`
    CREATE TABLE IF NOT EXISTS congregations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      created_at TEXT DEFAULT (datetime('now'))
    );
  `);

  // Пользователи с доступом к общинам (user_id из Telegram)
  db.exec(`
    CREATE TABLE IF NOT EXISTS user_congregations (
      user_id INTEGER NOT NULL,
      username TEXT,
      congregation_id INTEGER NOT NULL,
      granted_at TEXT DEFAULT (datetime('now')),
      PRIMARY KEY (user_id, congregation_id),
      FOREIGN KEY (congregation_id) REFERENCES congregations(id)
    );
  `);

  // План речей по общине: номер и название (для подстановки при добавлении речи)
  db.exec(`
    CREATE TABLE IF NOT EXISTS talk_plans (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      congregation_id INTEGER NOT NULL,
      talk_number INTEGER NOT NULL,
      title TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now')),
      UNIQUE(congregation_id, talk_number),
      FOREIGN KEY (congregation_id) REFERENCES congregations(id)
    );
  `);

  // Публичные речи (запланированные и прошедшие; статистика по прошедшим)
  db.exec(`
    CREATE TABLE IF NOT EXISTS talks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      congregation_id INTEGER NOT NULL,
      date TEXT NOT NULL,
      song_number INTEGER NOT NULL,
      talk_number INTEGER NOT NULL,
      title TEXT NOT NULL,
      speaker_name TEXT NOT NULL,
      speaker_phone TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (congregation_id) REFERENCES congregations(id)
    );
  `);

  // Уведомления: 7 дней и 12 часов (чтобы не слать дважды)
  db.exec(`
    CREATE TABLE IF NOT EXISTS notifications_sent (
      talk_id INTEGER NOT NULL,
      type TEXT NOT NULL,
      sent_at TEXT DEFAULT (datetime('now')),
      PRIMARY KEY (talk_id, type),
      FOREIGN KEY (talk_id) REFERENCES talks(id)
    );
  `);

  return db;
}
