import { eq } from "drizzle-orm";
import { comments, courses, lessons, modules } from "~/db/schema";
import { MAX_COMMENT_LENGTH, MIN_COMMENT_LENGTH } from "~/lib/comments";
import type { Db } from "~/lib/refunds.server";

// ─── Comments ───
// Writing comments on a lesson: Discussion Questions, Discussion Replies and
// the course's Instructor's own top-level comments. See GLOSSARY.md.
// Takes the database first and `now` last, like the refunds service. Failures
// a person can correct are thrown as Errors with a message they can read.

export type Comment = typeof comments.$inferSelect;

/**
 * - `discussion_question`: a top-level comment by anyone but the course's
 *   Instructor (Platform Admins included).
 * - `instructor_comment`: a top-level comment by the course's Instructor. Not
 *   a Discussion Question.
 * - `discussion_reply`: any reply. `questionAuthorId` is whoever wrote the
 *   comment it answers.
 */
export type CommentKind =
  | "discussion_question"
  | "discussion_reply"
  | "instructor_comment";

export type CreatedComment = {
  comment: Comment;
  kind: CommentKind;
  /** Who wrote the top-level comment this one sits under (or is). */
  questionAuthorId: number;
  course: { id: number; title: string; slug: string; instructorId: number };
  lesson: { id: number; title: string };
};

function getCommentById(db: Db, commentId: number) {
  return db.select().from(comments).where(eq(comments.id, commentId)).get();
}

function getLessonWithCourse(db: Db, lessonId: number) {
  return db
    .select({
      lesson: { id: lessons.id, title: lessons.title },
      course: {
        id: courses.id,
        title: courses.title,
        slug: courses.slug,
        instructorId: courses.instructorId,
      },
    })
    .from(lessons)
    .innerJoin(modules, eq(lessons.moduleId, modules.id))
    .innerJoin(courses, eq(modules.courseId, courses.id))
    .where(eq(lessons.id, lessonId))
    .get();
}

function assertValidBody(body: string) {
  const trimmed = body.trim();
  if (trimmed.length < MIN_COMMENT_LENGTH) {
    throw new Error("Comment cannot be empty");
  }
  if (trimmed.length > MAX_COMMENT_LENGTH) {
    throw new Error(
      `Comment must be ${MAX_COMMENT_LENGTH} characters or fewer`
    );
  }
  return trimmed;
}

/**
 * Posts a comment on a lesson: top-level when `parentId` is null, otherwise a
 * reply to that top-level comment. Replies are one level deep. Who may comment
 * on the lesson is the caller's check.
 */
export function createComment(
  db: Db,
  authorId: number,
  lessonId: number,
  parentId: number | null,
  body: string,
  now: Date
): CreatedComment {
  const trimmed = assertValidBody(body);

  const found = getLessonWithCourse(db, lessonId);
  if (!found) {
    throw new Error("Lesson not found");
  }

  let parent: Comment | undefined;
  if (parentId !== null) {
    parent = getCommentById(db, parentId);
    if (!parent) {
      throw new Error("Parent comment not found");
    }
    if (parent.lessonId !== lessonId) {
      throw new Error("Parent comment belongs to a different lesson");
    }
    if (parent.parentId !== null) {
      throw new Error("Replies can only be one level deep");
    }
  }

  const comment = db
    .insert(comments)
    .values({
      userId: authorId,
      lessonId,
      parentId,
      body: trimmed,
      createdAt: now.toISOString(),
    })
    .returning()
    .get();

  const kind: CommentKind = parent
    ? "discussion_reply"
    : authorId === found.course.instructorId
      ? "instructor_comment"
      : "discussion_question";

  return {
    comment,
    kind,
    questionAuthorId: parent ? parent.userId : authorId,
    course: found.course,
    lesson: found.lesson,
  };
}

/** Changes the author's own comment. Edits don't change what was sent about it. */
export function updateComment(
  db: Db,
  commentId: number,
  userId: number,
  body: string,
  now: Date
): Comment {
  const trimmed = assertValidBody(body);

  const existing = getCommentById(db, commentId);
  if (!existing) {
    throw new Error("Comment not found");
  }
  if (existing.deletedAt !== null) {
    throw new Error("Comment has been deleted");
  }
  if (existing.userId !== userId) {
    throw new Error("You can only edit your own comments");
  }

  return db
    .update(comments)
    .set({ body: trimmed, editedAt: now.toISOString() })
    .where(eq(comments.id, commentId))
    .returning()
    .get();
}

/**
 * Soft-deletes a comment (sets `deletedAt`). Its author may delete it, and so
 * may staff (the course's Instructor or a Platform Admin). Deleting a comment
 * that is already deleted changes nothing.
 */
export function deleteComment(
  db: Db,
  commentId: number,
  userId: number,
  isStaff: boolean,
  now: Date
): Comment {
  const existing = getCommentById(db, commentId);
  if (!existing) {
    throw new Error("Comment not found");
  }
  if (existing.userId !== userId && !isStaff) {
    throw new Error("You can only delete your own comments");
  }
  if (existing.deletedAt !== null) {
    return existing;
  }

  return db
    .update(comments)
    .set({ deletedAt: now.toISOString() })
    .where(eq(comments.id, commentId))
    .returning()
    .get();
}
