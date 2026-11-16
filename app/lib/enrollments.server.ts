import { and, eq, inArray } from "drizzle-orm";
import { courses, enrollments, users } from "~/db/schema";
import { notifySafely, type Notifier, type Person } from "~/lib/notifier.server";
import type { Db } from "~/lib/refunds.server";

// ─── Enrollments ───
// Giving a Student an Enrollment on a course, whether it came from an
// Individual Purchase or a Claimed Seat. A Lapsed Student enrolls again the
// same way. Takes the database first, the Notifier next and `now` last, like
// the comments service.

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

export function getPeople(db: Db, ids: number[]): Map<number, Person> {
  const rows = db
    .select({
      id: users.id,
      name: users.name,
      email: users.email,
      avatarUrl: users.avatarUrl,
    })
    .from(users)
    .where(inArray(users.id, ids))
    .all();
  return new Map(rows.map((row) => [row.id, row]));
}

/**
 * Enrolls the Student on the course. Throws if they already have an
 * Enrollment on it, or the course doesn't exist. Once the Enrollment is saved,
 * an Enrollment Notification goes to the course's Instructor, unless they
 * enrolled themselves (best-effort: a failure is logged, not thrown). Whether
 * it reaches their Feed is their Enrollments preference, off by default.
 */
export async function enrollUser(
  db: Db,
  notifier: Notifier,
  userId: number,
  courseId: number,
  now: Date
): Promise<Enrollment> {
  if (findEnrollment(db, userId, courseId)) {
    throw new Error("User is already enrolled in this course");
  }

  const course = db
    .select({
      id: courses.id,
      title: courses.title,
      instructorId: courses.instructorId,
    })
    .from(courses)
    .where(eq(courses.id, courseId))
    .get();
  if (!course) {
    throw new Error("Course not found");
  }

  const enrollment = db
    .insert(enrollments)
    .values({ userId, courseId, enrolledAt: now.toISOString() })
    .returning()
    .get();

  if (course.instructorId !== userId) {
    const people = getPeople(db, [course.instructorId, userId]);
    const instructor = people.get(course.instructorId);
    const student = people.get(userId);
    if (instructor && student) {
      await notifySafely(notifier, {
        kind: "enrollment",
        recipients: [instructor],
        actor: student,
        idempotencyKey: `enrollment:${enrollment.id}`,
        data: {
          enrollmentId: enrollment.id,
          courseTitle: course.title,
          url: `/instructor/${course.id}/students`,
        },
      });
    }
  }

  return enrollment;
}
