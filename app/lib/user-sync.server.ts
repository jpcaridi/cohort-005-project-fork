import type { Db } from "~/db";
import * as schema from "~/db/schema";
import {
  DEFAULT_PREFERENCES,
  type Notifier,
  type Person,
} from "~/lib/notifier.server";
import { toPerson } from "~/lib/people.server";

// ─── User sync ───
// Keeps the Notifier's copy of a user (name, email, avatar) up to date and
// gives a new user the default Notification preferences. Runs at signup, a
// name change in /settings, a Platform Admin user edit, the seed and the
// backfill. Role isn't synced. Best-effort: a failure is logged, never thrown.

/**
 * Syncs one user, writing the default preferences only when they have none
 * yet. Never throws.
 */
export async function syncUser(notifier: Notifier, user: Person): Promise<void> {
  const person = toPerson(user);
  try {
    await notifier.syncUser(person);
    const existing = await notifier.getPreferences(person.id);
    if (!existing) {
      await notifier.mergePreferences(person.id, DEFAULT_PREFERENCES);
    }
  } catch (error) {
    console.error(`User sync for user ${person.id} failed:`, error);
  }
}

/** Syncs every user in the database. Returns how many were synced. */
export async function syncAllUsers(db: Db, notifier: Notifier): Promise<number> {
  const users = db.select().from(schema.users).all();
  for (const user of users) {
    await syncUser(notifier, user);
  }
  return users.length;
}
