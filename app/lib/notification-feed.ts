import { z } from "zod";
import { formatPrice } from "~/lib/utils";
import type { Notification, NotificationKind } from "~/lib/notifier.server";

// ─── Notification Feed (client) ───
// The client interface the Notification Feed components talk to, and the
// pure logic that turns a Notification's data into a row. Only the adapter
// (knock-feed-client.ts) knows the vendor; components never import it.

/** Who caused a Notification. Null for ones Cadence sends itself. */
export type FeedActor = { name: string; avatarUrl: string | null };

/** One Notification as the Feed shows it. */
export type FeedNotification = {
  id: string;
  insertedAt: string;
  readAt: string | null;
  seenAt: string | null;
  actor: FeedActor | null;
  /** The data Cadence sent with the Notification (see notifier.server.ts). */
  data: unknown;
};

export type FeedState = {
  /** Newest first. */
  notifications: FeedNotification[];
  unseenCount: number;
  unreadCount: number;
  /** Whether older Notifications are still to load. */
  hasMore: boolean;
  loading: boolean;
};

/**
 * The client interface for one signed-in person's Notification Feed. It
 * keeps a live connection, so the state changes without being asked.
 */
export interface NotificationFeedClient {
  getState(): FeedState;
  /** Calls `listener` whenever the state changes. Returns an unsubscribe. */
  subscribe(listener: () => void): () => void;
  /** Loads the newest page. */
  load(): Promise<void>;
  /** Loads the next older page, if there is one. */
  loadMore(): Promise<void>;
  markRead(id: string): Promise<void>;
  /** Marks every Notification seen, including ones not loaded yet. */
  markAllSeen(): Promise<void>;
  /** Marks every Notification read, including ones not loaded yet. */
  markAllRead(): Promise<void>;
  /** Closes the live connection. The client is unusable afterwards. */
  teardown(): void;
}

export const EMPTY_FEED_STATE: FeedState = {
  notifications: [],
  unseenCount: 0,
  unreadCount: 0,
  hasMore: false,
  loading: false,
};

/** The red badge on the bell: the unseen count, capped at "9+". */
export function badgeLabel(unseenCount: number): string | null {
  if (unseenCount <= 0) return null;
  return unseenCount > 9 ? "9+" : String(unseenCount);
}

/** How long ago a Notification arrived: "just now", "5m", "3h", "2d". */
export function timeAgo(insertedAt: string, now: Date): string {
  const seconds = Math.floor(
    (now.getTime() - new Date(insertedAt).getTime()) / 1000
  );
  if (seconds < 60) return "just now";
  if (seconds < 60 * 60) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 24 * 60 * 60) return `${Math.floor(seconds / 3600)}h`;
  return `${Math.floor(seconds / 86400)}d`;
}

// ─── Rows ───
// Row text is written here from the Notification's data, not by Knock.
// Every Notification kind needs a schema and copy below; the types make a
// missing one a type error.

/** The small icon inset on the avatar. */
export type FeedIcon = "discussion" | "refund" | "team" | "enrollment";

export type FeedRow = {
  title: string;
  snippet: string | null;
  icon: FeedIcon;
  /** Where clicking goes, or null when there is nowhere to go. */
  href: string | null;
};

// Distributes over the union, so a type covering two kinds (approved and
// declined) still gives each kind its data.
type DataFor<N, K> = N extends { kind: infer NK; data: infer D }
  ? K extends NK
    ? D
    : never
  : never;
type DataOf<K extends NotificationKind> = DataFor<Notification, K>;

const commentData = z.object({
  commentId: z.number(),
  courseTitle: z.string(),
  lessonTitle: z.string(),
  snippet: z.string(),
  url: z.string(),
});

const refundDecidedData = z.object({
  refundRequestId: z.number(),
  purchaseId: z.number(),
  courseTitle: z.string(),
  amount: z.number(),
  decisionNote: z.string().nullable(),
  url: z.string(),
});

const DATA_SCHEMA: { [K in NotificationKind]: z.ZodType<DataOf<K>> } = {
  discussion_reply: commentData,
  discussion_question: commentData,
  refund_requested: z.object({
    refundRequestId: z.number(),
    courseTitle: z.string(),
    amount: z.number(),
    url: z.null(),
  }),
  open_refund_request: z.object({
    refundRequestId: z.number(),
    courseTitle: z.string(),
    amount: z.number(),
    reason: z.string(),
    url: z.string(),
  }),
  refund_approved: refundDecidedData,
  refund_declined: refundDecidedData,
  seat_claimed: z.object({
    seatId: z.number(),
    courseTitle: z.string(),
    seatsLeft: z.number(),
    url: z.string(),
  }),
  enrollment: z.object({
    enrollmentId: z.number(),
    courseTitle: z.string(),
    url: z.string(),
  }),
};

const COPY: {
  [K in NotificationKind]: (data: DataOf<K>, actorName: string) => FeedRow;
} = {
  discussion_reply: (data, actorName) => ({
    title: `${actorName} replied to your comment on ${data.lessonTitle}`,
    snippet: quote(data.snippet),
    icon: "discussion",
    href: data.url,
  }),
  discussion_question: (data, actorName) => ({
    title: `${actorName} asked a question on ${data.lessonTitle}`,
    snippet: quote(data.snippet),
    icon: "discussion",
    href: data.url,
  }),
  refund_requested: (data) => ({
    title: `We've received your ${formatPrice(data.amount)} Refund Request for ${data.courseTitle}`,
    snippet: "A Platform Admin will review it.",
    icon: "refund",
    href: data.url,
  }),
  open_refund_request: (data, actorName) => ({
    title: `${actorName} requested a ${formatPrice(data.amount)} refund for ${data.courseTitle}`,
    snippet: quote(data.reason),
    icon: "refund",
    href: data.url,
  }),
  refund_approved: (data) => ({
    title: `Your ${formatPrice(data.amount)} Refund Request for ${data.courseTitle} was approved`,
    snippet: data.decisionNote ? quote(data.decisionNote) : null,
    icon: "refund",
    href: data.url,
  }),
  refund_declined: (data) => ({
    title: `Your ${formatPrice(data.amount)} Refund Request for ${data.courseTitle} was declined`,
    snippet: data.decisionNote
      ? `${quote(data.decisionNote)} You can ask again.`
      : "You can ask again.",
    icon: "refund",
    href: data.url,
  }),
  seat_claimed: (data, actorName) => ({
    title: `${actorName} claimed a Seat for ${data.courseTitle}`,
    snippet: `${data.seatsLeft} ${data.seatsLeft === 1 ? "Seat" : "Seats"} left`,
    icon: "team",
    href: data.url,
  }),
  enrollment: (data, actorName) => ({
    title: `${actorName} enrolled in ${data.courseTitle}`,
    snippet: null,
    icon: "enrollment",
    href: data.url,
  }),
};

function quote(text: string) {
  return `“${text}”`;
}

/** Only paths inside Cadence; anything else goes nowhere. */
function safeHref(href: string | null) {
  return href && href.startsWith("/") && !href.startsWith("//") ? href : null;
}

function isKind(kind: unknown): kind is NotificationKind {
  return typeof kind === "string" && Object.hasOwn(COPY, kind);
}

function describeKind<K extends NotificationKind>(
  kind: K,
  data: unknown,
  actorName: string
): FeedRow | null {
  const parsed = DATA_SCHEMA[kind].safeParse(data);
  if (!parsed.success) return null;
  return COPY[kind](parsed.data, actorName);
}

/** Turns a Notification's data into the text, icon and link of its row. */
export function describeNotification(
  data: unknown,
  actorName: string | null
): FeedRow {
  const kind =
    typeof data === "object" && data !== null && "kind" in data
      ? data.kind
      : undefined;
  const row = isKind(kind)
    ? describeKind(kind, data, actorName ?? "Someone")
    : null;
  if (!row) {
    return {
      title: "New notification",
      snippet: null,
      icon: "discussion",
      href: null,
    };
  }
  return { ...row, href: safeHref(row.href) };
}
