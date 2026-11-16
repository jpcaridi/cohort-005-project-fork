import { and, eq } from "drizzle-orm";
import { courses, enrollments } from "~/db/schema";
import type { Db } from "~/lib/refunds.server";

// ─── Enrollments ───
// Giving a Student an Enrollment on a course, whether it came from an
// Individual Purchase or a Claimed Seat. A Lapsed Student enrolls again the
// same way. Takes the database first and `now` last, like the refunds service.

export type Enrollment = typeof enrollments.$inferSelect;

export function findEnrollment(db: Db, userId: number, courseId: number) {
  return db
    .select()
    .from(enrollments)
    .where(
      and(eq(enrollments.userId, userId), eq(enrollments.courseId, courseId))
    )
    .get();
}

/**
 * Enrolls the Student on the course. Throws if they already have an
 * Enrollment on it, or the course doesn't exist.
 */
export function enrollUser(
  db: Db,
  userId: number,
  courseId: number,
  now: Date
): Enrollment {
  if (findEnrollment(db, userId, courseId)) {
    throw new Error("User is already enrolled in this course");
  }

  const course = db
    .select({ id: courses.id })
    .from(courses)
    .where(eq(courses.id, courseId))
    .get();
  if (!course) {
    throw new Error("Course not found");
  }

  return db
    .insert(enrollments)
    .values({ userId, courseId, enrolledAt: now.toISOString() })
    .returning()
    .get();
}
