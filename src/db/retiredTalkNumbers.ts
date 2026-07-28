/**
 * Номера публичных речей, выведенные из обращения.
 * С 2026-09-01 (UTC) планирование и смена на эти номера запрещены.
 * 59, 82, 122, 123 не использовались раньше; с той же даты — та же date-блокировка.
 */

export const RETIRED_TALK_NUMBERS_CUTOFF_YMD = '2026-09-01';

export const RETIRED_TALK_NUMBERS: ReadonlySet<number> = new Set([
  59, 82, 84, 85, 87, 92, 94, 97, 105, 106, 109, 117, 119, 120, 122, 123, 124, 126, 139, 141, 144, 145, 148, 149, 151, 154, 155, 157, 158, 163, 164, 165, 167, 168
]);

export function isRetiredTalkNumber(talkNumber: number): boolean {
  return RETIRED_TALK_NUMBERS.has(talkNumber);
}

/** Запрет, если номер выведен из обращения и дата речи ≥ cutoff. */
export function isRetiredTalkNumberOnOrAfterCutoff(
  talkNumber: number,
  dateYmd: string
): boolean {
  return isRetiredTalkNumber(talkNumber) && dateYmd >= RETIRED_TALK_NUMBERS_CUTOFF_YMD;
}

export function assertTalkNumberNotRetiredOnDate(
  talkNumber: number,
  dateYmd: string
): void {
  if (isRetiredTalkNumberOnOrAfterCutoff(talkNumber, dateYmd)) {
    throw new TalkNumberRetiredError(talkNumber, dateYmd);
  }
}

export class TalkNumberRetiredError extends Error {
  readonly code = 'TALK_NUMBER_RETIRED';
  constructor(
    public readonly talkNumber: number,
    public readonly date: string
  ) {
    super('План речи больше не используется');
    this.name = 'TalkNumberRetiredError';
  }
}
