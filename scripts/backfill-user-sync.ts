// One-off backfill: syncs every existing user in data.db to Knock and gives
// those without preferences the defaults. Safe to re-run: a user's existing
// preferences are kept. Run with `npm run notifier:backfill-users`.

import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import * as schema from "../app/db/schema";
import { getNotifier, knockSecretKey } from "../app/lib/notifier.server";
import { syncAllUsers } from "../app/lib/user-sync.server";

async function backfill() {
  if (!knockSecretKey()) {
    console.error(
      "No Knock secret key (KNOCK_SECRET_API_KEY or KNOCK_API_KEY) set; nothing to backfill."
    );
    process.exitCode = 1;
    return;
  }

  const sqlite = new Database("data.db", { readonly: true });
  const db = drizzle(sqlite, { schema });

  const synced = await syncAllUsers(db, await getNotifier());
  console.log(`Synced ${synced} users to Knock.`);
}

backfill().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
