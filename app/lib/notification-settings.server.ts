import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { and, eq } from "drizzle-orm";
import * as schema from "~/db/schema";
import {
  DEFAULT_PREFERENCES,
  type NotificationCategory,
  type NotificationPreferences,
  type Notifier,
} from "~/lib/notifier.server";

type Db = BetterSQLite3Database<typeof schema>;

export type NotificationSetting = {
  category: NotificationCategory;
  enabled: boolean;
};

/** What a person is or has that decides which switches they see. */
type Standing = {
  hasPurchase: boolean;
  isPlatformAdmin: boolean;
  isTeamAdmin: boolean;
  isInstructor: boolean;
};

/** Every category, in the order the card lists them, with who sees it. */
const SWITCHES: { category: NotificationCategory; shown: (s: Standing) => boolean }[] = [
  { category: "refund_request_updates", shown: (s) => s.hasPurchase },
  { category: "open_refund_requests", shown: (s) => s.isPlatformAdmin },
  { category: "seat_claims", shown: (s) => s.isTeamAdmin },
  { category: "enrollments", shown: (s) => s.isInstructor },
  { category: "discussion_questions", shown: (s) => s.isInstructor },
  { category: "discussion_replies", shown: () => true },
];

function standingOf(db: Db, userId: number): Standing {
  const user = db
    .select({ role: schema.users.role })
    .from(schema.users)
    .where(eq(schema.users.id, userId))
    .get();
  const purchase = db
    .select({ id: schema.purchases.id })
    .from(schema.purchases)
    .where(eq(schema.purchases.userId, userId))
    .get();
  const ownedCourse = db
    .select({ id: schema.courses.id })
    .from(schema.courses)
    .where(eq(schema.courses.instructorId, userId))
    .get();
  // A Team Licence is the Seats a Purchase granted a team.
  const teamLicence = db
    .select({ id: schema.coupons.id })
    .from(schema.teamMembers)
    .innerJoin(schema.coupons, eq(schema.coupons.teamId, schema.teamMembers.teamId))
    .where(
      and(
        eq(schema.teamMembers.userId, userId),
        eq(schema.teamMembers.role, schema.TeamMemberRole.Admin)
      )
    )
    .get();
  return {
    hasPurchase: purchase !== undefined,
    isPlatformAdmin: user?.role === schema.UserRole.Admin,
    isTeamAdmin: teamLicence !== undefined,
    isInstructor:
      user?.role === schema.UserRole.Instructor || ownedCourse !== undefined,
  };
}

/** The categories whose switch this person sees, in card order. */
function visibleCategories(db: Db, userId: number): NotificationCategory[] {
  const standing = standingOf(db, userId);
  return SWITCHES.filter((s) => s.shown(standing)).map((s) => s.category);
}

/**
 * The switches on the person's Notifications card, each on or off as their
 * stored preferences say, falling back to the defaults.
 */
export async function getNotificationSettings(
  db: Db,
  notifier: Notifier,
  userId: number
): Promise<NotificationSetting[]> {
  const categories = visibleCategories(db, userId);
  const stored = await storedPreferences(notifier, userId);
  return categories.map((category) => ({
    category,
    enabled: stored[category]?.feed ?? DEFAULT_PREFERENCES[category].feed,
  }));
}

/** The person's stored preferences; none when they have none or can't be read. */
async function storedPreferences(
  notifier: Notifier,
  userId: number
): Promise<NotificationPreferences> {
  try {
    return (await notifier.getPreferences(userId)) ?? {};
  } catch (error) {
    console.error(`Reading preferences for user ${userId} failed:`, error);
    return {};
  }
}

type SaveResult = { ok: true } | { ok: false; status: number; error: string };

/**
 * Flips one switch on the person's Notifications card, merging only that
 * category into their stored preferences. A switch they can't see writes
 * nothing.
 */
export async function saveNotificationSetting(
  db: Db,
  notifier: Notifier,
  userId: number,
  category: NotificationCategory,
  enabled: boolean
): Promise<SaveResult> {
  if (!visibleCategories(db, userId).includes(category)) {
    return {
      ok: false,
      status: 403,
      error: "You can't change that notification setting.",
    };
  }
  try {
    await notifier.setPreference(userId, { category, channel: "feed", enabled });
  } catch (error) {
    console.error(
      `Saving ${category}=${enabled} for user ${userId} failed:`,
      error
    );
    return {
      ok: false,
      status: 502,
      error: "Couldn't save your notification setting. Try again.",
    };
  }
  return { ok: true };
}
