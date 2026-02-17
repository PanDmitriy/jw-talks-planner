/**
 * Планировщик уведомлений:
 * - За 7 дней до речи — просьба подтвердить докладчика
 * - За 12 часов до речи — напоминание (при отсутствии времени в БД — за 1 день до)
 */

import type { Telegraf } from 'telegraf';
import type { DatabaseInstance } from '../db';
import { talksRepo, congregationsRepo, notificationsRepo } from '../db';

const NOTIFY_7_DAYS = '7days';
const NOTIFY_12_HOURS = '12hours';

function addDays(date: Date, days: number): string {
  const d = new Date(date);
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}

/**
 * Возвращает ID пользователей, имеющих доступ к общине
 */
async function getUserIdsForCongregation(db: DatabaseInstance, congregationId: number): Promise<number[]> {
  const result = await db.query(
    'SELECT user_id FROM user_congregations WHERE congregation_id = $1',
    [congregationId]
  );
  return result.rows.map((r: { user_id: number }) => r.user_id);
}

export function startScheduler(bot: Telegraf, db: DatabaseInstance, intervalMs: number = 60 * 60 * 1000): NodeJS.Timeout {
  const talks = talksRepo(db);
  const congRepo = congregationsRepo(db);
  const notifRepo = notificationsRepo(db);

  async function run() {
    const today = addDays(new Date(), 0);
    const in7Days = addDays(new Date(), 7);
    const tomorrow = addDays(new Date(), 1);

    // Уведомление «за 7 дней»
    const talksIn7Days = await talks.listUpcoming(in7Days, in7Days);
    for (const talk of talksIn7Days) {
      if (await notifRepo.wasSent(talk.id, NOTIFY_7_DAYS)) continue;
      const cong = await congRepo.getById(talk.congregation_id);
      const name = cong?.name ?? 'Община';
      const userIds = await getUserIdsForCongregation(db, talk.congregation_id);
      const songDisplay = talk.song_number === 0 ? '?' : talk.song_number;
      const text =
        `📅 Напоминание (через 7 дней)\n\n` +
        `Дата: ${talk.date}\n` +
        `Песня ${songDisplay}, Речь №${talk.talk_number}\n` +
        `«${talk.title}»\n` +
        `Докладчик: ${talk.speaker_name}, тел. ${talk.speaker_phone}\n` +
        `Община: ${name}\n\n` +
        `Пожалуйста, подтвердите, что докладчик согласен выступить.`;
      for (const userId of userIds) {
        try {
          await bot.telegram.sendMessage(userId, text);
        } catch (e) {
          // пользователь мог заблокировать бота
        }
      }
      await notifRepo.markSent(talk.id, NOTIFY_7_DAYS);
    }

    // Уведомление «за 12 часов» — трактуем как за 1 день (накануне)
    const talksTomorrow = await talks.listUpcoming(tomorrow, tomorrow);
    for (const talk of talksTomorrow) {
      if (await notifRepo.wasSent(talk.id, NOTIFY_12_HOURS)) continue;
      const cong = await congRepo.getById(talk.congregation_id);
      const name = cong?.name ?? 'Община';
      const userIds = await getUserIdsForCongregation(db, talk.congregation_id);
      const songDisplay = talk.song_number === 0 ? '?' : talk.song_number;
      const text =
        `⏰ Напоминание: завтра речь\n\n` +
        `Дата: ${talk.date}\n` +
        `Песня ${songDisplay}, Речь №${talk.talk_number}\n` +
        `«${talk.title}»\n` +
        `Докладчик: ${talk.speaker_name}, тел. ${talk.speaker_phone}\n` +
        `Община: ${name}`;
      for (const userId of userIds) {
        try {
          await bot.telegram.sendMessage(userId, text);
        } catch (e) {
          // пользователь мог заблокировать бота
        }
      }
      await notifRepo.markSent(talk.id, NOTIFY_12_HOURS);
    }
  }

  run();
  return setInterval(run, intervalMs);
}
