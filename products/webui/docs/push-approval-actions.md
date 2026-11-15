# Approval actions from a push notification

When the daemon fans out a pending approval as a Web Push message, the operator
shell shows it with two action buttons: **Allow** and **Deny**.

## What ships today (works against the current daemon)

- **In-app buttons.** The Approvals section of the Work view has Approve /
  Deny / Claim / Cancel buttons backed by the real `approvals.*` operator
  methods. This is the primary way to decide an approval and needs nothing new.
- **Notification action buttons that hand off to the app.** The service worker
  (`public/sw.js`) adds `Allow` / `Deny` buttons to an approval notification.
  Tapping one opens the app at
  `/?view=approvals-tasks#approval-action=<approve|deny>&approval-id=<id>`.
  The app, which holds the operator token, reads that fragment on open and
  scrubs it. **Allow** opens that approval in Work so you can read what is being
  asked and press Approve yourself: a link in a page or a message must not be able
  to approve a tool call just by being opened. **Deny** is applied on open
  (refusing is always safe) and toasts the result. A tap on a notification
  whose approval already ended (it expired, or another surface answered it
  first) toasts "Already expired, nothing changed" (or the actual state) instead
  of "Denied": the daemon answers such a call with `applied: false`. See:
  - `linkForNotification` in `public/sw.js`: builds the deep link.
  - `src/lib/push/approval-action-link.ts`: parses and strips the fragment.
  - `useApprovalActions` (`src/views/work/useApprovalActions.ts`), mounted by
    the Work view: the mount-once hand-off effect (Allow opens the approval, Deny
    denies it).

  The link the service worker emits still uses the older `?view=approvals-tasks`
  form. The router rewrites it to the Work view and keeps the `#` fragment
  (`LEGACY_VIEW_REDIRECTS` in `src/lib/router.ts`), so that redirect has to stay
  while `public/sw.js` emits the old form.

Platforms without notification-action support simply omit the buttons and a
body tap still opens the approvals list, a graceful degrade, never a dead tap.

## What is deliberately NOT built (and why)

One-tap background decide, approving or denying straight from the
notification without opening a window, is intentionally left out. A service
worker cannot make that call today:

- The service worker holds no operator token. The token lives in
  `localStorage` (`createBrowserTokenStore`), which a service worker cannot
  read. So the worker cannot authenticate an `approvals.approve` / `.deny`
  request on its own.
- We will not fake it (e.g. fire an unauthenticated request that silently
  fails, or cache a long-lived token in the worker).

Because of that, the hand-off above is the honest ceiling. The authenticated
app always makes the real call.

## Daemon API needed to close the gap

To let the service worker decide an approval in the background, the daemon would
need to issue a single-purpose, single-use action token scoped to exactly
one approval decision, and carry it in the push payload:

1. When the daemon fans out the approval push, include per-action tokens in the
   payload `data`, e.g.:

   ```json
   {
     "title": "Approval needed: run tests",
     "body": "...",
     "data": {
       "kind": "approval",
       "approvalId": "appr-123",
       "actionTokens": { "approve": "<jwt>", "deny": "<jwt>" }
     }
   }
   ```

   Each token must be: bound to that one `approvalId`; valid for a single use;
   short-lived (expires with the approval), and usable for only the
   approve/deny of that approval, nothing else.

2. Expose an endpoint that accepts such a token instead of the operator bearer,
   e.g. `POST /api/approvals/{approvalId}/{approve|deny}` authenticated by an
   `Authorization: Bearer <actionToken>` (or a dedicated header), returning the
   updated approval record.

With those two pieces, `public/sw.js`'s `notificationclick` handler could
`fetch` the decision directly (no window) when `event.action` is `approve` /
`deny`, falling back to the current app hand-off when a token is absent or the
platform lacks action support. Until the daemon offers this, the
background-decide path stays unbuilt behind that capability check.
