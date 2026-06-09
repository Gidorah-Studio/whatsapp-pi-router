# whatsapp-pi-router

WhatsApp-to-Pi router intended to keep each WhatsApp conversation in its own isolated Pi session.

## Goal

Route inbound WhatsApp messages by conversation identity:

- direct chats → `whatsapp:direct:<hash>`
- group chats → `whatsapp:group:<hash>`

This follows the OpenClaw-style routing model: one logical agent session per conversation, instead of mixing all WhatsApp chats into the active terminal session.

## Status

Initial scaffold. Implementation coming next.

## Install from GitHub

```bash
pi install https://github.com/x4484/whatsapp-pi-router
```

Then restart Pi or run `/reload`.

## Planned architecture

1. Connect to WhatsApp Web.
2. Apply allowlist/group policy.
3. Derive a stable session key from the WhatsApp JID.
4. Dispatch message into the matching Pi SDK session.
5. Capture final assistant response.
6. Send response back to the same WhatsApp thread.

## Development

```bash
git clone https://github.com/x4484/whatsapp-pi-router.git
cd whatsapp-pi-router
pi -e ./src/index.ts
```
