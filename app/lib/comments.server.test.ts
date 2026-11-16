import { describe, it, expect, beforeEach } from "vitest";
import { createTestDb, seedBaseData } from "~/test/setup";
import * as schema from "~/db/schema";
import { UserRole } from "~/db/schema";
import { createComment, deleteComment, updateComment } from "./comments.server";

type TestDb = ReturnType<typeof createTestDb>;

const NOW = new Date(2026, 9, 6, 12, 0, 0);
const LATER = new Date(2026, 9, 7, 9, 30, 0);

let db: TestDb;
let base: ReturnType<typeof seedBaseData>;
let lesson: typeof schema.lessons.$inferSelect;
let otherLesson: typeof schema.lessons.$inferSelect;
let student: typeof schema.users.$inferSelect;
let platformAdmin: typeof schema.users.$inferSelect;

beforeEach(() => {
  db = createTestDb();
  base = seedBaseData(db);
  student = base.user;
  platformAdmin = db
    .insert(schema.users)
    .values({ name: "Pat Admin", email: "pat@example.com", role: UserRole.Admin })
    .returning()
    .get();

  const module = db
    .insert(schema.modules)
    .values({ courseId: base.course.id, title: "Basics", position: 1 })
    .returning()
    .get();
  lesson = db
    .insert(schema.lessons)
    .values({ moduleId: module.id, title: "Hello", position: 1 })
    .returning()
    .get();
  otherLesson = db
    .insert(schema.lessons)
    .values({ moduleId: module.id, title: "Goodbye", position: 2 })
    .returning()
    .get();
});

function ask(authorId: number, body = "How does this work?") {
  return createComment(db, authorId, lesson.id, null, body, NOW);
}

describe("createComment", () => {
  it("makes a Student's top-level comment a Discussion Question, naming the course's Instructor", () => {
    const created = ask(student.id, "  How does this work?  ");

    expect(created).toMatchObject({
      kind: "discussion_question",
      comment: {
        userId: student.id,
        lessonId: lesson.id,
        parentId: null,
        body: "How does this work?",
        createdAt: NOW.toISOString(),
      },
      questionAuthorId: student.id,
      course: { id: base.course.id, instructorId: base.instructor.id },
      lesson: { id: lesson.id, title: "Hello" },
    });
  });

  it("makes a Platform Admin's top-level comment a Discussion Question", () => {
    expect(ask(platformAdmin.id).kind).toBe("discussion_question");
  });

  it("doesn't make the Instructor's own top-level comment a Discussion Question", () => {
    expect(ask(base.instructor.id).kind).toBe("instructor_comment");
  });

  it("makes an answer a Discussion Reply, naming the question's author", () => {
    const question = ask(student.id).comment;

    const created = createComment(
      db,
      base.instructor.id,
      lesson.id,
      question.id,
      "Like this.",
      NOW
    );

    expect(created).toMatchObject({
      kind: "discussion_reply",
      comment: { parentId: question.id, userId: base.instructor.id },
      questionAuthorId: student.id,
      course: { instructorId: base.instructor.id },
    });
  });

  it("refuses an empty comment", () => {
    expect(() => ask(student.id, "   ")).toThrow("Comment cannot be empty");
  });

  it("refuses a comment that is too long", () => {
    expect(() => ask(student.id, "x".repeat(5001))).toThrow(
      "Comment must be 5000 characters or fewer"
    );
  });

  it("refuses a lesson that doesn't exist", () => {
    expect(() =>
      createComment(db, student.id, 9999, null, "Hi", NOW)
    ).toThrow("Lesson not found");
  });

  it("refuses a reply to a reply", () => {
    const question = ask(student.id).comment;
    const reply = createComment(
      db,
      base.instructor.id,
      lesson.id,
      question.id,
      "Like this.",
      NOW
    ).comment;

    expect(() =>
      createComment(db, student.id, lesson.id, reply.id, "Thanks", NOW)
    ).toThrow("Replies can only be one level deep");
  });

  it("refuses a reply to a comment on a different lesson", () => {
    const question = ask(student.id).comment;

    expect(() =>
      createComment(db, student.id, otherLesson.id, question.id, "Hm", NOW)
    ).toThrow("Parent comment belongs to a different lesson");
  });

  it("refuses a reply to a comment that doesn't exist", () => {
    expect(() =>
      createComment(db, student.id, lesson.id, 9999, "Hm", NOW)
    ).toThrow("Parent comment not found");
  });
});

describe("updateComment", () => {
  it("changes the author's own comment and marks it edited", () => {
    const question = ask(student.id).comment;

    const updated = updateComment(db, question.id, student.id, " Better ", LATER);

    expect(updated).toMatchObject({
      body: "Better",
      editedAt: LATER.toISOString(),
    });
  });

  it("refuses someone else's comment", () => {
    const question = ask(student.id).comment;

    expect(() =>
      updateComment(db, question.id, base.instructor.id, "Mine now", LATER)
    ).toThrow("You can only edit your own comments");
  });
});

describe("deleteComment", () => {
  it("soft-deletes the author's own comment", () => {
    const question = ask(student.id).comment;

    const deleted = deleteComment(db, question.id, student.id, false, LATER);

    expect(deleted).toMatchObject({
      id: question.id,
      body: "How does this work?",
      deletedAt: LATER.toISOString(),
    });
  });

  it("lets staff delete someone else's comment", () => {
    const question = ask(student.id).comment;

    const deleted = deleteComment(db, question.id, platformAdmin.id, true, LATER);

    expect(deleted.deletedAt).toBe(LATER.toISOString());
  });

  it("refuses someone else's comment when not staff", () => {
    const question = ask(student.id).comment;
    const other = db
      .insert(schema.users)
      .values({ name: "Sam", email: "sam@example.com", role: UserRole.Student })
      .returning()
      .get();

    expect(() => deleteComment(db, question.id, other.id, false, LATER)).toThrow(
      "You can only delete your own comments"
    );
  });

  it("keeps the first deletion time when deleted twice", () => {
    const question = ask(student.id).comment;
    deleteComment(db, question.id, student.id, false, NOW);

    const again = deleteComment(db, question.id, student.id, false, LATER);

    expect(again.deletedAt).toBe(NOW.toISOString());
  });

  it("refuses to edit a deleted comment", () => {
    const question = ask(student.id).comment;
    deleteComment(db, question.id, student.id, false, NOW);

    expect(() =>
      updateComment(db, question.id, student.id, "Back", LATER)
    ).toThrow("Comment has been deleted");
  });
});
