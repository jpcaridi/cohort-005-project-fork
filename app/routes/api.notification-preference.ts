import { data } from "react-router";
import { z } from "zod";
import type { Route } from "./+types/api.notification-preference";
import { db } from "~/db";
import { getCurrentUserId } from "~/lib/session";
import { parseFormData } from "~/lib/validation";
import { getNotifier } from "~/lib/notifier.server";
import { isNotificationCategory } from "~/lib/notification-categories";
import {
  NotificationSettingNotSaved,
  saveNotificationSetting,
} from "~/lib/notification-settings.server";

// Saves one switch on the /settings Notifications card. A resource route, so
// the switch can post to it with `fetch` and revert itself when the save
// fails (a non-2xx response), instead of the failure taking over the page.

const preferenceSchema = z.object({
  category: z.string().refine(isNotificationCategory, "Unknown category."),
  enabled: z.enum(["true", "false"]).transform((v) => v === "true"),
});

export async function action({ request }: Route.ActionArgs) {
  const userId = await getCurrentUserId(request);
  if (!userId) {
    throw data("Select a user from the DevUI panel.", { status: 401 });
  }

  const parsed = parseFormData(await request.formData(), preferenceSchema);
  if (!parsed.success) {
    throw data("Invalid notification setting.", { status: 400 });
  }

  try {
    await saveNotificationSetting(
      db,
      await getNotifier(),
      userId,
      parsed.data.category,
      parsed.data.enabled
    );
  } catch (error) {
    if (error instanceof NotificationSettingNotSaved) {
      throw data(error.message, { status: error.status });
    }
    throw error;
  }

  return { saved: true };
}
