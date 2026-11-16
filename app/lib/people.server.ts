import { inArray } from "drizzle-orm";
import type { Queryable } from "~/db";
import { users } from "~/db/schema";
import type { Person } from "~/lib/notifier.server";

// ─── People ───
// Turning user rows into the Person a Notification is sent to or from.

/** The Person a user is: only the fields a Notification carries. */
export function toPerson(user: Person): Person {
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    avatarUrl: user.avatarUrl,
  };
}

/** These users as People, by id. Ids with no user are left out. */
export function getPeople(db: Queryable, ids: number[]): Map<number, Person> {
  const rows = db.select().from(users).where(inArray(users.id, ids)).all();
  return new Map(rows.map((row) => [row.id, toPerson(row)]));
}
