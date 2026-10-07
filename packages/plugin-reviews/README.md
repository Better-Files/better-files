# @better-files/plugin-reviews

Access reviews (certifications) for Better Files: periodic "who should still be in this room" campaigns.

- `reviews.start` snapshots the room's participants: room role, groups, guest status, last activity in the room's
  log, and a recommendation (`keep`, or `revoke` for people inactive for `inactiveDays`, invitations never accepted,
  and access windows that ended). Owners are always recommended to keep. Scope a review to `all`, `guests` or
  `inactive` people. One open review per room.
- `reviews.decide` records keep or revoke decisions (up to 500 at once). Nobody decides on their own access.
  `reviews.acceptRecommendations` takes the recommendation for every undecided person.
- `reviews.complete` removes the revoked people through `members.remove`, which takes them out of Better IAM's
  groups and relationship tuples, and records the outcome per person and `review.completed` in the activity log.
  With `revokeUndecided: true`, undecided people are removed too. Otherwise everyone must be decided first.
- `reviews.list`, `reviews.get` and `reviews.cancel`.
- `dr.maintain()` emits `review.overdue` once for open reviews past `dueAt`. With `schedule`, it also starts a review
  of every live room whose last review is `everyDays` old.

```ts
import { reviewsPlugin } from '@better-files/plugin-reviews';

const reviews = reviewsPlugin({ schedule: { everyDays: 90, dueInDays: 14 }, inactiveDays: 60 });
betterFiles({
  plugins: [reviews],
  iam: betterIamIntegration(iam, { iamPlugin: betterFilesIamPlugin({ plugins: [reviews] }) }),
});
```

## Access from outside the roster

People can reach a room through Better IAM without being on its roster: tenant administrators, broad policies, groups
bound outside Better Files. With `iamAccess`, each review also lists them (`source: 'iam'`, `reason: 'outside-roster'`,
and `access` with Better IAM's explanation). It uses `policies.whoCan`, which every 0.2.x release has:

```ts
import { betterIamAccess, reviewsPlugin } from '@better-files/plugin-reviews';

reviewsPlugin({
  iamAccess: betterIamAccess(iam, { credential: (tenantId) => serviceAccountFor(tenantId) }),
});
```

The credential needs `iam:policies:simulate`. Revoking such an entry cannot be done from the room. Completion marks it
`flagged`, returns it in `flagged`, and emits `review.iam-access-flagged`, so the host can change the policy or
binding in Better IAM.

Actions: `better-files:reviews:manage` (room owners and admins) and `better-files:reviews:read` (also auditors). Pass the
plugin to `betterFilesIamPlugin({ plugins })` so Better IAM knows them.
