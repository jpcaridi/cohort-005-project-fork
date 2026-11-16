import { existsSync } from "node:fs";

// ─── Notifier ───
// The server port for Notifications (see GLOSSARY.md). Services take a
// Notifier as an injected parameter, like `db` and `now`, and describe each
// Notification in Cadence's language. Only an adapter knows the vendor:
//
// - `knockNotifier` (knock-notifier.server.ts) delivers through Knock. It is
//   the only code that touches Knock.
// - `createFakeNotifier` records what was sent, for tests.
// - `loggingNotifier` logs instead of sending, when no Knock key is set.
//
// Notifications are best-effort: services send them with `notifySafely`
// after the domain write, so a Notifier failure never fails the action.

/** Someone who sends or receives a Notification. */
export type Person = {
  id: number;
  name: string;
  email: string;
  avatarUrl: string | null;
};

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

/** Someone replied to a comment the recipient wrote. Catalogue #7. */
export type DiscussionReplyNotification = {
  kind: "discussion_reply";
  recipients: Person[];
  actor: Person;
  /** One per domain event, so a retry can't send the Notification twice. */
  idempotencyKey: string;
  data: {
    commentId: number;
    courseTitle: string;
    lessonTitle: string;
    snippet: string;
    /** Where clicking the Notification goes. */
    url: string;
  };
};

/** Someone asked a Discussion Question on the recipient's course. Catalogue #6. */
export type DiscussionQuestionNotification = {
  kind: "discussion_question";
  recipients: Person[];
  actor: Person;
  /** One per domain event, so a retry can't send the Notification twice. */
  idempotencyKey: string;
  data: {
    commentId: number;
    courseTitle: string;
    lessonTitle: string;
    snippet: string;
    /** Where clicking the Notification goes. */
    url: string;
  };
};

/** A Student claimed a Seat on the recipient's Team Licence. Catalogue #4. */
export type SeatClaimedNotification = {
  kind: "seat_claimed";
  recipients: Person[];
  actor: Person;
  /** One per domain event, so a retry can't send the Notification twice. */
  idempotencyKey: string;
  data: {
    seatId: number;
    courseTitle: string;
    /** Seats on the Team Licence that can still be claimed, after this one. */
    seatsLeft: number;
    /** Where clicking the Notification goes. */
    url: string;
  };
};

/** A Student enrolled on a course the recipient teaches. Catalogue #5. */
export type EnrollmentNotification = {
  kind: "enrollment";
  recipients: Person[];
  actor: Person;
  /** One per domain event, so a retry can't send the Notification twice. */
  idempotencyKey: string;
  data: {
    enrollmentId: number;
    courseTitle: string;
    /** Where clicking the Notification goes. */
    url: string;
  };
};

/** Every Notification Cadence sends. Later kinds join this union. */
export type Notification =
  | DiscussionReplyNotification
  | DiscussionQuestionNotification
  | SeatClaimedNotification
  | EnrollmentNotification;

export type NotificationKind = Notification["kind"];

export const NOTIFICATION_CATEGORY: Record<
  NotificationKind,
  NotificationCategory
> = {
  discussion_reply: "discussion_replies",
  discussion_question: "discussion_questions",
  seat_claimed: "seat_claims",
  enrollment: "enrollments",
};

export interface Notifier {
  /** Sends one Notification to its recipients. May throw. */
  notify(notification: Notification): Promise<void>;
  /**
   * Archives every Notification caused by a comment (its Discussion Question
   * or Discussion Reply Notification), so it leaves the Notification Feed.
   * May throw.
   */
  archiveByComment(commentId: number): Promise<void>;
  /** Creates or updates the person (name, email, avatar). May throw. */
  syncUser(person: Person): Promise<void>;
  /** The person's preferences, or null when they have none yet. May throw. */
  getPreferences(userId: number): Promise<NotificationPreferences | null>;
  /**
   * Merges these preferences into the person's set; categories and channels
   * left out keep their current value. May throw.
   */
  mergePreferences(
    userId: number,
    preferences: NotificationPreferences
  ): Promise<void>;
  /**
   * Switches one category on one channel, leaving every other preference
   * untouched. May throw.
   */
  setPreference(userId: number, change: PreferenceChange): Promise<void>;
}

// ─── Preferences ───

/** Whether each category reaches the person on each channel. */
export type NotificationPreferences = Partial<
  Record<NotificationCategory, Partial<Record<NotificationChannel, boolean>>>
>;

/** One category × channel switch. */
export type PreferenceChange = {
  category: NotificationCategory;
  channel: NotificationChannel;
  enabled: boolean;
};

/**
 * What a person starts with: Enrollments off, every other category on, on
 * the Feed (the only channel in v1).
 */
export const DEFAULT_PREFERENCES = {
  refund_request_updates: { feed: true },
  open_refund_requests: { feed: true },
  seat_claims: { feed: true },
  enrollments: { feed: false },
  discussion_questions: { feed: true },
  discussion_replies: { feed: true },
} satisfies Record<NotificationCategory, Record<NotificationChannel, boolean>>;

/** Deep-merges `changes` into `preferences`, as Knock's merge strategy does. */
export function mergeNotificationPreferences(
  preferences: NotificationPreferences,
  changes: NotificationPreferences
): NotificationPreferences {
  const merged: NotificationPreferences = { ...preferences };
  for (const [category, channels] of Object.entries(changes) as [
    NotificationCategory,
    Partial<Record<NotificationChannel, boolean>>,
  ][]) {
    merged[category] = { ...merged[category], ...channels };
  }
  return merged;
}

/**
 * Sends a Notification, logging instead of throwing when it fails. Used by
 * services after the domain write has committed.
 */
export async function notifySafely(
  notifier: Notifier,
  notification: Notification
): Promise<void> {
  try {
    await notifier.notify(notification);
  } catch (error) {
    console.error(
      `Notification ${notification.kind} (${notification.idempotencyKey}) failed:`,
      error
    );
  }
}

/**
 * Archives the Notifications a deleted comment caused, logging instead of
 * throwing when it fails.
 */
export async function archiveByCommentSafely(
  notifier: Notifier,
  commentId: number
): Promise<void> {
  try {
    await notifier.archiveByComment(commentId);
  } catch (error) {
    console.error(
      `Archiving Notifications for comment:${commentId} failed:`,
      error
    );
  }
}

export type FakeNotifier = Notifier & {
  /** Every Notification sent, in order. */
  notifications: Notification[];
  /** Every comment whose Notifications were archived, in order. */
  archivedCommentIds: number[];
  /** Every user sync, in order. */
  syncedUsers: Person[];
  /** Each person's stored preferences, by user id. */
  preferences: Map<number, NotificationPreferences>;
};

export function createFakeNotifier(): FakeNotifier {
  const notifications: Notification[] = [];
  const archivedCommentIds: number[] = [];
  const syncedUsers: Person[] = [];
  const preferences = new Map<number, NotificationPreferences>();
  const merge = (userId: number, changes: NotificationPreferences) => {
    preferences.set(
      userId,
      mergeNotificationPreferences(preferences.get(userId) ?? {}, changes)
    );
  };
  return {
    notifications,
    archivedCommentIds,
    syncedUsers,
    preferences,
    async notify(notification) {
      notifications.push(notification);
    },
    async archiveByComment(commentId) {
      archivedCommentIds.push(commentId);
    },
    async syncUser(person) {
      syncedUsers.push({ ...person });
    },
    async getPreferences(userId) {
      return preferences.get(userId) ?? null;
    },
    async mergePreferences(userId, changes) {
      merge(userId, changes);
    },
    async setPreference(userId, { category, channel, enabled }) {
      merge(userId, { [category]: { [channel]: enabled } });
    },
  };
}

export function loggingNotifier(): Notifier {
  return {
    async notify(notification) {
      console.info(
        `[notifier] No Knock key set; not sending ${notification.kind} (${notification.idempotencyKey}) to ${notification.recipients
          .map((r) => r.id)
          .join(", ")}`
      );
    },
    async archiveByComment(commentId) {
      console.info(
        `[notifier] No Knock key set; not archiving Notifications for comment:${commentId}`
      );
    },
    // Quiet: the seed syncs every user.
    async syncUser() {},
    async getPreferences() {
      return null;
    },
    async mergePreferences() {},
    async setPreference(userId, change) {
      console.info(
        `[notifier] No Knock key set; not saving ${change.category}/${change.channel}=${change.enabled} for user ${userId}`
      );
    },
  };
}

// Vite doesn't put non-VITE_ variables from .env on process.env, so load the
// file ourselves. Values already in the environment win.
let envLoaded = false;
function loadEnv() {
  if (envLoaded) return;
  envLoaded = true;
  if (existsSync(".env")) {
    process.loadEnvFile(".env");
  }
}

/** The Knock secret key, or undefined when Knock isn't configured. */
export function knockSecretKey(): string | undefined {
  loadEnv();
  return process.env.KNOCK_SECRET_API_KEY || process.env.KNOCK_API_KEY;
}

let defaultNotifier: Promise<Notifier> | undefined;

/**
 * The app's Notifier: Knock when a secret key is set, otherwise the logging
 * adapter. Routes pass it to services; tests pass a fake instead.
 */
export function getNotifier(): Promise<Notifier> {
  if (!defaultNotifier) {
    const secretKey = knockSecretKey();
    defaultNotifier = secretKey
      ? import("./knock-notifier.server").then((m) =>
          m.knockNotifier(secretKey)
        )
      : Promise.resolve(loggingNotifier());
  }
  return defaultNotifier;
}
