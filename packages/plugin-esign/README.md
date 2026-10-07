# @better-files/plugin-esign

E-signature for Better Files: envelopes, sequential or parallel routing, an evidence chain and a certificate of completion. Signing runs natively (emailed links) or at DocuSign or Dropbox Sign.

Part of [Better Files](../../README.md). Most applications install `better-files` and import this package through its subpaths.

## Native signing

```ts
esignPlugin({ deliver: async (delivery) => mailer.send(delivery) });
```

`deliver` gets a signing token for each recipient whose turn it is. Put the token in a link to your signing page, which calls `esign.open` and `esign.sign`.

## DocuSign or Dropbox Sign

```ts
import {
  docusignJwtAuth,
  docusignProvider,
  dropboxSignProvider,
  esignPlugin,
  esignWebhook,
} from 'better-files/plugin-esign';

const provider = docusignProvider({
  basePath: 'https://demo.docusign.net/restapi',
  accountId: process.env.DOCUSIGN_ACCOUNT_ID!,
  accessToken: docusignJwtAuth({ integrationKey, userId, privateKey }),
  connectKeys: [process.env.DOCUSIGN_CONNECT_HMAC_KEY!],
});
// or: dropboxSignProvider({ apiKey: process.env.DROPBOX_SIGN_API_KEY! })

export const dr = betterFiles({ /* … */ plugins: [esignPlugin({ provider })] });

// app/api/esign/webhook/route.ts: point DocuSign Connect or the Dropbox Sign callback URL here
const webhook = esignWebhook(dr, provider);
export const POST = (request: Request) => webhook(request);
```

You still prepare envelopes in Better Files (`esign.create`, with fields placed in PDF points from the bottom-left corner of the page). Then `esign.send` hands the document to the provider, which emails the recipients and runs the ceremony. `esign.void` and `esign.remind` act at the provider.

The webhook only says which envelope changed. `esignWebhook` verifies the provider's signature (Connect HMAC, or Dropbox Sign's `event_hash`), then calls `esign.sync`. `esign.sync` reads the envelope's state from the provider's API and applies it:

- Recipient progress goes into the evidence chain.
- On completion, the provider-sealed PDF is stored next to the original as `name (signed).pdf`. DocuSign's certificate of completion is stored as `name (certificate).pdf`.
- Declines and voids are recorded.

Webhook contents are never applied, so a replayed or forged message can at most cause a harmless re-read. A burst of webhooks completes an envelope once. Without a webhook, call `dr.api.esign.sync({}, { tenantId, envelopeId })` yourself. Calls that don't carry the provider's envelope id are throttled to one provider read per `syncIntervalMs` (5 seconds).

| Provider     | Approvers                                   | Webhook setup                                                                      |
| ------------ | ------------------------------------------- | ---------------------------------------------------------------------------------- |
| DocuSign     | Certified delivery (open and acknowledge)   | Connect, JSON (SIM), HMAC on, "Include Envelope Custom Fields" on; or `webhookUrl` |
| Dropbox Sign | Signers (Dropbox Sign has no approver role) | Account or API app callback URL                                                    |

To add another provider, implement `EsignProvider`: `send`, `status`, `void`, `remind`, `download` and `parseWebhook`.
