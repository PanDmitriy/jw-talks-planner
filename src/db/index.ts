/**
 * Экспорт модулей базы данных
 */

export { initDatabase } from './schema';
export type { Talk, TalkInput, Congregation, UserCongregation, TalkPlan, TalkStats, SpeakerStats } from './types';
export type { DatabaseInstance } from './schema';
export {
  congregationsRepo,
  talkPlansRepo,
  talksRepo,
  userCongregationsRepo,
  notificationsRepo,
  getTalkStats,
  getSpeakerStats,
} from './repositories';
