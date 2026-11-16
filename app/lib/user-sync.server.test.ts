import { describe, it, expect, beforeEach, vi } from "vitest";
import { createTestDb, seedBaseData } from "~/test/setup";
import { syncAllUsers, syncUser } from "./user-sync.server";
import {
  createFakeNotifier,
  type FakeNotifier,
  type Notifier,
} from "./notifier.server";

type TestDb = ReturnType<typeof createTestDb>;

let db: TestDb;
let base: ReturnType<typeof seedBaseData>;
let notifier: FakeNotifier;

beforeEach(() => {
  db = createTestDb();
  base = seedBaseData(db);
  notifier = createFakeNotifier();
});

const DEFAULTS = {
  refund_request_updates: { feed: true },
  open_refund_requests: { feed: true },
  seat_claims: { feed: true },
  enrollments: { feed: false },
  discussion_questions: { feed: true },
  discussion_replies: { feed: true },
};

describe("syncUser", () => {
  it("identifies the user with their name, email and avatar", async () => {
    await syncUser(notifier, {
      id: 7,
      name: "Ada",
      email: "ada@example.com",
      avatarUrl: "https://example.com/ada.png",
    });

    expect(notifier.syncedUsers).toEqual([
      {
        id: 7,
        name: "Ada",
        email: "ada@example.com",
        avatarUrl: "https://example.com/ada.png",
      },
    ]);
  });

  it("gives a user with no preferences the defaults: Enrollments off, the rest on, Feed only", async () => {
    await syncUser(notifier, base.user);

    expect(await notifier.getPreferences(base.user.id)).toEqual(DEFAULTS);
  });

  it("keeps the preferences of a user who already has some", async () => {
    await syncUser(notifier, base.user);
    await notifier.setPreference(base.user.id, {
      category: "discussion_replies",
      channel: "feed",
      enabled: false,
    });

    await syncUser(notifier, { ...base.user, name: "Renamed" });

    expect(await notifier.getPreferences(base.user.id)).toEqual({
      ...DEFAULTS,
      discussion_replies: { feed: false },
    });
    expect(notifier.syncedUsers.at(-1)?.name).toBe("Renamed");
  });

  it("logs a failure and doesn't throw", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const failing: Notifier = {
      ...notifier,
      async syncUser() {
        throw new Error("Knock is down");
      },
    };

    await expect(syncUser(failing, base.user)).resolves.toBeUndefined();
    expect(error).toHaveBeenCalled();
    error.mockRestore();
  });
});

describe("syncAllUsers", () => {
  it("syncs every existing user and gives them the defaults", async () => {
    const count = await syncAllUsers(db, notifier);

    expect(count).toBe(2);
    expect(notifier.syncedUsers.map((u) => u.id).sort()).toEqual(
      [base.user.id, base.instructor.id].sort()
    );
    expect(await notifier.getPreferences(base.instructor.id)).toEqual(DEFAULTS);
  });
});
