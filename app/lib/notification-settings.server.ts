import { eq } from "drizzle-orm";
import type { Db } from "~/db";
import * as schema from "~/db/schema";
import {
  NOTIFICATION_CATEGORIES,
  type ByCategory,
  type NotificationCategory,
} from "~/lib/notification-categories";
import {
  DEFAULT_PREFERENCES,
  type NotificationPreferences,
  type Notifier,
} from "~/lib/notifier.server";
import { ownsTeamLicence } from "~/lib/seats.server";

export type NotificationSetting = {
  category: NotificationCategory;
  enabled: boolean;
};

/** A switch that couldn't be saved, with a message the person can read. */
export class NotificationSettingNotSaved extends Error {
  constructor(
    message: string,
    /** The HTTP status the route fails with. */
    readonly status: 403 | 502
  ) {
    super(message);
    this.name = "NotificationSettingNotSaved";
  }
}

/** The roles and Purchases that decide which switches a person sees. */
type SwitchEligibility = {
  hasPurchase: boolean;
  isPlatformAdmin: boolean;
  /** Owns a Team Licence (the same definition as the Seat-claim recipient). */
  isTeamAdmin: boolean;
  isInstructor: boolean;
};

/** Who sees each category's switch. */
const SHOWN_TO: ByCategory<(e: SwitchEligibility) => boolean> = {
  refund_request_updates: (e) => e.hasPurchase,
  open_refund_requests: (e) => e.isPlatformAdmin,
  seat_claims: (e) => e.isTeamAdmin,
  enrollments: (e) => e.isInstructor,
  discussion_questions: (e) => e.isInstructor,
  discussion_replies: () => true,
};

function switchEligibilityOf(db: Db, userId: number): SwitchEligibility {
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
  return {
    hasPurchase: purchase !== undefined,
    isPlatformAdmin: user?.role === schema.UserRole.Admin,
    isTeamAdmin: ownsTeamLicence(db, userId),
    isInstructor:
      user?.role === schema.UserRole.Instructor || ownedCourse !== undefined,
  };
}

/** The categories whose switch this person sees, in card order. */
function visibleCategories(db: Db, userId: number): NotificationCategory[] {
  const eligibility = switchEligibilityOf(db, userId);
  return NOTIFICATION_CATEGORIES.filter((category) =>
    SHOWN_TO[category](eligibility)
  );
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

/**
 * Flips one switch on the person's Notifications card, merging only that
 * category into their stored preferences. Throws `NotificationSettingNotSaved`
 * (403) for a switch they can't see, which writes nothing, and (502) when the
 * Notifier can't save it.
 */
export async function saveNotificationSetting(
  db: Db,
  notifier: Notifier,
  userId: number,
  category: NotificationCategory,
  enabled: boolean
): Promise<void> {
  if (!visibleCategories(db, userId).includes(category)) {
    throw new NotificationSettingNotSaved(
      "You can't change that notification setting.",
      403
    );
  }
  try {
    await notifier.setPreference(userId, { category, channel: "feed", enabled });
  } catch (error) {
    console.error(
      `Saving ${category}=${enabled} for user ${userId} failed:`,
      error
    );
    throw new NotificationSettingNotSaved(
      "Couldn't save your notification setting. Try again.",
      502
    );
  }
}
