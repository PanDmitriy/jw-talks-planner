const WEEKDAY_NAMES_RU = [
  'воскресенье',
  'понедельник',
  'вторник',
  'среда',
  'четверг',
  'пятница',
  'суббота',
] as const;

const WEEKDAY_ALIASES: Record<string, number> = {
  '0': 0,
  '1': 1,
  '2': 2,
  '3': 3,
  '4': 4,
  '5': 5,
  '6': 6,
  sunday: 0,
  sun: 0,
  monday: 1,
  mon: 1,
  tuesday: 2,
  tue: 2,
  wednesday: 3,
  wed: 3,
  thursday: 4,
  thu: 4,
  friday: 5,
  fri: 5,
  saturday: 6,
  sat: 6,
  вс: 0,
  воскресенье: 0,
  пн: 1,
  понедельник: 1,
  вт: 2,
  вторник: 2,
  ср: 3,
  среда: 3,
  чт: 4,
  четверг: 4,
  пт: 5,
  пятница: 5,
  сб: 6,
  суббота: 6,
};

export function parseWeekdayToken(raw: string): number | null {
  const key = raw.trim().toLowerCase();
  if (key in WEEKDAY_ALIASES) return WEEKDAY_ALIASES[key];
  return null;
}

export function formatWeekdayRu(weekday: number): string {
  return WEEKDAY_NAMES_RU[weekday] ?? 'неизвестно';
}

export function normalizeMeetingTime(raw: string): string | null {
  const trimmed = raw.trim();
  const match = trimmed.match(/^([01]?\d|2[0-3]):([0-5]\d)$/);
  if (!match) return null;
  return `${match[1].padStart(2, '0')}:${match[2]}`;
}

export function formatMeetingTime(time: string): string {
  return time.slice(0, 5);
}
