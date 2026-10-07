# @better-files/plugin-search

Search for Better Files: names and (opt-in) document text, filtered by the caller's permissions.

Part of [Better Files](../../README.md). Most applications install `better-files` and import this package through its subpaths.

```ts
import { searchPlugin, meilisearchBackend } from '@better-files/plugin-search';

betterFiles({
  // …
  plugins: [
    // A table in your database (the default): no other service, substring matching.
    searchPlugin({ indexContent: true }),
  ],
});

// Or keep the index in Meilisearch (1.3+): typo tolerance, prefix matching and ranking for large rooms.
searchPlugin({
  indexContent: true,
  backend: meilisearchBackend({
    host: process.env.MEILI_HOST!,
    apiKey: process.env.MEILI_KEY!, // a key that can manage the index, kept on the server
    index: 'better-files',
  }),
});
```

Then `dr.api.search.query({ roomId, q })` (and the same on the client) returns the matches the caller may list,
with text snippets only for documents they may view. Room owners and admins can rebuild a room's index with
`search.reindex`.

## How results stay safe

The backend only proposes candidates. Every result is then checked against Better Files' own tables: same tenant and
room, not in the trash, and `LIST` for the caller (`VIEW` for a snippet). A stale index, or one index shared by
every tenant, cannot reveal a name or text the caller could not see.

## Backends

| Backend                | Where the index lives                      | Notes                                                                                                          |
| ---------------------- | ------------------------------------------ | -------------------------------------------------------------------------------------------------------------- |
| `sqlSearchBackend()`   | The `searchEntries` table in your database | Default. Substring matching on all words; ranked by matches in the name                                        |
| `meilisearchBackend()` | A Meilisearch index, over HTTP (no SDK)    | Creates and configures the index on first use; `waitForWrites` for read-after-write; one index for all tenants |

With `indexContent`, extracted text is stored in plain text by the backend (files stay encrypted in storage), so
use it where the index is protected at rest.

A custom backend implements `SearchBackend`: `upsert(document)`, `removeRoom({ tenantId, roomId })` and
`query({ tenantId, roomId, q, words, kind, limit })`. An `upsert` without `text` is a rename: keep the text you
have.
