# @better-files/plugin-ai

Permission-aware AI for Better Files: answers and summaries grounded in documents the asker may view, with
citations, on Claude.

```ts
import { searchPlugin } from 'better-files/plugin-search';
import { aiPlugin, claudeProvider } from 'better-files/plugin-ai';

const plugins = [
  searchPlugin({ indexContent: true }), // retrieval uses the search index
  aiPlugin({ provider: claudeProvider() }), // claude-opus-5, adaptive thinking, citations
] as const;

const result = await dr.api.ai.ask(credential, {
  tenantId,
  roomId,
  question: 'Who can terminate the lease?',
});
// { answer, refused, citations: [{ nodeId, name, quote }], sources: [{ nodeId, name }] }
await dr.api.ai.summarize(credential, { tenantId, nodeId });
```

- **Nothing the asker can't open reaches the model.** Candidates come from the search plugin's index, whatever its
  backend (SQL or Meilisearch). Before any text is fetched or sent, each one is checked against Better Files' own
  tables: same tenant and room, not in the trash, and `VIEW` for the asker. Moved, trashed and stale index entries
  are caught at question time.
- **View-only stays view-only.** Documents flagged `viewOnly` or `noCopy` reach the model only for people with
  `COPY_TEXT`, so the assistant cannot be used to extract their text. `aiPlugin({ requireCopyText: true })`
  requires `COPY_TEXT` for every document.
- **Grounded and cited.** Documents go to Claude as citable document blocks, and citations map back to node ids. A
  citation is returned only if it names a document the asker was given and quotes text that is in it. A
  prompt-injected document or a misbehaving provider can't attribute words to other documents.
- **Audited.** `ai.asked` and `ai.summarized` land in the room's activity log.
- **Refusal fallbacks.** Server-side fallbacks are on by default; `claudeProvider({ fallbacks: false })` turns them
  off. A refusal comes back as `refused: true`.
- **Any model.** `provider` is a two-method interface (`answer`, `summarize`); `claudeProvider` is the default.

`claudeProvider` options: `client` (an `Anthropic` instance; default reads `ANTHROPIC_API_KEY`), `model` (default
`claude-opus-5`), `effort` (default `medium`), `maxTokens`, `fallbacks`. `@anthropic-ai/sdk` is an optional peer
dependency, needed only for `claudeProvider`.

Part of [Better Files](../../README.md). Most applications install `better-files` and import this
package through its subpaths.
