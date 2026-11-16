import Knock, { type FeedItem, type FeedStoreState } from "@knocklabs/client";
import type { FeedAccess } from "~/lib/notifier.server";
import type {
  FeedNotification,
  FeedState,
  NotificationFeedClient,
} from "~/lib/notification-feed";

// ─── Knock client adapter ───
// The only browser code that talks to Knock. One Knock instance, one feed
// and one real-time socket per signed-in person. New Notifications arrive
// over the socket; nothing polls (Knock rate-limits quick reads). Seen and
// read for everything use Knock's bulk-by-channel update, so they cover
// Notifications that haven't loaded yet.

const PAGE_SIZE = 20;

function toNotification(item: FeedItem): FeedNotification {
  const actor = item.actors[0];
  return {
    id: item.id,
    insertedAt: item.inserted_at,
    readAt: item.read_at,
    seenAt: item.seen_at,
    actor:
      actor && "name" in actor && actor.name
        ? {
            name: actor.name,
            avatarUrl: "avatar" in actor ? (actor.avatar ?? null) : null,
          }
        : null,
    data: item.data,
  };
}

function toState(state: FeedStoreState): FeedState {
  return {
    notifications: state.items.map(toNotification),
    unseenCount: state.metadata.unseen_count,
    unreadCount: state.metadata.unread_count,
    hasMore: Boolean(state.pageInfo.after),
    loading: state.loading,
  };
}

export function createKnockFeedClient(
  access: FeedAccess,
  /** Asks the server for a fresh token before the current one expires. */
  refreshToken: () => Promise<string | null>
): NotificationFeedClient {
  const knock = new Knock(access.publicApiKey);
  knock.authenticate({ id: access.userId }, access.userToken, {
    // The server owns the user's profile, so don't write it from here.
    identificationStrategy: "skip",
    onUserTokenExpiring: async () => (await refreshToken()) ?? undefined,
    timeBeforeExpirationInMs: 5 * 60 * 1000,
  });
  const feed = knock.feeds.initialize(access.feedChannelId, {
    page_size: PAGE_SIZE,
    archived: "exclude",
  });
  feed.listenForUpdates();

  // Cached so `getState` returns the same object until the store changes.
  let state = toState(feed.store.getState());
  const listeners = new Set<() => void>();
  const unsubscribeStore = feed.store.subscribe((next) => {
    state = toState(next);
    listeners.forEach((listener) => listener());
  });

  function find(id: string) {
    return feed.store.getState().items.find((item) => item.id === id);
  }

  return {
    getState: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async load() {
      await feed.fetch();
    },
    async loadMore() {
      const { pageInfo, loading } = feed.store.getState();
      if (!pageInfo.after || loading) return;
      await feed.fetchNextPage();
    },
    async markRead(id) {
      const item = find(id);
      if (item && !item.read_at) await feed.markAsRead(item);
    },
    async markAllSeen() {
      await feed.markAllAsSeen();
    },
    async markAllRead() {
      await feed.markAllAsRead();
    },
    teardown() {
      unsubscribeStore();
      listeners.clear();
      feed.dispose();
      knock.teardown();
    },
  };
}
