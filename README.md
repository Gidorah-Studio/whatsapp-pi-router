# whatsapp-pi-router

WhatsApp-to-Pi router with one isolated Pi session per WhatsApp conversation.

This package is based on the `whatsapp-pi` WhatsApp integration, but inbound WhatsApp messages are routed to stable per-conversation Pi sessions instead of being injected into the currently active terminal session.

## Routing model

Each WhatsApp thread gets a deterministic Pi session id:

- direct chats → `whatsapp-direct-<sha256-jid-prefix>`
- group chats → `whatsapp-group-<sha256-jid-prefix>`

On each inbound message, the extension runs a headless Pi turn for that session:

```bash
pi --session-id <conversation-session> --no-extensions --print "<message>"
```

The final stdout is sent back to the originating WhatsApp chat.

This gives clean segregation between WhatsApp conversations while avoiding recursive loading of the WhatsApp extension inside child Pi turns.

## Install from GitHub

```bash
pi install https://github.com/x4484/whatsapp-pi-router
```

Then restart Pi or run `/reload`.

## Usage

Start Pi with the router online:

```bash
pi --whatsapp-pi-online
```

Or start Pi normally, open `/whatsapp`, connect WhatsApp, and manage allowed contacts/groups.

The router preserves the original allowlist/group controls from `whatsapp-pi` by default.

Use `/whatsapp` → `Allow All Direct Chats: Off/On` to let every inbound direct chat route to Pi. Groups still require explicit allowlist entries by default.

You can also enable direct-chat allow-all mode in `~/.pi/agent/extensions/whatsapp-pi/router-allow.json`:

```json
{
  "allowAllDirectChats": true,
  "allowAllGroups": false,
  "allow": []
}
```

`allowAllDirectChats` bypasses direct-chat allowlist checks at runtime without deleting the saved allowlist. Set it back to `false` or use the `/whatsapp` toggle to return to explicit allowlist mode. Legacy `"allowAll": true` is still accepted as an alias for direct chats only.

## Identity mapping

WhatsApp may identify direct chats with `@lid` privacy IDs instead of phone-number JIDs. The router stores local identity links in `~/.pi/agent/extensions/whatsapp-pi/identity-map.json` so a known WhatsApp conversation can be tied to a phone, email, or external record ID without using display names as stable lookup keys.

Use `/whatsapp` → `Recents` → a conversation → `Link Phone`, `Link Email`, or `Link External Record ID` to add a mapping. The child Pi prompt receives the known linked identity as private context. Specific agents can decide whether an external record ID maps to a customer profile, helpdesk ticket, sales record, or another system. WhatsApp display names are still passed as weak candidates for greeting, manual review, or clarifying questions, but they are not stable lookup keys. Groups remain explicit allowlist conversations and do not get identity links.

## Outbound queue

The router can send approved outbound direct messages from a local file-backed queue. This avoids opening an HTTP listener and keeps the connected router process as the only WhatsApp sender.

Queue folders live under:

```txt
~/.pi/agent/extensions/whatsapp-pi/outbound-queue/
  pending/
  processing/
  sent/
  failed/
```

Write one JSON file to `pending/` using an atomic temp-file rename. The router claims it by rename, sends with the existing WhatsApp session, records the outgoing message in recents, then moves the result to `sent/` or `failed/`.

Example job:

```json
{
  "id": "uuid-or-safe-id",
  "version": 1,
  "phone": "+9613133301",
  "text": "Hi Rani, this is Emily from GIDORAH...",
  "source": "gidorah-whatsapp-outbound",
  "leadId": 123,
  "approvedBy": "operator",
  "createdAt": "2026-06-21T00:00:00.000Z"
}
```

`phone` is normalized to a direct WhatsApp JID. `jid` or `recipientJid` may be used instead for direct WhatsApp JIDs. Group JIDs are rejected by the queue.

## Configuration

Optional environment variables:

- `WHATSAPP_PI_ROUTER_PI_BIN` — Pi executable to spawn. Defaults to `pi`.
- `WHATSAPP_PI_ROUTER_TIMEOUT_MS` — child Pi turn timeout. Defaults to 10 minutes.
- `WHATSAPP_ROUTER_ALLOW_NUMBERS` — comma-separated numbers/JIDs to force-add to the allowlist at startup.
- `WHATSAPP_ROUTER_ALLOW_ALL` or `WHATSAPP_ROUTER_ALLOW_ALL_DIRECT_CHATS` — set to `true`, `1`, `yes`, `on`, `all`, or `*` to route every inbound direct chat without allowlist checks.
- `WHATSAPP_ROUTER_ALLOW_ALL_GROUPS` — set to a truthy value to route every inbound group without allowlist checks. Groups are explicit-only by default.
- `WHATSAPP_ROUTER_OUTBOUND_POLL_MS` — outbound queue polling interval in milliseconds. Defaults to `2000`; values below `500` are ignored.

## Development

```bash
git clone https://github.com/x4484/whatsapp-pi-router.git
cd whatsapp-pi-router
npm install
pi -e ./src/whatsapp-router.ts
```

Run a typecheck:

```bash
npx tsc --noEmit --module NodeNext --moduleResolution NodeNext --target ES2022 --skipLibCheck --allowSyntheticDefaultImports src/whatsapp-router.ts
```

## Notes

- Child Pi turns use `--no-extensions` to avoid recursively starting another WhatsApp router.
- Session history is still persistent because `--session-id` is stable per WhatsApp JID.
- Streaming is intentionally not implemented; WhatsApp receives the final answer once the child Pi turn completes.
