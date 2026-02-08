/**
 * Экспорт модулей базы данных
 */

export { initDatabase } from './schema';
export type {
  Talk,
  TalkInput,
  Congregation,
  UserCongregation,
  TalkPlan,
  TalkStats,
  SpeakerStats,
  DefaultTalkTitle,
  TalkYearMatrixRow,
} from './types';
export type { DatabaseInstance } from './schema';
export type { MergedPlanItem } from './repositories';
export {
  congregationsRepo,
  defaultTalkTitlesRepo,
  talkPlansRepo,
  talksRepo,
  userCongregationsRepo,
  notificationsRepo,
  getTalkStats,
  getSpeakerStats,
  getTalkStatsByYearMatrix,
  getTitleForTalk,
  getMergedPlansForCongregation,
} from './repositories';
