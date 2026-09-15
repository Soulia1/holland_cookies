/**
 * A timestamp from the API, as a Date.
 *
 * The API speaks ISO 8601 with its zone (`2026-09-15T11:36:00.000Z`) since the
 * Firestore migration. The SQLite build sent `YYYY-MM-DD HH:MM:SS` in UTC with no
 * marker, and the pages appended a `Z` to every stamp. That turned each real ISO
 * timestamp into `…ZZ`, and the date on every receipt, tracking page and account
 * order into "Invalid Date". The old shape is still read as UTC; a stamp that
 * carries its own zone is passed through untouched.
 */
export function parseStamp(stamp: string): Date {
  const legacy = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}(?::\d{2})?)$/.exec(stamp.trim());
  return new Date(legacy ? `${legacy[1]}T${legacy[2]}Z` : stamp);
}
