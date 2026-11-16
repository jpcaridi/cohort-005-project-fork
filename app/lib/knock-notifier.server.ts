import Knock, { NotFoundError, signUserToken } from "@knocklabs/node";
import type { PreferenceSet } from "@knocklabs/node/resources/recipients/preferences";
import { knockFeedConfig } from "~/lib/notifier.server";
import type {
  KnockFeedConfig,
  Notification,
  NotificationCategory,
  NotificationChannel,
  NotificationKind,
  NotificationPreferences,
  Notifier,
  Person,
  PreferenceChange,
} from "~/lib/notifier.server";

// ─── Knock adapter ───
// The only code that talks to Knock. It maps Cadence's Notifications onto
// Knock workflows; each workflow carries its Knock category (see
// `.knock/workflows/`, pushed with the Knock CLI). Knock user id = Cadence
// user id. Row text is written by Cadence from `data`, not Knock templates.

const WORKFLOW_KEY: Record<NotificationKind, string> = {
  discussion_reply: "discussion-reply",
  discussion_question: "discussion-question",
  refund_requested: "refund-requested",
  refund_approved: "refund-approved",
  refund_declined: "refund-declined",
  open_refund_request: "open-refund-request",
  seat_claimed: "seat-claimed",
  enrollment: "enrollment",
};

export function knockUserId(cadenceUserId: number): string {
  return String(cadenceUserId);
}

function knockUser(person: Person) {
  return {
    id: knockUserId(person.id),
    name: person.name,
    email: person.email,
    avatar: person.avatarUrl,
  };
}

/** How long a signed Feed token lasts. Each layout load signs a fresh one. */
const USER_TOKEN_TTL_SECONDS = 60 * 60;

export function knockNotifier(
  secretKey: string,
  options: { feed?: KnockFeedConfig | null } = {}
): Notifier {
  const knock = new Knock({ apiKey: secretKey });
  const feed = options.feed === undefined ? knockFeedConfig() : options.feed;

  async function mergePreferences(
    userId: number,
    preferences: NotificationPreferences
  ) {
    await knock.users.setPreferences(knockUserId(userId), PREFERENCE_SET, {
      // Knock replaces the whole set unless told to merge.
      __persistence_strategy__: "merge",
      categories: toKnockCategories(preferences),
    });
  }

  return {
    async notify(notification: Notification) {
      await knock.workflows.trigger(
        WORKFLOW_KEY[notification.kind],
        {
          recipients: notification.recipients.map(knockUser),
          // No actor means Cadence itself sent it (the "C" avatar).
          actor: notification.actor ? knockUser(notification.actor) : undefined,
          // Flat values only, so Knock can filter messages by trigger data.
          data: { kind: notification.kind, ...notification.data },
        },
        { idempotencyKey: notification.idempotencyKey }
      );
    },

    async signUserToken(userId: number) {
      if (!feed) return null;
      const id = knockUserId(userId);
      return {
        userId: id,
        // RS256, `sub` = the Knock user id, with an expiry.
        userToken: await signUserToken(id, {
          signingKey: feed.signingKey,
          expiresInSeconds: USER_TOKEN_TTL_SECONDS,
        }),
        publicApiKey: feed.publicApiKey,
        feedChannelId: feed.feedChannelId,
      };
    },

    async archiveByComment(commentId: number) {
      // Filter on the flat `commentId` trigger data. It must stay a number:
      // Knock matches the type it was triggered with.
      const messageIds: string[] = [];
      for await (const message of knock.messages.list({
        trigger_data: JSON.stringify({ commentId }),
      })) {
        if (!message.archived_at) messageIds.push(message.id);
      }
      // An empty batch is a 422.
      if (messageIds.length === 0) return;
      await knock.messages.batch.archive({ message_ids: messageIds });
    },

    async syncUser(person: Person) {
      const { id, ...properties } = knockUser(person);
      await knock.users.update(id, properties);
    },

    async getPreferences(userId: number) {
      let set;
      try {
        set = await knock.users.getPreferences(
          knockUserId(userId),
          PREFERENCE_SET
        );
      } catch (error) {
        if (error instanceof NotFoundError) return null;
        throw error;
      }
      return fromKnockCategories(set.categories);
    },

    mergePreferences,

    async setPreference(
      userId: number,
      { category, channel, enabled }: PreferenceChange
    ) {
      await mergePreferences(userId, { [category]: { [channel]: enabled } });
    },
  };
}

// ─── Preferences ───
// Cadence's category × channel preferences live in each user's "default"
// Knock preference set, as `categories.<knock key>.channel_types.<type>`.

const PREFERENCE_SET = "default";

export const CATEGORY_KEY: Record<NotificationCategory, string> = {
  refund_request_updates: "refund-request-updates",
  open_refund_requests: "open-refund-requests",
  seat_claims: "seat-claims",
  enrollments: "enrollments",
  discussion_questions: "discussion-questions",
  discussion_replies: "discussion-replies",
};

const CHANNEL_TYPE: Record<NotificationChannel, "in_app_feed"> = {
  feed: "in_app_feed",
};

type KnockCategories = NonNullable<PreferenceSet["categories"]>;

function toKnockCategories(preferences: NotificationPreferences) {
  const categories: Record<
    string,
    { channel_types: Partial<Record<"in_app_feed", boolean>> }
  > = {};
  for (const [category, channels] of Object.entries(preferences) as [
    NotificationCategory,
    Partial<Record<NotificationChannel, boolean>>,
  ][]) {
    const channelTypes: Partial<Record<"in_app_feed", boolean>> = {};
    for (const [channel, enabled] of Object.entries(channels) as [
      NotificationChannel,
      boolean,
    ][]) {
      channelTypes[CHANNEL_TYPE[channel]] = enabled;
    }
    categories[CATEGORY_KEY[category]] = { channel_types: channelTypes };
  }
  return categories;
}

/** Null when the set holds none of Cadence's categories. */
function fromKnockCategories(
  categories: KnockCategories | null | undefined
): NotificationPreferences | null {
  if (!categories) return null;
  const preferences: NotificationPreferences = {};
  for (const [category, key] of Object.entries(CATEGORY_KEY) as [
    NotificationCategory,
    string,
  ][]) {
    const setting = categories[key];
    if (setting === undefined) continue;
    const channels: Partial<Record<NotificationChannel, boolean>> = {};
    for (const [channel, type] of Object.entries(CHANNEL_TYPE) as [
      NotificationChannel,
      "in_app_feed",
    ][]) {
      if (typeof setting === "boolean") {
        channels[channel] = setting;
      } else {
        const value = setting.channel_types?.[type];
        // A conditional setting counts as on; a missing one defers to Knock.
        if (value !== undefined && value !== null) {
          channels[channel] = value !== false;
        }
      }
    }
    preferences[category] = channels;
  }
  return Object.keys(preferences).length > 0 ? preferences : null;
}
