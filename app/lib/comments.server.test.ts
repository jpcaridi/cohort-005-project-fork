import { describe, it, expect, beforeEach, vi } from "vitest";
import { createTestDb, seedBaseData } from "~/test/setup";
import * as schema from "~/db/schema";
import { UserRole } from "~/db/schema";
import { createComment, deleteComment, updateComment } from "./comments.server";
import {
  createFakeNotifier,
  type FakeNotifier,
  type Notifier,
} from "./notifier.server";

type TestDb = ReturnType<typeof createTestDb>;

const NOW = new Date(2026, 9, 6, 12, 0, 0);
const LATER = new Date(2026, 9, 7, 9, 30, 0);

let db: TestDb;
let base: ReturnType<typeof seedBaseData>;
let lesson: typeof schema.lessons.$inferSelect;
let otherLesson: typeof schema.lessons.$inferSelect;
let student: typeof schema.users.$inferSelect;
let platformAdmin: typeof schema.users.$inferSelect;
let notifier: FakeNotifier;

beforeEach(() => {
  db = createTestDb();
  notifier = createFakeNotifier();
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
  return createComment(db, notifier, authorId, lesson.id, null, body, NOW);
}

describe("createComment", () => {
  it("makes a Student's top-level comment a Discussion Question, naming the course's Instructor", async () => {
    const created = await ask(student.id, "  How does this work?  ");

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

  it("makes a Platform Admin's top-level comment a Discussion Question", async () => {
    expect((await ask(platformAdmin.id)).kind).toBe("discussion_question");
  });

  it("doesn't make the Instructor's own top-level comment a Discussion Question", async () => {
    expect((await ask(base.instructor.id)).kind).toBe("instructor_comment");
  });

  it("makes an answer a Discussion Reply, naming the question's author", async () => {
    const question = (await ask(student.id)).comment;

    const created = await createComment(
      db,
      notifier,
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

  it("refuses an empty comment", async () => {
    await expect(ask(student.id, "   ")).rejects.toThrow("Comment cannot be empty");
  });

  it("refuses a comment that is too long", async () => {
    await expect(ask(student.id, "x".repeat(5001))).rejects.toThrow(
      "Comment must be 5000 characters or fewer"
    );
  });

  it("refuses a lesson that doesn't exist", async () => {
    await expect(
      createComment(db, notifier, student.id, 9999, null, "Hi", NOW)
    ).rejects.toThrow("Lesson not found");
  });

  it("refuses a reply to a reply", async () => {
    const question = (await ask(student.id)).comment;
    const reply = (await createComment(
      db,
      notifier,
      base.instructor.id,
      lesson.id,
      question.id,
      "Like this.",
      NOW
    )).comment;

    await expect(
      createComment(db, notifier, student.id, lesson.id, reply.id, "Thanks", NOW)
    ).rejects.toThrow("Replies can only be one level deep");
  });

  it("refuses a reply to a comment on a different lesson", async () => {
    const question = (await ask(student.id)).comment;

    await expect(
      createComment(db, notifier, student.id, otherLesson.id, question.id, "Hm", NOW)
    ).rejects.toThrow("Parent comment belongs to a different lesson");
  });

  it("refuses a reply to a comment that doesn't exist", async () => {
    await expect(
      createComment(db, notifier, student.id, lesson.id, 9999, "Hm", NOW)
    ).rejects.toThrow("Parent comment not found");
  });
});

function reply(authorId: number, questionId: number, body = "Like this.") {
  return createComment(db, notifier, authorId, lesson.id, questionId, body, NOW);
}

describe("Discussion Reply Notifications", () => {
  it("tells the Discussion Question's author when someone else replies", async () => {
    const question = (await ask(student.id)).comment;

    const answer = (await reply(base.instructor.id, question.id, "Like this.")).comment;

    expect(notifier.notifications).toEqual([
      {
        kind: "discussion_reply",
        recipients: [
          {
            id: student.id,
            name: "Test User",
            email: "test@example.com",
            avatarUrl: null,
          },
        ],
        actor: {
          id: base.instructor.id,
          name: "Test Instructor",
          email: "instructor@example.com",
          avatarUrl: null,
        },
        idempotencyKey: `comment:${answer.id}`,
        data: {
          commentId: answer.id,
          courseTitle: base.course.title,
          lessonTitle: "Hello",
          snippet: "Like this.",
          url: `/courses/${base.course.slug}/lessons/${lesson.id}#comment-${answer.id}`,
        },
      },
    ]);
  });

  it("tells nobody when the author replies in their own thread", async () => {
    const question = (await ask(student.id)).comment;

    await reply(student.id, question.id, "Never mind, got it.");

    expect(notifier.notifications).toEqual([]);
  });

  it("tells the Instructor when someone replies to the Instructor's own top-level comment", async () => {
    const note = (await ask(base.instructor.id, "Read chapter 2 first.")).comment;

    await reply(student.id, note.id, "Will do!");

    expect(notifier.notifications).toMatchObject([
      {
        kind: "discussion_reply",
        recipients: [{ id: base.instructor.id }],
        actor: { id: student.id },
      },
    ]);
  });

  it("sends nothing for a top-level comment", async () => {
    await ask(student.id);
    await ask(base.instructor.id);

    expect(notifier.notifications).toEqual([]);
  });

  it("quotes only the start of a long reply", async () => {
    const question = (await ask(student.id)).comment;

    await reply(platformAdmin.id, question.id, `Start\n\n${"word ".repeat(100)}`);

    const [sent] = notifier.notifications;
    expect(sent.data.snippet).toMatch(/^Start word word /);
    expect(sent.data.snippet.length).toBeLessThanOrEqual(140);
    expect(sent.data.snippet.endsWith("…")).toBe(true);
  });

  it("still posts the reply, and logs, when the Notifier fails", async () => {
    const question = (await ask(student.id)).comment;
    const failing: Notifier = {
      ...createFakeNotifier(),
      async notify() {
        throw new Error("Knock is down");
      },
    };
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});

    const created = await createComment(
      db,
      failing,
      base.instructor.id,
      lesson.id,
      question.id,
      "Like this.",
      NOW
    );

    expect(created.comment).toMatchObject({
      parentId: question.id,
      body: "Like this.",
    });
    expect(errorLog).toHaveBeenCalledWith(
      expect.stringContaining(`comment:${created.comment.id}`),
      expect.any(Error)
    );
    errorLog.mockRestore();
  });
});

describe("updateComment", () => {
  it("changes the author's own comment and marks it edited", async () => {
    const question = (await ask(student.id)).comment;

    const updated = updateComment(db, question.id, student.id, " Better ", LATER);

    expect(updated).toMatchObject({
      body: "Better",
      editedAt: LATER.toISOString(),
    });
  });

  it("refuses someone else's comment", async () => {
    const question = (await ask(student.id)).comment;

    expect(() =>
      updateComment(db, question.id, base.instructor.id, "Mine now", LATER)
    ).toThrow("You can only edit your own comments");
  });
});

describe("deleteComment", () => {
  it("soft-deletes the author's own comment", async () => {
    const question = (await ask(student.id)).comment;

    const deleted = deleteComment(db, question.id, student.id, false, LATER);

    expect(deleted).toMatchObject({
      id: question.id,
      body: "How does this work?",
      deletedAt: LATER.toISOString(),
    });
  });

  it("lets staff delete someone else's comment", async () => {
    const question = (await ask(student.id)).comment;

    const deleted = deleteComment(db, question.id, platformAdmin.id, true, LATER);

    expect(deleted.deletedAt).toBe(LATER.toISOString());
  });

  it("refuses someone else's comment when not staff", async () => {
    const question = (await ask(student.id)).comment;
    const other = db
      .insert(schema.users)
      .values({ name: "Sam", email: "sam@example.com", role: UserRole.Student })
      .returning()
      .get();

    expect(() => deleteComment(db, question.id, other.id, false, LATER)).toThrow(
      "You can only delete your own comments"
    );
  });

  it("keeps the first deletion time when deleted twice", async () => {
    const question = (await ask(student.id)).comment;
    deleteComment(db, question.id, student.id, false, NOW);

    const again = deleteComment(db, question.id, student.id, false, LATER);

    expect(again.deletedAt).toBe(NOW.toISOString());
  });

  it("refuses to edit a deleted comment", async () => {
    const question = (await ask(student.id)).comment;
    deleteComment(db, question.id, student.id, false, NOW);

    expect(() =>
      updateComment(db, question.id, student.id, "Back", LATER)
    ).toThrow("Comment has been deleted");
  });
});
