function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

function isValidYmdParts(year: number, month: number, day: number): boolean {
  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) return false;
  if (year < 1900 || year > 2100) return false;
  if (month < 1 || month > 12) return false;
  const daysInMonth = [31, isLeapYear(year) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return day >= 1 && day <= daysInMonth[month - 1];
}

/**
 * Нормализует дату к формату YYYY-MM-DD.
 * Поддерживает вход:
 * - YYYY-MM-DD
 * - DD.MM.YYYY
 * - ISO datetime (берётся только часть даты)
 */
export function toYmdString(value: string | Date | number): string {
  if (typeof value === 'string') {
    const raw = value.trim();
    const maybeIso = raw.includes('T') ? raw.split('T')[0] : raw;
    if (/^\d{4}-\d{2}-\d{2}$/.test(maybeIso)) return maybeIso;

    const dmy = maybeIso.match(/^(\d{2})\.(\d{2})\.(\d{4})$/);
    if (dmy) {
      const day = Number(dmy[1]);
      const month = Number(dmy[2]);
      const year = Number(dmy[3]);
      if (!isValidYmdParts(year, month, day)) return '';
      return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    }
    return '';
  }

  const date = value instanceof Date ? value : new Date(value);
  const y = date.getUTCFullYear();
  const m = date.getUTCMonth() + 1;
  const d = date.getUTCDate();
  if (!isValidYmdParts(y, m, d)) return '';
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

export function formatDateRu(value: string | Date | number): string {
  const ymd = toYmdString(value);
  if (!ymd) return String(value);
  const [year, month, day] = ymd.split('-');
  return `${day}.${month}.${year}`;
}

export function parseUserDateToYmd(input: string): string | null {
  const ymd = toYmdString(input);
  return ymd || null;
}
