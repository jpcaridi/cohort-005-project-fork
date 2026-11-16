import {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { Link, useNavigate } from "react-router";
import {
  Bell,
  Check,
  GraduationCap,
  MessageSquare,
  Receipt,
  Settings,
  UsersRound,
} from "lucide-react";
import { cn } from "~/lib/utils";
import { UserAvatar } from "~/components/user-avatar";
import type { FeedAccess } from "~/lib/notifier.server";
import {
  EMPTY_FEED_STATE,
  badgeLabel,
  describeNotification,
  timeAgo,
  type FeedIcon,
  type FeedNotification,
  type NotificationFeedClient,
} from "~/lib/notification-feed";

// ─── Notification Feed ───
// The bell in the sidebar header and its popover. Components only use the
// NotificationFeedClient interface; the Knock adapter is loaded in the
// browser once a person is signed in and the Feed is configured. Without
// it, the bell opens on the empty state.

const FeedClientContext = createContext<NotificationFeedClient | null>(null);

async function fetchFreshToken(userId: string): Promise<string | null> {
  const response = await fetch("/api/notification-token");
  if (!response.ok) return null;
  const body: unknown = await response.json();
  if (
    typeof body === "object" &&
    body !== null &&
    "userId" in body &&
    "userToken" in body &&
    // Another tab may have switched user since; never mix two people's feeds.
    body.userId === userId &&
    typeof body.userToken === "string"
  ) {
    return body.userToken;
  }
  return null;
}

/**
 * Opens one person's Feed for everything inside it. A new person (the DevUI
 * switcher) tears down the old connection and opens a fresh one.
 */
export function NotificationFeedProvider({
  access,
  children,
}: {
  access: FeedAccess | null;
  children: React.ReactNode;
}) {
  const [client, setClient] = useState<NotificationFeedClient | null>(null);
  // A revalidated loader signs a new token for the same person; the open
  // connection refreshes its own token, so only the person matters here.
  const latestAccess = useRef(access);
  latestAccess.current = access;
  const userId = access?.userId ?? null;

  useEffect(() => {
    const current = latestAccess.current;
    if (!userId || !current) return;
    let cancelled = false;
    let opened: NotificationFeedClient | null = null;
    import("~/lib/knock-feed-client").then(({ createKnockFeedClient }) => {
      if (cancelled) return;
      opened = createKnockFeedClient(current, () => fetchFreshToken(userId));
      setClient(opened);
      void opened.load();
    });
    return () => {
      cancelled = true;
      opened?.teardown();
      setClient(null);
    };
  }, [userId]);

  return (
    <FeedClientContext.Provider value={client}>
      {children}
    </FeedClientContext.Provider>
  );
}

const noop = () => () => {};

function useFeedState(client: NotificationFeedClient | null) {
  return useSyncExternalStore(
    client ? client.subscribe : noop,
    () => (client ? client.getState() : EMPTY_FEED_STATE),
    () => EMPTY_FEED_STATE
  );
}

/** The bell, its unseen badge and the popover. Sits in the sidebar header. */
export function NotificationBell() {
  const client = useContext(FeedClientContext);
  const state = useFeedState(client);
  const [open, setOpen] = useState(false);
  const badge = badgeLabel(state.unseenCount);

  // Seen isn't read: opening clears the badge but leaves rows unread. One
  // arriving while the popover is open is seen too.
  const hasUnseen = state.unseenCount > 0;
  useEffect(() => {
    if (open && hasUnseen) void client?.markAllSeen();
  }, [open, hasUnseen, client]);

  function toggle() {
    setOpen(!open);
  }

  return (
    <>
      <button
        type="button"
        onClick={toggle}
        aria-label={badge ? `Notifications (${badge} unseen)` : "Notifications"}
        aria-expanded={open}
        className="relative rounded-md p-1.5 text-sidebar-foreground/70 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
      >
        <Bell className="size-4" />
        {badge && (
          <span className="absolute -right-1 -top-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-red-500 px-1 text-[10px] font-bold text-white">
            {badge}
          </span>
        )}
      </button>
      {open && (
        <>
          <div
            className="fixed inset-0 z-40"
            onClick={() => setOpen(false)}
            aria-hidden
          />
          <NotificationPopover client={client} close={() => setOpen(false)} />
        </>
      )}
    </>
  );
}

const ICONS: Record<FeedIcon, React.ReactNode> = {
  discussion: <MessageSquare />,
  refund: <Receipt />,
  team: <UsersRound />,
  enrollment: <GraduationCap />,
};

function NotificationPopover({
  client,
  close,
}: {
  client: NotificationFeedClient | null;
  close: () => void;
}) {
  const state = useFeedState(client);
  const navigate = useNavigate();
  const sentinel = useRef<HTMLDivElement>(null);
  const [now, setNow] = useState(() => new Date());

  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), 60_000);
    return () => clearInterval(timer);
  }, []);

  // Infinite scroll: load the next older page when the end comes into view.
  useEffect(() => {
    const el = sentinel.current;
    if (!el || !client) return;
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) void client.loadMore();
    });
    // Re-observing after each page fires again if the end is still visible.
    observer.observe(el);
    return () => observer.disconnect();
  }, [client, state.notifications.length, state.hasMore]);

  function openNotification(
    notification: FeedNotification,
    href: string | null
  ) {
    if (!notification.readAt) void client?.markRead(notification.id);
    // Nowhere to go: it's marked read and the popover stays open.
    if (!href) return;
    close();
    navigate(href);
  }

  const { notifications } = state;

  return (
    <div
      role="dialog"
      aria-label="Notifications"
      className="fixed left-56 top-2 z-50 ml-2 flex max-h-[calc(100vh-1rem)] w-[26rem] flex-col overflow-hidden rounded-xl border bg-popover text-popover-foreground shadow-2xl"
    >
      <div className="flex items-center gap-2 bg-muted/60 px-4 py-3">
        <Bell className="size-4" />
        <span className="font-semibold">Notifications</span>
        <button
          type="button"
          onClick={() => void client?.markAllRead()}
          disabled={state.unreadCount === 0}
          className="ml-auto text-xs font-medium text-primary hover:underline disabled:opacity-40 disabled:hover:no-underline"
        >
          Mark all as read
        </button>
        <Link
          to="/settings#notifications"
          onClick={close}
          aria-label="Notification settings"
          title="Notification settings"
          className="rounded-md p-1 text-muted-foreground hover:bg-background hover:text-foreground"
        >
          <Settings className="size-4" />
        </Link>
      </div>
      <div className="flex-1 overflow-y-auto">
        {notifications.map((notification) => {
          const row = describeNotification(
            notification.data,
            notification.actor?.name ?? null
          );
          const read = Boolean(notification.readAt);
          return (
            <div
              key={notification.id}
              className="flex items-center gap-3 px-4 py-2.5 hover:bg-accent"
            >
              <span className={cn("relative shrink-0", read && "opacity-60")}>
                {notification.actor ? (
                  <UserAvatar
                    name={notification.actor.name}
                    avatarUrl={notification.actor.avatarUrl}
                    className="size-9"
                  />
                ) : (
                  // Sent by Cadence itself, so no sender.
                  <span className="flex size-9 items-center justify-center rounded-full bg-primary text-sm font-bold text-primary-foreground">
                    C
                  </span>
                )}
                <span className="absolute -bottom-0.5 -right-0.5 flex size-4 items-center justify-center rounded-full bg-popover text-muted-foreground ring-1 ring-border [&_svg]:size-2.5">
                  {ICONS[row.icon]}
                </span>
              </span>
              <button
                type="button"
                onClick={() => openNotification(notification, row.href)}
                className="min-w-0 flex-1 text-left"
              >
                <span
                  className={cn(
                    "block truncate text-sm",
                    !read && "font-semibold"
                  )}
                >
                  {row.title}
                </span>
                <span className="block truncate text-xs text-muted-foreground">
                  {row.snippet ? `${row.snippet} · ` : ""}
                  {timeAgo(notification.insertedAt, now)}
                </span>
              </button>
              {!read && (
                <button
                  type="button"
                  onClick={() => void client?.markRead(notification.id)}
                  aria-label="Mark as read"
                  title="Mark as read"
                  className="shrink-0 rounded-full p-1 text-muted-foreground hover:bg-background hover:text-primary"
                >
                  <Check className="size-4" />
                </button>
              )}
            </div>
          );
        })}
        {notifications.length === 0 && !state.loading && (
          <p className="p-8 text-center text-sm text-muted-foreground">
            You're all caught up.
          </p>
        )}
        <div
          ref={sentinel}
          className="p-3 text-center text-xs text-muted-foreground"
        >
          {state.loading && "Loading…"}
        </div>
      </div>
    </div>
  );
}
