import { beforeEach, describe, expect, it } from 'vitest';
import { newDb } from 'pg-mem';
import type { DatabaseInstance } from '../../src/db';
import {
  congregationsRepo,
  pendingGrantsRepo,
  scheduleExceptionsRepo,
  talksRepo,
  TalkDateBlockedByEventError,
  TalkDateDuplicateError,
  TalkDateValidationError,
  userCongregationsRepo,
  getTalkStats,
} from '../../src/db';
import { runMigrations } from '../../src/db/migrations';
import { applyPendingGrants } from '../../src/bot/middlewares/auth';

async function createTestDb(): Promise<DatabaseInstance> {
  const db = newDb();
  const adapter = db.adapters.createPg();
  const pool = new adapter.Pool();
  await runMigrations(pool as unknown as DatabaseInstance);
  return pool as unknown as DatabaseInstance;
}

describe('critical integration flow', () => {
  let db: DatabaseInstance;

  beforeEach(async () => {
    db = await createTestDb();
  });

  it('persists pending grants and applies them on /start', async () => {
    const congregations = congregationsRepo(db);
    const pending = pendingGrantsRepo(db);
    const users = userCongregationsRepo(db);
    const congregationId = await congregations.create('Центральное', {
      meeting_weekday: 0,
      meeting_time: '10:00',
    });

    await pending.add('ivan', congregationId);
    await applyPendingGrants(db, 12345, 'Ivan');

    const userCongregationIds = await users.getCongregationIdsForUser(12345);
    expect(userCongregationIds).toEqual([congregationId]);
    const pendingLeft = await pending.listByUsername('ivan');
    expect(pendingLeft).toHaveLength(0);
  });

  it('rejects adding talk for wrong meeting weekday', async () => {
    const congregations = congregationsRepo(db);
    const talks = talksRepo(db);
    const congregationId = await congregations.create('Северное', {
      meeting_weekday: 0,
      meeting_time: '10:00',
    });

    await expect(
      talks.create({
        congregation_id: congregationId,
        date: '2026-03-14',
        song_number: 1,
        talk_number: 1,
        title: 'Тест',
        speaker_name: 'Брат',
        speaker_phone: '+79990000000',
      })
    ).rejects.toBeInstanceOf(TalkDateValidationError);
  });

  it('blocks talk creation when memorial or congress is set for weekend', async () => {
    const congregations = congregationsRepo(db);
    const exceptions = scheduleExceptionsRepo(db);
    const talks = talksRepo(db);
    const congregationId = await congregations.create('Южное', {
      meeting_weekday: 0,
      meeting_time: '10:00',
    });

    await exceptions.upsert({
      congregation_id: congregationId,
      date: '2026-03-15',
      exception_type: 'memorial',
    });

    await expect(
      talks.create({
        congregation_id: congregationId,
        date: '2026-03-15',
        song_number: 12,
        talk_number: 45,
        title: 'Тест',
        speaker_name: 'Докладчик',
        speaker_phone: '+79991111111',
      })
    ).rejects.toBeInstanceOf(TalkDateBlockedByEventError);
  });

  it('prevents duplicate talk dates in one congregation', async () => {
    const congregations = congregationsRepo(db);
    const talks = talksRepo(db);
    const congregationId = await congregations.create('Западное', {
      meeting_weekday: 0,
      meeting_time: '10:00',
    });

    await talks.create({
      congregation_id: congregationId,
      date: '2026-03-15',
      song_number: 20,
      talk_number: 77,
      title: 'Первая',
      speaker_name: 'Докладчик 1',
      speaker_phone: '+79992222222',
    });

    await expect(
      talks.create({
        congregation_id: congregationId,
        date: '2026-03-15',
        song_number: 21,
        talk_number: 78,
        title: 'Вторая',
        speaker_name: 'Докладчик 2',
        speaker_phone: '+79993333333',
      })
    ).rejects.toBeInstanceOf(TalkDateDuplicateError);
  });

  it('returns speaker stats payload for /stats view', async () => {
    const congregations = congregationsRepo(db);
    const talks = talksRepo(db);
    const congregationId = await congregations.create('Восточное', {
      meeting_weekday: 0,
      meeting_time: '10:00',
    });

    await talks.create({
      congregation_id: congregationId,
      date: '2026-03-01',
      song_number: 5,
      talk_number: 10,
      title: 'Тема A',
      speaker_name: 'Брат A',
      speaker_phone: '111',
    });
    await talks.create({
      congregation_id: congregationId,
      date: '2026-03-08',
      song_number: 6,
      talk_number: 10,
      title: 'Тема A',
      speaker_name: 'Брат B',
      speaker_phone: '222',
    });

    const stats = await getTalkStats(db, congregationId);
    expect(stats).toHaveLength(1);
    expect(stats[0].total_count).toBe(2);
    expect(stats[0].last_speaker).toBe('Брат B');
  });
});
