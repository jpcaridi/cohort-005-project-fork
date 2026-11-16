import { eq, inArray } from "drizzle-orm";
import { comments, courses, lessons, modules, users } from "~/db/schema";
import { MAX_COMMENT_LENGTH, MIN_COMMENT_LENGTH } from "~/lib/comments";
import {
  notifySafely,
  type Notifier,
  type Person,
} from "~/lib/notifier.server";
import type { Db } from "~/lib/refunds.server";

// ─── Comments ───
// Writing comments on a lesson: Discussion Questions, Discussion Replies and
// the course's Instructor's own top-level comments. See GLOSSARY.md.
// Takes the database first and `now` last, like the refunds service; a
// Notifier, where one is needed, comes right after the database. Failures
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

/** How much of a comment a Notification quotes. */
const SNIPPET_LENGTH = 140;

function snippetOf(body: string) {
  const oneLine = body.replace(/\s+/g, " ");
  return oneLine.length > SNIPPET_LENGTH
    ? `${oneLine.slice(0, SNIPPET_LENGTH - 1).trimEnd()}…`
    : oneLine;
}

function getPeople(db: Db, ids: number[]): Map<number, Person> {
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
 * A reply tells whoever wrote the comment it answers (a Discussion Question,
 * or the Instructor's own top-level comment), unless they wrote the reply.
 */
async function notifyAboutReply(
  db: Db,
  notifier: Notifier,
  created: CreatedComment
) {
  const { comment, questionAuthorId, course, lesson } = created;
  if (questionAuthorId === comment.userId) return;

  const people = getPeople(db, [questionAuthorId, comment.userId]);
  const recipient = people.get(questionAuthorId);
  const actor = people.get(comment.userId);
  if (!recipient || !actor) return;

  await notifySafely(notifier, {
    kind: "discussion_reply",
    recipients: [recipient],
    actor,
    idempotencyKey: `comment:${comment.id}`,
    data: {
      commentId: comment.id,
      courseTitle: course.title,
      lessonTitle: lesson.title,
      snippet: snippetOf(comment.body),
      url: `/courses/${course.slug}/lessons/${lesson.id}#comment-${comment.id}`,
    },
  });
}

/**
 * Posts a comment on a lesson: top-level when `parentId` is null, otherwise a
 * reply to that top-level comment. Replies are one level deep. Who may comment
 * on the lesson is the caller's check. Once the comment is saved, a Discussion
 * Reply Notification goes out (best-effort: a failure is logged, not thrown).
 */
export async function createComment(
  db: Db,
  notifier: Notifier,
  authorId: number,
  lessonId: number,
  parentId: number | null,
  body: string,
  now: Date
): Promise<CreatedComment> {
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

  const created: CreatedComment = {
    comment,
    kind,
    questionAuthorId: parent ? parent.userId : authorId,
    course: found.course,
    lesson: found.lesson,
  };

  if (kind === "discussion_reply") {
    await notifyAboutReply(db, notifier, created);
  }

  return created;
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
