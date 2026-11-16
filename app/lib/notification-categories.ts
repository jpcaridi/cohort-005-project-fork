// ─── Notification categories ───
// The preference categories a person can switch off, shared by the server
// (Notifier, Knock adapter, settings service) and the browser (the
// Notifications card). Every per-category table is a `ByCategory` record, so
// adding a category here is a type error everywhere it hasn't been handled.

/**
 * The preference categories a person can switch off. Every kind of
 * Notification belongs to exactly one.
 */
export type NotificationCategory =
  | "refund_request_updates"
  | "open_refund_requests"
  | "seat_claims"
  | "enrollments"
  | "discussion_questions"
  | "discussion_replies";

/** The channels a Notification can go to. v1 has the Notification Feed only. */
export type NotificationChannel = "feed";

/** One value for every category: leaving one out is a type error. */
export type ByCategory<T> = Record<NotificationCategory, T>;

/** The keys of a record, typed as its keys. */
export function keysOf<K extends string>(record: Record<K, unknown>): K[] {
  return Object.keys(record) as K[];
}

/** The entries of a (possibly partial) record, typed, skipping missing values. */
export function entriesOf<K extends string, V>(
  record: Partial<Record<K, V>>
): [K, V][] {
  const entries: [K, V][] = [];
  for (const key of Object.keys(record) as K[]) {
    const value = record[key];
    if (value !== undefined) entries.push([key, value]);
  }
  return entries;
}

/**
 * Every category, in the order the Notifications card lists them (key order).
 * The order lives here and only here.
 */
const CATEGORIES: ByCategory<true> = {
  refund_request_updates: true,
  open_refund_requests: true,
  seat_claims: true,
  enrollments: true,
  discussion_questions: true,
  discussion_replies: true,
};

export const NOTIFICATION_CATEGORIES: NotificationCategory[] = keysOf(CATEGORIES);

export function isNotificationCategory(
  value: unknown
): value is NotificationCategory {
  return typeof value === "string" && Object.hasOwn(CATEGORIES, value);
}
