# Hosted notification vendors for Cadence in-app Notifications

**Question:** Which hosted notification services could Cadence use for an in-app Notifications feature? ([issue #11](https://github.com/jpcaridi/cohort-005-project-fork/issues/11))

**Date researched:** 2026-11-13

**Context:** Cadence uses React Router v7 (framework mode, SSR) with Node and one SQLite file through Drizzle. There is no real auth locally: users are switched from a DevUI panel, so the recipient is identified only by our internal user id. We need in-app notifications now and may add email later. **Hard requirement:** the vendor ships a pre-built React inbox/feed component that we can restyle.

**Method:** All claims come from primary sources: vendor docs, pricing pages, vendor GitHub repos, and the vendor's own npm packages (versions checked with `npm view` on 2026-11-13). Anything not confirmed in a primary source is marked **unverified**. This document does not recommend a vendor.

## Comparison

| Vendor | Pre-built React inbox | Free tier / paid entry | Email later | Recipient id & client auth | Deep link / data | Read / seen / archive | Real-time | Preferences UI | Node SDK |
|---|---|---|---|---|---|---|---|---|---|
| **Knock** | Yes: `@knocklabs/react` (CSS vars `--rnf-*`, `renderItem`) [K1] | 10k messages/mo free; Starter $250/mo [K2] | Same workflow, email channel step [K8] | Your own id (≤256 chars); public key + id in dev, RS256 JWT in prod [K3][K4] | `action_url` + click handlers [K1] | seen, read, interacted, archived [K5] | Sockets [K1] | **No pre-built component**; build with client/hooks [K6] | `@knocklabs/node` [NPM] |
| **Courier** | Yes: `@trycourier/courier-react` (`CourierInbox`, theme objects) [C1] | 10k sends/mo free; then $0.005/send, all sends billed [C2] | Add `email` to routing channels [C3] | `user_id` string; **JWT always required** (from `/auth/issue-token`) [C4] | `data` object passed through; actions [C5][C1] | read, opened, archived [C1] | Yes, `listenForUpdates()` [C1] | Yes: `CourierPreferences` [C1] | `@trycourier/courier` [NPM] |
| **MagicBell** | Yes: `@magicbell/react` (CSS custom props + class names) [M1] | 1k deliveries/mo free; Startup $249/mo [M2] | Same broadcast, `email` channel override [M3] | `external_id`; User JWT signed on backend [M1][M4] | `action_url`, `custom_attributes` [M3] | read, unread, archive [M5] | WebSocket [M5] | Yes: `UserPreferences` [M1] | `magicbell-js` [M5] |
| **Novu Cloud** | Yes: `@novu/react` `<Inbox />` (`appearance` variables/elements, render props) [N1][N2][N3] | 10k workflow runs/mo free (24h log retention, 5 workflows); Pro from $30/mo [N4] | Email step in same workflow [N5] | `subscriberId`; HMAC `subscriberHash` toggled per env [N6] | Redirect URL via `routerPush`; `data` [N3] | read, archive, snooze [N3] | Yes (socket URL) [N1] | Yes: built-in panel / `<Preferences />` [N7] | `@novu/api` [N8] |
| **Stream Activity Feeds** | **No.** Hooks/state only; old UI kit archived [S1][S2][S3] | Build: 5k activities + 125k API calls/mo free; Start $499/mo (annual) [S4] | Not part of the product (**unverified**) | `connectUser({id}, token)`; backend-signed token [S1] | `custom` on activity [S2] | is_seen, is_read (archive **unverified**) [S2] | WebSocket [S1] | None found | `@stream-io/node-sdk` / `getstream` [NPM] |
| **SuprSend** | Yes: `@suprsend/react` (`Inbox`, `theme` + `themeType`, custom components) [P1][P2] | 10k notifications/mo free (with branding); Essentials $100/mo [P3] | Email node in same workflow [P4] | `distinctId` (user auto-created); ES256 JWT when enhanced security is on [P1] | Action URL; `notificationData` [P2] | read, unread, seen, archived, interacted [P2] | socket.io [P5] | Yes: `Preferences` [P1] | `@suprsend/node-sdk` [NPM] |

## Per-vendor notes

### Knock

1. **Inbox component.** `@knocklabs/react` provides `KnockProvider`, `KnockFeedProvider`, `NotificationIconButton`, `NotificationFeedPopover`, and `NotificationFeed`. To style it, import `@knocklabs/react/dist/index.css` and override the `--rnf-*` CSS variables, or replace the CSS entirely (all classes start with `rnf-`). `colorMode="dark"` switches to dark mode. You can also customize through `renderItem`, `children`, or a custom avatar [K1]. Version 0.15.1 on npm [NPM]. **SSR:** the Next.js quickstart marks the inbox file `"use client"`. There is no SSR guidance beyond that [K7].
2. **Pricing.** The free plan includes 10,000 messages/mo. Starter costs $250/mo with 50k messages included, then $0.005/message. Billing is per message, where one message is one delivery to one user on one channel. Enterprise can use notified-user pricing instead [K2].
3. **Email later.** Workflows are multi-channel, and email is a channel with its own settings and layouts [K8].
4. **Recipients and auth.** The user id can be up to 256 characters, cannot contain `/` or `#`, and cannot be changed later. Knock recommends using your internal id. A user must exist in Knock before they can be notified, but users can be identified inline when a workflow is triggered [K3]. Passing a user that doesn't exist to the client creates it through client-side inline identification [K7]. In dev, the public key plus `authenticate({ id })` works for any user. In prod, "enhanced security mode" requires a backend-signed RS256 JWT with `sub` set to the user id [K4].
5. **Deep links and data.** If `action_url` is set in the template, the provider attaches a redirect handler. `onNotificationClick` and `onNotificationButtonClick` let you handle clicks yourself [K1]. The feed docs do not describe arbitrary payload fields beyond the item (**unverified** from this page).
6. **State.** Knock tracks `seen_at`, `read_at`, `interacted_at`, `link_clicked_at`, and `archived_at` [K5]. By default, opening the popover marks items as seen [K1].
7. **Real-time.** The feed uses sockets. `auto_manage_socket_connection` disconnects inactive tabs, and an experimental option syncs tabs over BroadcastChannel [K1].
8. **Preferences.** The React preferences guide builds the UI by hand with `@knocklabs/client`. It does not document a pre-built component [K6].
9. **Node SDK.** `@knocklabs/node` 1.41.1 [NPM], from the repo `knocklabs/knock-node` [K9].
- **Risks.** EU data residency is not available yet. Knock's docs say they "expect to support EU data residency by the end of 2026" [K10]. Starter has a $250/mo floor.

### Courier

1. **Inbox component.** `@trycourier/courier-react` (React 18+, with a separate `-react-17` package) provides `CourierInbox`, `CourierInboxPopupMenu`, `CourierToast`, and `CourierPreferences`. Each component takes a theme object (`CourierInboxTheme` and similar), and parts can be custom-rendered. `useCourier()` supports headless use [C1]. The React components wrap Courier's web components from the `courier-web` monorepo [C6]. Whether those use shadow DOM, which would affect how far you can restyle them, is **unverified**. **SSR:** components render on the client only, and Next.js files need `'use client'` [C1]. Version 9.3.5 on npm. The older `@trycourier/react-inbox` is deprecated in favor of this package [NPM].
2. **Pricing.** The Developer plan is free with 10k sends/mo. Business is pay-as-you-go at $0.005/send, and the first 10k are billed too. A send is one template to one recipient, so several channels in one send still count as one send. Test environments are billed like production. EU data residency appears on the pricing page, but which tier includes it is unclear [C2].
3. **Email later.** Add `inbox` and `email` together in the message routing. Cross-channel sync can mark the inbox message read when the user opens the email [C3].
4. **Recipients and auth.** The send targets `to: { user_id }`. For inbox, the `user_id` itself is the address, and authenticating a user registers them, so no profile needs to exist first [C5][C7]. The client always needs a JWT that your backend mints through `POST /auth/issue-token` with scopes such as `user_id:<id> inbox:read:messages inbox:write:events`. There is no public-key-only dev mode. For local testing, the CLI can issue a token [C4].
5. **Deep links and data.** The `data` object passes through to the SDK "untouched, which is useful for deep linking" [C5]. Messages also carry `actions` [C1]. A dedicated action-URL field is **unverified**.
6. **State.** Messages have `read`, `opened`, and `archived` timestamps, and tabs can filter by them [C1].
7. **Real-time.** Call `inbox.listenForUpdates()` after sign-in, or the inbox loads once and stops updating [C1]. State changes sync across devices [C3]. The transport is not named on these pages (**unverified**).
8. **Preferences.** `CourierPreferences` is a pre-built preference center. It needs the `read:preferences write:preferences` JWT scopes [C1][C4].
9. **Node SDK.** `@trycourier/courier` 10.0.0 [NPM].
- **Risks.** The JWT requirement means even local dev needs a server route (or CLI tokens) to mint tokens. The free tier and the per-send rate are the same as Knock's.

### MagicBell

1. **Inbox component.** `@magicbell/react` provides `ContextProvider`, `Inbox`, `FloatingInbox`, `InlineNotification`, `ToastContainer`, `UserPreferences`, and others. You import a stylesheet per component, then style through class names (e.g. `magicbell--button`) and CSS custom properties (e.g. `--magicbell-bg-default`) [M1]. **SSR:** not covered (**unverified**). npm also lists the older `@magicbell/magicbell-react` and `@magicbell/react-headless`, last published 2026-05. `@magicbell/core` is marked deprecated [NPM]. The docs only cover `@magicbell/react` [M1].
2. **Pricing.** The Builder plan is free with **1,000 deliveries/mo**. Startup costs $249/mo for 50k deliveries, then $0.0025 each. Every channel delivery counts, so in-app plus email for one user counts as 2 [M2].
3. **Email later.** A broadcast has `overrides.channels.email` / `in_app` [M3], and there are email providers such as SMTP [M6].
4. **Recipients and auth.** Recipients are given by `external_id` and/or `email`. `external_id` takes precedence and can't be changed once set [M3][M7]. The User upsert creates users that don't exist [M7]. Whether a broadcast auto-creates its recipients is **unverified**. The React SDK needs a User JWT generated on your backend from the project's API key and secret key [M1][M4]. The exact claims are **unverified** from official reference docs, and there is no documented dev mode without a token.
5. **Deep links and data.** Broadcasts have `action_url` (max 2048 characters, overridable per channel) and arbitrary `custom_attributes` [M3].
6. **State.** The API supports read, unread, archive, and unarchive, plus bulk operations filtered by category or topic [M5].
7. **Real-time.** The Realtime client uses WebSocket connections [M5].
8. **Preferences.** The `UserPreferences` component lets users toggle channels per category [M1].
9. **Node SDK.** `magicbell-js` (`magicbell-js/project-client`) [M5].
- **Risks.** It has the smallest free tier (1k deliveries). Package churn (the legacy React packages and the deprecated `@magicbell/core`) makes older examples unreliable. EU residency is not mentioned on the pricing page [M2].

### Novu Cloud

1. **Inbox component.** `@novu/react` `<Inbox />` (React 18+). There is also `@novu/nextjs` [N1]. Styling goes through one `appearance` prop: `baseTheme` (e.g. `dark`), `variables` (tokens), and `elements` (per-part inline styles, Tailwind, or CSS-module classes, including callbacks that see runtime data) [N2]. Render props `renderSubject`, `renderBody`, and `renderAvatar` replace single parts of a row, and `renderNotification` replaces the whole row. Headless hooks also exist [N3][N9]. **SSR:** the Next.js example is `'use client'` [N1]. Version 3.19.2 on npm. `@novu/notification-center` (support ended 2025-04-03) and `@novu/node` (support ended 2025-03-20) are deprecated [NPM].
2. **Pricing.** The free plan includes 10k workflow runs/mo, **24-hour activity log retention**, at most 5 workflows, and 2 environments. Pro starts at $30/mo with 30k runs, then $1.20 per 1k [N4]. How a "run" is counted when one workflow has several steps is **unverified**.
3. **Email later.** Add an email provider integration and an Email step to the same workflow. A default Novu email provider is enabled out of the box [N5].
4. **Recipients and auth.** The client passes `applicationIdentifier` + `subscriberId`, which is your own id [N1]. HMAC is toggled per environment in the In-App provider settings. When it's on, the Inbox won't load without a server-computed `subscriberHash` [N6]. The Inbox creates subscribers that don't exist when it loads [N6]. A trigger with a full subscriber object in `to` "auto-create[s] or update[s]" the subscriber [N10].
5. **Deep links and data.** The workflow's redirect URL is handed to `routerPush(url)`, so navigation stays in the SPA router. Tabs can filter on `data`, `tags`, and `severity` [N3]. The server trigger takes an arbitrary `payload` [N8].
6. **State.** Built-in actions are mark-as-read, archive, and snooze [N3].
7. **Real-time.** The Inbox is "real-time". EU accounts set `backendUrl` and `socketUrl` [N1].
8. **Preferences.** A Preferences panel is built into the Inbox, and `<Preferences />` can be rendered on its own [N7].
9. **Node SDK.** `@novu/api` [N8].
- **Risks.** The free tier caps you at 5 workflows and 24h log retention [N4]. Its US + EU data residency is the most explicit of the vendors here [N4]. The SDK churn (two deprecated packages) means older blog and tutorial code is outdated.

### Stream (Activity Feeds v3)

1. **Inbox component.** **Does not meet the hard requirement.** The v3 React SDK (`@stream-io/feeds-react-sdk`, v1.0.23 [NPM]) documents state and hooks only: `useFeedActivities`, `useAggregatedActivities`, and `useNotificationStatus`. The notification-feed docs list no pre-built UI components [S1][S2]. The older UI kit `react-activity-feed` is "no longer actively maintained" and its repo was archived on Aug 24, 2026 [S3]. You would have to build the bell and list yourself.
2. **Pricing.** Build is free with 125k API calls and 5k activities/mo, and no overages are allowed. Start costs $499/mo billed annually ($599 monthly) [S4].
3. **Email later.** Activity Feeds does not appear to include email delivery (**unverified**). Email would need a second service.
4. **Recipients and auth.** `client.connectUser({ id }, token)` with a token signed by your backend using the API secret [S1]. Dev tokens are **unverified**.
5. **Deep links and data.** Activities accept a `custom` object, for example `custom: { milestone_type, count }` [S2].
6. **State.** With `track_seen`/`track_read` enabled you get `is_seen`/`is_read`, plus `unread`/`unseen` counts and `markActivity` [S2]. Archive is **unverified**.
7. **Real-time.** WebSocket, with `watch: true` [S1].
8. **Preferences.** No notification-preferences feature found (**unverified**).
9. **Node SDK.** `@stream-io/node-sdk` (0.9.2) and the low-level `getstream` (8.15.1) [NPM].
- **Risks.** Stream fails the React-inbox requirement, has the highest paid entry price, and is a social-feed product rather than a notification workflow engine.

### SuprSend

1. **Inbox component.** `@suprsend/react` provides the drop-in `Inbox`, `NotificationsFeed`, and `Preferences` components, built on `@suprsend/react-core` (headless) [P1][P6]. Styling uses a `theme` object (keys `header`, `notification`, `tabs`, `bell`, `badge`, and so on) plus `themeType="dark"|"light"`. Replaceable parts include `notificationComponent`, `bellComponent`, `headerRightComponent`, and `noNotificationsComponent` [P2]. **SSR:** not covered (**unverified**). The old `@suprsend/react-inbox` has reached end of support, and npm marks it deprecated [P6][NPM].
2. **Pricing.** The free plan includes 10k notifications/mo, but the in-app feed shows SuprSend branding. Essentials costs $100/mo ($1,200/yr) for 50k, then $2 per 1k, and removes the branding. Each channel counts separately per user [P3].
3. **Email later.** A "Send Email" node goes in the same workflow, and all channels are available on every plan [P4][P3].
4. **Recipients and auth.** `SuprSendProvider` takes `publicApiKey` + `distinctId`. Passing a `distinctId` makes the SDK "create user and authenticate user". `userToken` (an ES256 JWT signed by your backend with `entity_type: 'subscriber'` and `entity_id`) is only required when enhanced security mode is on [P1][P7].
5. **Deep links and data.** Clicking a card opens its Action URL by default. Primary and secondary action handlers can be overridden, and custom renderers receive `notificationData` (`IRemoteNotification`) [P2]. The full payload shape is **unverified**.
6. **State.** Cards support read, unread, unseen styling, archived (shown through an `archived: true` tab), and interacted [P2].
7. **Real-time.** socket.io [P5]. The React `Inbox` shows connection-state banners [P2].
8. **Preferences.** The `Preferences` drop-in component [P1].
9. **Node SDK.** `@suprsend/node-sdk` 1.15.1 [NPM]. A dedicated docs page was not found (**unverified** beyond npm).
- **Risks.** The free tier's in-app feed carries SuprSend branding [P3]. EU or custom regions are Enterprise-only ("Custom Data Center Region"), and self-hosting/BYOC exists [P3][P8].

### Other contenders

None added. Others (e.g. Engagespot, Pusher Beams, OneSignal) were not researched.

## Cross-cutting observations

- **Five of the six vendors ship a restylable pre-built React inbox:** Knock, Courier, MagicBell, Novu, and SuprSend. Stream ships only hooks/state, and its old UI kit is archived.
- **Every inbox is client-side.** The vendors that document it (Knock, Courier, Novu) mark their components `'use client'`. In React Router v7 framework mode, that means rendering the inbox after hydration (for example lazy or client-only), not during SSR. None of the vendors document React Router specifically.
- **Fit with the DevUI user-switching model.** Knock (enhanced security off), Novu (HMAC off), and SuprSend (enhanced security off) accept a plain user id from the browser in dev, which matches the DevUI panel switching between internal ids. Courier and MagicBell always need a backend-minted JWT, so even local dev needs a token-minting route. Every vendor that supports signed tokens needs one before production.
- **Recipients and our user ids.** All six accept an arbitrary string id. Knock, Novu, SuprSend, and Courier's inbox all create users when they first appear, at least on client connect or inline trigger. Ids are permanent in Knock and MagicBell.
- **Pricing models.** Pricing is per message or delivery (Knock, MagicBell, SuprSend: each channel counts), per send (Courier: several channels count as one), per workflow run (Novu), or per activity + API call (Stream). None of the entry plans is priced by MAU. The free tiers are all around 10k/mo, except MagicBell (1k) and Stream (5k activities). Paid entry ranges from $30/mo (Novu) to $499/mo (Stream), and Courier is pure pay-as-you-go.
- **Preferences UI.** Courier, MagicBell, Novu, and SuprSend ship one pre-built. Knock requires building it with hooks.
- **Data residency.** Novu documents US + EU even on free. Courier lists EU residency (tier unclear). Knock says EU is coming by the end of 2026. MagicBell, SuprSend, and Stream point to Enterprise or sales.
- **SDK churn.** Novu, MagicBell, Courier, and SuprSend have each deprecated a React or Node package recently. Tutorials found outside the vendor docs are often for the old package.

## Sources

**npm**
- [NPM] npm registry metadata via `npm view` on 2026-11-13: [@knocklabs/react](https://www.npmjs.com/package/@knocklabs/react), [@knocklabs/node](https://www.npmjs.com/package/@knocklabs/node), [@trycourier/courier-react](https://www.npmjs.com/package/@trycourier/courier-react), [@trycourier/courier](https://www.npmjs.com/package/@trycourier/courier), [@trycourier/react-inbox](https://www.npmjs.com/package/@trycourier/react-inbox), [@magicbell/react](https://www.npmjs.com/package/@magicbell/react), [@magicbell/magicbell-react](https://www.npmjs.com/package/@magicbell/magicbell-react), [@magicbell/core](https://www.npmjs.com/package/@magicbell/core), [@novu/react](https://www.npmjs.com/package/@novu/react), [@novu/api](https://www.npmjs.com/package/@novu/api), [@novu/node](https://www.npmjs.com/package/@novu/node), [@novu/notification-center](https://www.npmjs.com/package/@novu/notification-center), [@stream-io/feeds-react-sdk](https://www.npmjs.com/package/@stream-io/feeds-react-sdk), [@stream-io/node-sdk](https://www.npmjs.com/package/@stream-io/node-sdk), [getstream](https://www.npmjs.com/package/getstream), [@suprsend/react](https://www.npmjs.com/package/@suprsend/react), [@suprsend/react-inbox](https://www.npmjs.com/package/@suprsend/react-inbox), [@suprsend/node-sdk](https://www.npmjs.com/package/@suprsend/node-sdk)

**Knock**
- [K1] https://docs.knock.app/in-app-ui/react/feed
- [K2] https://knock.app/pricing
- [K3] https://docs.knock.app/concepts/users
- [K4] https://docs.knock.app/in-app-ui/security-and-authentication
- [K5] https://docs.knock.app/send-notifications/message-statuses.md
- [K6] https://docs.knock.app/in-app-ui/react/preferences.md
- [K7] https://docs.knock.app/getting-started/quick-start/nextjs.md
- [K8] https://docs.knock.app/integrations/email/overview.md
- [K9] https://docs.knock.app/developer-tools/sdks.md
- [K10] https://docs.knock.app/manage-your-account/knock-plans

**Courier**
- [C1] https://www.courier.com/docs/sdk-libraries/courier-react-web
- [C2] https://www.courier.com/pricing
- [C3] https://www.courier.com/docs/platform/inbox/inbox-overview
- [C4] https://www.courier.com/docs/in-app/authenticate-users.md
- [C5] https://www.courier.com/docs/in-app/send-to-the-inbox.md
- [C6] https://github.com/trycourier/courier-web
- [C7] https://www.courier.com/docs/recipients/overview

**MagicBell**
- [M1] https://www.magicbell.com/docs/libraries/react
- [M2] https://www.magicbell.com/pricing
- [M3] https://www.magicbell.com/docs/primitive/broadcast
- [M4] https://www.magicbell.com/docs/api/authentication
- [M5] https://www.magicbell.com/docs/libraries/magicbell-js
- [M6] https://www.magicbell.com/docs/channels/email/smtp
- [M7] https://www.magicbell.com/docs/primitive/user

**Novu**
- [N1] https://docs.novu.co/platform/inbox/react/get-started
- [N2] https://docs.novu.co/platform/inbox/configuration/styling
- [N3] https://docs.novu.co/.mintlify/skills/inbox-integration/references/personalization.md
- [N4] https://novu.co/pricing
- [N5] https://docs.novu.co/platform/integrations/email/adding-email.md
- [N6] https://docs.novu.co/platform/inbox/prepare-for-production
- [N7] https://docs.novu.co/.mintlify/skills/manage-preferences/references/preferences-ui-examples.md
- [N8] https://docs.novu.co/platform/sdks/server/typescript
- [N9] https://docs.novu.co/.mintlify/skills/inbox-integration/references/headless-inbox-examples.md
- [N10] https://docs.novu.co/.mintlify/skills/trigger-notification/references/single-trigger-examples.md

**Stream**
- [S1] https://getstream.io/activity-feeds/docs/react/
- [S2] https://getstream.io/activity-feeds/docs/react/notification-feeds/
- [S3] https://github.com/GetStream/react-activity-feed
- [S4] https://getstream.io/activity-feeds/pricing/

**SuprSend**
- [P1] https://docs.suprsend.com/docs/react-sdk
- [P2] https://docs.suprsend.com/docs/react-customize-inbox
- [P3] https://www.suprsend.com/pricing
- [P4] https://docs.suprsend.com/reference/workflow-nodes/send-email.md
- [P5] https://docs.suprsend.com/docs/js-inapp-feed
- [P6] https://docs.suprsend.com/docs/inbox-react
- [P7] https://docs.suprsend.com/docs/integrate-javascript-sdk
- [P8] https://docs.suprsend.com/docs/self-hosted/introduction.md
