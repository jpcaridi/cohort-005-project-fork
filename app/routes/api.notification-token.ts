import { data } from "react-router";
import type { Route } from "./+types/api.notification-token";
import { getCurrentUserId } from "~/lib/session";
import { getNotifier } from "~/lib/notifier.server";

// A fresh Notification Feed token for the session user, fetched by the
// browser shortly before its current token expires.
export async function loader({ request }: Route.LoaderArgs) {
  const userId = await getCurrentUserId(request);
  if (!userId) throw data("Not signed in", { status: 401 });

  const notifier = await getNotifier();
  const access = await notifier.signUserToken(userId);
  if (!access) throw data("Notification Feed not configured", { status: 404 });

  return { userId: access.userId, userToken: access.userToken };
}
