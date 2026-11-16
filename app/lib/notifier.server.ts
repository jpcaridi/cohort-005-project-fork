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

/** Every Notification Cadence sends. Later kinds join this union. */
export type Notification =
  | DiscussionReplyNotification
  | DiscussionQuestionNotification;

export type NotificationKind = Notification["kind"];

export const NOTIFICATION_CATEGORY: Record<
  NotificationKind,
  NotificationCategory
> = {
  discussion_reply: "discussion_replies",
  discussion_question: "discussion_questions",
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
};

export function createFakeNotifier(): FakeNotifier {
  const notifications: Notification[] = [];
  const archivedCommentIds: number[] = [];
  return {
    notifications,
    archivedCommentIds,
    async notify(notification) {
      notifications.push(notification);
    },
    async archiveByComment(commentId) {
      archivedCommentIds.push(commentId);
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
