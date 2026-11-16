import { and, eq } from "drizzle-orm";
import type { Db, Queryable } from "~/db";
import { courses, enrollments } from "~/db/schema";
import { notifySafely, type Notifier } from "~/lib/notifier.server";
import { getPeople } from "~/lib/people.server";

// ─── Enrollments ───
// Giving a Student an Enrollment on a course, whether it came from an
// Individual Purchase or a Claimed Seat. A Lapsed Student enrolls again the
// same way. Takes the database first, the Notifier next and `now` last, like
// the comments service.

export type Enrollment = typeof enrollments.$inferSelect;

/** A saved Enrollment and the course it is on. */
export type NewEnrollment = {
  enrollment: Enrollment;
  course: { id: number; title: string; instructorId: number };
};

export function findEnrollment(db: Queryable, userId: number, courseId: number) {
  return db
    .select()
    .from(enrollments)
    .where(
      and(eq(enrollments.userId, userId), eq(enrollments.courseId, courseId))
    )
    .get();
}

/**
 * Saves the Student's Enrollment on the course, sending nothing. Throws if they
 * already have an Enrollment on it, or the course doesn't exist. Synchronous,
 * so it can run inside a caller's transaction; send the Notification with
 * `notifyEnrollment` once that transaction has committed.
 */
export function saveEnrollment(
  db: Queryable,
  userId: number,
  courseId: number,
  now: Date
): NewEnrollment {
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

  return { enrollment, course };
}

/**
 * Tells the course's Instructor about a saved Enrollment, unless they enrolled
 * themselves (best-effort: a failure is logged, not thrown). Whether it
 * reaches their Feed is their Enrollments preference, off by default.
 */
export async function notifyEnrollment(
  db: Db,
  notifier: Notifier,
  { enrollment, course }: NewEnrollment
): Promise<void> {
  if (course.instructorId === enrollment.userId) return;

  const people = getPeople(db, [course.instructorId, enrollment.userId]);
  const instructor = people.get(course.instructorId);
  const student = people.get(enrollment.userId);
  if (!instructor || !student) return;

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

/**
 * Enrolls the Student on the course, then sends the Enrollment Notification
 * (see `saveEnrollment` and `notifyEnrollment`).
 */
export async function enrollUser(
  db: Db,
  notifier: Notifier,
  userId: number,
  courseId: number,
  now: Date
): Promise<Enrollment> {
  const saved = saveEnrollment(db, userId, courseId, now);
  await notifyEnrollment(db, notifier, saved);
  return saved.enrollment;
}
