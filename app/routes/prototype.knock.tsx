// PROTOTYPE — throwaway spike for "Does Knock hold up against Cadence?" (issue #32).
// Lives on the prototype/knock-fit branch only. Never merge.
// Question: does Knock pass four checks against the real app (signed user
// tokens + DevUI switcher, Node triggering, headless feed API, opt-in prefs)?
import { useEffect, useRef, useState } from "react";
import { data, useFetcher } from "react-router";
import { z } from "zod";
import { ne, eq } from "drizzle-orm";
import type { Route } from "./+types/prototype.knock";
import type KnockClient from "@knocklabs/client";
import type { Feed, FeedItem, PreferenceSet } from "@knocklabs/client";
import { db } from "~/db";
import { users } from "~/db/schema";
import { getCurrentUserId } from "~/lib/session";
import { parseFormData } from "~/lib/validation";
import {
  WORKFLOWS,
  identify,
  knockConfig,
  knockUserId,
  resetPreferences,
  signTokenFor,
  triggerDiscussionReply,
  triggerNewEnrollment,
} from "~/lib/knock-prototype.server";
import { Button } from "~/components/ui/button";
import { Card, CardContent, CardHeader } from "~/components/ui/card";

const KNOCK_API = "https://api.knock.app/v1";

function loadCurrentUser(userId: number) {
  const user = db.select().from(users).where(eq(users.id, userId)).get();
  if (!user) throw data("User not found.", { status: 404 });
  return user;
}

export async function loader({ request }: Route.LoaderArgs) {
  const userId = await getCurrentUserId(request);
  if (!userId) {
    throw data("Select a user from the DevUI panel.", { status: 401 });
  }
  const user = loadCurrentUser(userId);
  const otherUser = db.select().from(users).where(ne(users.id, userId)).get();
  if (!otherUser) throw data("Need a second user in the DB.", { status: 500 });

  await identify(user);
  const userToken = await signTokenFor(user);

  return {
    user: { id: user.id, name: user.name, role: user.role },
    knockUserId: knockUserId(user),
    otherKnockUserId: knockUserId(otherUser),
    otherUserName: otherUser.name,
    userToken,
    publicApiKey: knockConfig.publicApiKey,
    feedChannelId: knockConfig.feedChannelId,
    workflows: WORKFLOWS,
  };
}

const actionSchema = z.object({
  intent: z.enum(["discussion-reply", "new-enrollment", "reset-preferences"]),
});

export async function action({ request }: Route.ActionArgs) {
  const userId = await getCurrentUserId(request);
  if (!userId) throw data("Select a user from the DevUI panel.", { status: 401 });
  const parsed = parseFormData(await request.formData(), actionSchema);
  if (!parsed.success) throw data("Bad intent", { status: 400 });

  const user = loadCurrentUser(userId);
  const otherUser = db.select().from(users).where(ne(users.id, userId)).get();
  if (!otherUser) throw data("Need a second user in the DB.", { status: 500 });

  // Prototype: surface vendor errors on the page instead of throwing.
  try {
    switch (parsed.data.intent) {
      case "discussion-reply": {
        const res = await triggerDiscussionReply(user, otherUser);
        return { ok: true, message: `Triggered ${WORKFLOWS.discussionReply}: ${res.workflow_run_id}` };
      }
      case "new-enrollment": {
        const res = await triggerNewEnrollment(user, otherUser);
        return { ok: true, message: `Triggered ${WORKFLOWS.newEnrollment}: ${res.workflow_run_id}` };
      }
      case "reset-preferences": {
        await resetPreferences(user);
        return { ok: true, message: "Preferences reset to environment defaults" };
      }
    }
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) };
  }
}

type ProbeResult = { label: string; expected: string; status: string };

async function probeFeed(
  publicApiKey: string,
  feedChannelId: string,
  userId: string,
  userToken: string | null
) {
  const headers: Record<string, string> = { Authorization: `Bearer ${publicApiKey}` };
  if (userToken) headers["X-Knock-User-Token"] = userToken;
  const res = await fetch(`${KNOCK_API}/users/${userId}/feeds/${feedChannelId}`, { headers });
  return `${res.status} ${res.statusText}`;
}

function decodeJwtPayload(token: string): unknown {
  const part = token.split(".")[1] ?? "";
  return JSON.parse(atob(part.replace(/-/g, "+").replace(/_/g, "/")));
}

export default function KnockPrototype({ loaderData }: Route.ComponentProps) {
  const {
    user,
    knockUserId: userId,
    otherKnockUserId,
    otherUserName,
    userToken,
    publicApiKey,
    feedChannelId,
    workflows,
  } = loaderData;
  const fetcher = useFetcher<typeof action>();

  const knockRef = useRef<KnockClient | null>(null);
  const feedRef = useRef<Feed | null>(null);
  const [items, setItems] = useState<FeedItem[]>([]);
  const [meta, setMeta] = useState({ total_count: 0, unread_count: 0, unseen_count: 0 });
  const [feedError, setFeedError] = useState<string | null>(null);
  const [prefs, setPrefs] = useState<PreferenceSet | null>(null);
  const [prefsError, setPrefsError] = useState<string | null>(null);
  const [probes, setProbes] = useState<ProbeResult[]>([]);

  // Check 1 + 3: authenticate the headless client with the signed token for
  // whichever DevUI user is selected; re-run on every user switch.
  useEffect(() => {
    let cancelled = false;
    let teardown = () => {};
    (async () => {
      const { default: Knock } = await import("@knocklabs/client");
      if (cancelled) return;
      const knock = new Knock(publicApiKey);
      knock.authenticate(userId, userToken);
      const feed = knock.feeds.initialize(feedChannelId);
      feed.listenForUpdates();
      const sync = () => {
        const state = feed.getState();
        setItems([...state.items]);
        setMeta(state.metadata);
      };
      feed.on("items.*", sync);
      feed.on("items.received.*", sync);
      try {
        await feed.fetch();
        sync();
        setFeedError(null);
      } catch (error) {
        setFeedError(String(error));
      }
      knockRef.current = knock;
      feedRef.current = feed;
      teardown = () => {
        feed.teardown();
        knock.teardown();
      };
      void loadPrefs();
    })();
    return () => {
      cancelled = true;
      teardown();
      knockRef.current = null;
      feedRef.current = null;
      setItems([]);
      setPrefs(null);
      setProbes([]);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userId, userToken, publicApiKey, feedChannelId]);

  // Refetch the feed + prefs after any server-side trigger/reset.
  useEffect(() => {
    if (fetcher.state === "idle" && fetcher.data) {
      void feedRef.current?.fetch();
      void loadPrefs();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fetcher.state, fetcher.data]);

  async function loadPrefs() {
    const knock = knockRef.current;
    if (!knock) return;
    try {
      setPrefs(await knock.user.getPreferences());
      setPrefsError(null);
    } catch (error) {
      setPrefsError(String(error));
    }
  }

  async function setEnrollmentOptIn(enabled: boolean) {
    const knock = knockRef.current;
    if (!knock) return;
    try {
      const current = await knock.user.getPreferences();
      setPrefs(
        await knock.user.setPreferences({
          categories: current.categories ?? undefined,
          channel_types: current.channel_types ?? undefined,
          channels: current.channels ?? undefined,
          workflows: { ...(current.workflows ?? {}), [workflows.newEnrollment]: enabled },
        })
      );
      setPrefsError(null);
    } catch (error) {
      setPrefsError(String(error));
    }
  }

  async function runProbes() {
    setProbes([
      {
        label: `Own feed (user ${userId}) with own signed token`,
        expected: "200",
        status: await probeFeed(publicApiKey, feedChannelId, userId, userToken),
      },
      {
        label: `Own feed with NO token`,
        expected: "401 (only if enhanced security is on)",
        status: await probeFeed(publicApiKey, feedChannelId, userId, null),
      },
      {
        label: `${otherUserName}'s feed (user ${otherKnockUserId}) with MY token`,
        expected: "401/403",
        status: await probeFeed(publicApiKey, feedChannelId, otherKnockUserId, userToken),
      },
    ]);
  }

  return (
    <div className="mx-auto max-w-4xl space-y-6 p-6">
      <div className="rounded-md border border-amber-400 bg-amber-50 p-3 text-sm text-amber-900 dark:bg-amber-950/30 dark:text-amber-200">
        <strong>PROTOTYPE</strong>: Does Knock hold up against Cadence? Throwaway spike for
        issue #32. Switch users in the DevUI panel and every panel below re-authenticates.
      </div>

      <h1 className="text-2xl font-semibold">
        Knock spike: {user.name} <span className="text-muted-foreground">({user.role}, Knock id {userId})</span>
      </h1>

      {fetcher.data && (
        <div className={fetcher.data.ok ? "text-sm text-green-700" : "text-sm text-red-700"}>
          {fetcher.data.message}
        </div>
      )}

      <Card>
        <CardHeader><h2 className="font-semibold">1. Signed user tokens</h2></CardHeader>
        <CardContent className="space-y-3 text-sm">
          <pre className="overflow-x-auto rounded bg-muted p-2 text-xs">
            {JSON.stringify(decodeJwtPayload(userToken), null, 2)}
          </pre>
          <Button size="sm" onClick={() => void runProbes()}>Run token probes</Button>
          {probes.length > 0 && (
            <table className="w-full text-left text-xs">
              <thead><tr><th>Request</th><th>Expected</th><th>Got</th></tr></thead>
              <tbody>
                {probes.map((p) => (
                  <tr key={p.label}><td>{p.label}</td><td>{p.expected}</td><td className="font-mono">{p.status}</td></tr>
                ))}
              </tbody>
            </table>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader><h2 className="font-semibold">2. Triggering from the Node SDK</h2></CardHeader>
        <CardContent className="flex flex-wrap gap-2">
          <fetcher.Form method="post">
            <input type="hidden" name="intent" value="discussion-reply" />
            <Button size="sm" type="submit">
              Discussion Reply → me (from {otherUserName})
            </Button>
          </fetcher.Form>
        </CardContent>
      </Card>

      <Card>
        <CardHeader><h2 className="font-semibold">3. Headless feed API</h2></CardHeader>
        <CardContent className="space-y-3 text-sm">
          <div className="flex gap-4 font-mono">
            <span>total {meta.total_count}</span>
            <span>unread {meta.unread_count}</span>
            <span>unseen {meta.unseen_count}</span>
          </div>
          <div className="flex gap-2">
            <Button size="sm" variant="outline" onClick={() => void feedRef.current?.fetch()}>Refetch</Button>
            <Button size="sm" variant="outline" onClick={() => void feedRef.current?.markAllAsSeen()}>Mark all seen</Button>
            <Button size="sm" variant="outline" onClick={() => void feedRef.current?.markAllAsRead()}>Mark all read</Button>
          </div>
          {feedError && <div className="text-red-700">{feedError}</div>}
          <ul className="divide-y rounded border">
            {items.map((item) => (
              <li key={item.id} className="flex items-center justify-between gap-2 p-2">
                <div>
                  <div className="font-medium">
                    {item.source.key}
                    {!item.read_at && <span className="ml-2 text-xs text-blue-600">unread</span>}
                    {!item.seen_at && <span className="ml-2 text-xs text-amber-600">unseen</span>}
                  </div>
                  <div className="text-xs text-muted-foreground">
                    {JSON.stringify(item.data)} · {new Date(item.inserted_at).toLocaleTimeString()}
                  </div>
                </div>
                <div className="flex shrink-0 gap-1">
                  <Button size="sm" variant="ghost" onClick={() => void feedRef.current?.markAsSeen(item)}>Seen</Button>
                  {item.read_at ? (
                    <Button size="sm" variant="ghost" onClick={() => void feedRef.current?.markAsUnread(item)}>Unread</Button>
                  ) : (
                    <Button size="sm" variant="ghost" onClick={() => void feedRef.current?.markAsRead(item)}>Read</Button>
                  )}
                </div>
              </li>
            ))}
            {items.length === 0 && <li className="p-2 text-muted-foreground">Feed is empty.</li>}
          </ul>
        </CardContent>
      </Card>

      <Card>
        <CardHeader><h2 className="font-semibold">4. Opt-in preference (new Enrollment → Instructor)</h2></CardHeader>
        <CardContent className="space-y-3 text-sm">
          <p>
            Expected: with no preferences of my own, triggering <code>{workflows.newEnrollment}</code> delivers
            nothing. After I opt in, it lands in the feed.
          </p>
          <div className="flex flex-wrap gap-2">
            <fetcher.Form method="post">
              <input type="hidden" name="intent" value="new-enrollment" />
              <Button size="sm" type="submit">Trigger new Enrollment → me</Button>
            </fetcher.Form>
            <Button size="sm" variant="outline" onClick={() => void setEnrollmentOptIn(true)}>Opt in (as user)</Button>
            <Button size="sm" variant="outline" onClick={() => void setEnrollmentOptIn(false)}>Opt out (as user)</Button>
            <fetcher.Form method="post">
              <input type="hidden" name="intent" value="reset-preferences" />
              <Button size="sm" variant="ghost" type="submit">Reset my preferences</Button>
            </fetcher.Form>
          </div>
          {prefsError && <div className="text-red-700">{prefsError}</div>}
          <pre className="overflow-x-auto rounded bg-muted p-2 text-xs">
            {prefs ? JSON.stringify(prefs, null, 2) : "Loading preferences…"}
          </pre>
        </CardContent>
      </Card>
    </div>
  );
}
