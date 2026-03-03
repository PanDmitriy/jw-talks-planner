/**
 * Экспорт модулей базы данных
 */

export { initDatabase } from './schema';
export type {
  Talk,
  TalkInput,
  ScheduleException,
  ScheduleExceptionInput,
  ScheduleExceptionType,
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
  scheduleExceptionsRepo,
  talksRepo,
  userCongregationsRepo,
  notificationsRepo,
  getTalkStats,
  getSpeakerStats,
  getTalkStatsByYearMatrix,
  getTitleForTalk,
  getMergedPlansForCongregation,
  TalkDateValidationError,
  TalkDateBlockedByEventError,
} from './repositories';
