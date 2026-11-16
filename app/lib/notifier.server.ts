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

/**
 * The buyer raised a Refund Request; it is under review. Catalogue #8. Sent
 * by Cadence itself, so there is no actor (the Feed shows the Cadence "C"
 * avatar), and there is nowhere to go (`url` is null).
 */
export type RefundRequestedNotification = {
  kind: "refund_requested";
  recipients: Person[];
  actor: null;
  idempotencyKey: string;
  data: {
    refundRequestId: number;
    courseTitle: string;
    /** What the buyer paid, in cents. */
    amount: number;
    url: null;
  };
};

/** A buyer raised a Refund Request a Platform Admin must decide. Catalogue #3. */
export type OpenRefundRequestNotification = {
  kind: "open_refund_request";
  recipients: Person[];
  /** The buyer who asked. */
  actor: Person;
  idempotencyKey: string;
  data: {
    refundRequestId: number;
    courseTitle: string;
    /** What the buyer paid, in cents. */
    amount: number;
    reason: string;
    url: string;
  };
};

/**
 * A Platform Admin approved (catalogue #1) or declined (catalogue #2) the
 * recipient's Refund Request.
 */
export type RefundDecidedNotification = {
  kind: "refund_approved" | "refund_declined";
  recipients: Person[];
  /** The Platform Admin who decided. */
  actor: Person;
  idempotencyKey: string;
  data: {
    refundRequestId: number;
    purchaseId: number;
    courseTitle: string;
    /** What the buyer paid, in cents. */
    amount: number;
    /** Always set on a decline; optional on an approval. */
    decisionNote: string | null;
    url: string;
  };
};

/** Every Notification Cadence sends. Later kinds join this union. */
export type Notification =
  | DiscussionReplyNotification
  | RefundRequestedNotification
  | OpenRefundRequestNotification
  | RefundDecidedNotification;

export type NotificationKind = Notification["kind"];

export const NOTIFICATION_CATEGORY: Record<
  NotificationKind,
  NotificationCategory
> = {
  discussion_reply: "discussion_replies",
  refund_requested: "refund_request_updates",
  refund_approved: "refund_request_updates",
  refund_declined: "refund_request_updates",
  open_refund_request: "open_refund_requests",
};

export interface Notifier {
  /** Sends one Notification to its recipients. May throw. */
  notify(notification: Notification): Promise<void>;
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

export type FakeNotifier = Notifier & {
  /** Every Notification sent, in order. */
  notifications: Notification[];
};

export function createFakeNotifier(): FakeNotifier {
  const notifications: Notification[] = [];
  return {
    notifications,
    async notify(notification) {
      notifications.push(notification);
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
