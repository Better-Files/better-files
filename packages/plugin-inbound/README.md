# @better-files/plugin-inbound

Email to a data room for Better Files. Each folder can have drop addresses, and the attachments of mail sent
to one become documents there.

```ts
const inbound = { domain: 'in.example.com', deliverySecret: process.env.INBOUND_SECRET! };
const dr = betterFiles({ ...options, plugins: [inboundPlugin(inbound)] });

const { address } = await api.inbound.createAddress({
  tenantId,
  nodeId: folderId,
  allowedSenders: ['@seller.com'],
});
// room+acme.Zp3…@in.example.com

// Your provider's inbound webhook (verify its signature first):
app.post('/inbound/postmark', async (req, res) => {
  await deliverEmail(dr, inbound, fromPostmark(req.body));
  res.sendStatus(200);
});
```

- **Sender checks.** By default only messages the provider authenticated (DKIM or DMARC pass, or SPF pass) are
  accepted. `allowedSenders` restricts an address to addresses or `@domains`. Addresses can expire
  (`expiresInDays`) and be revoked.
- **Normal documents.** Attachments are filed through the regular path: encrypted, versioned, deduplicated by name,
  scanned and processed by those plugins, and counted by quotas. Each version is recorded as the address's creator,
  with the sender and subject in the version comment. `inbound.received` goes to the activity log; refusals publish
  `inbound.refused`.
- **Who.** Creating an address needs `UPLOAD` on the folder. `deliver` is a server-side call guarded by the delivery
  secret: the token in the address identifies the folder, and the tenant is part of the address.

Part of [Better Files](../../README.md).
