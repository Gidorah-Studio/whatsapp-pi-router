# whatsapp-pi-router

WhatsApp-to-Pi router with one isolated Pi session per WhatsApp conversation.

This package is based on the `whatsapp-pi` WhatsApp integration, but inbound WhatsApp messages are routed to stable per-conversation Pi sessions instead of being injected into the currently active terminal session.

## Routing model

Each WhatsApp thread gets a deterministic private session directory:

- direct chats → `~/.pi/agent/extensions/whatsapp-pi/child-sessions/direct-<sha256-jid-prefix>/`
- group chats → `~/.pi/agent/extensions/whatsapp-pi/child-sessions/group-<sha256-jid-prefix>/`

On each inbound message, the extension runs a headless Pi turn that continues the latest session in that conversation directory:

```bash
pi --session-dir <conversation-directory> --continue [--model <provider/model>] [--thinking <level>] --no-extensions --extension <child-media-extension> --print "<message>"
```

Pi generates the session's standard UUIDv7 identifier. The directory keeps contacts and groups isolated without exposing custom router IDs to model providers. The model and thinking arguments are included when configured, and the final stdout is sent back to the originating WhatsApp chat.

When a conversation first runs after upgrading from the legacy `whatsapp-direct-*` / `whatsapp-group-*` session-ID scheme, the router automatically forks the legacy session into its new directory before processing the message. The original legacy session file remains untouched as a backup.

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

For groups, use `/whatsapp` → `Group Replies: All Messages/Mentions Only`. In **Mentions Only** mode, an allowed group message is routed to Pi only when WhatsApp's structured `mentionedJid` metadata explicitly identifies the connected agent's phone JID or LID. Direct chats are unaffected, and enabling mention-only mode does not grant access to groups that are not otherwise allowed. Ordinary allowed-group messages are saved to the local recents history but do not start a child Pi turn.

New incoming group-history records include `participantJid` for the actual sender and `participantName` when WhatsApp supplies a display name. Use `participantJid`—not the user-controlled display name—for exact attribution. Existing records created before this field was added remain readable but cannot be reliably backfilled. The recents store retains the latest 200 messages per conversation; `get_wa_conversation_history` returns up to all 200 by default.

You can also configure these routing controls in `~/.pi/agent/extensions/whatsapp-pi/router-allow.json`:

```json
{
  "allowAllDirectChats": true,
  "allowAllGroups": false,
  "groupReplyMode": "mentions",
  "allow": []
}
```

`groupReplyMode` accepts `"all"` (the backwards-compatible default) or `"mentions"`. Mention detection uses WhatsApp metadata rather than matching visible `@name` text. `allowAllDirectChats` bypasses direct-chat allowlist checks at runtime without deleting the saved allowlist. Set it back to `false` or use the `/whatsapp` toggle to return to explicit allowlist mode. Legacy `"allowAll": true` is still accepted as an alias for direct chats only.

## Connection reliability and recovery

For always-on agents, configure boot/crash supervision, startup readiness checks,
and an attachable tmux console using [the systemd deployment guide](deploy/README.md).
Installing the extension and connecting through `/whatsapp` do not create a service;
use the generic deployment template and adapt it to the target agent.
Saved linked-device sessions can have `registered=false`: the router also checks
for the saved account JID that Baileys uses to log in. It never changes credentials
to make a status flag look healthy. Auto-connect respects persisted authentication
failures and connection conflicts.

The router records every connection lifecycle transition in a sanitized, structured journal:

```txt
~/.pi/agent/extensions/whatsapp-pi/connection-events.jsonl
```

The journal is always enabled, rotates at 5 MiB, and records timestamps, connection state, Baileys status codes, classified reasons, reconnect decisions, retry timing, process metadata, and whether local auth existed. It does not record QR values, credentials, message contents, or contact identities. Open `/whatsapp` → `Connection Diagnostics` to see the current state, credential and instance-lock status, process uptime, last disconnect, next retry, and recent lifecycle events. The operator Pi can inspect the same sanitized data through `get_whatsapp_health`; routed WhatsApp child sessions do not load that tool.

Disconnect handling uses explicit recovery classes:

- transient connection loss (`408`, `428`, `515`) reconnects with exponential backoff;
- logged-out/rejected sessions (`401`, `400`, `500`, or Bad MAC) enter `reauth-required` and stop retrying stale credentials;
- connection replacement (`440`) enters `connection-conflict` and preserves credentials;
- intentional stops are recorded separately from outages;
- unknown disconnects are logged and retried.

When reauthentication is required, open `/whatsapp` and select `Pair New Device (Reset Stale Credentials)`. The router closes the stale socket, moves its local auth directory into `auth-quarantine/`, creates a fresh auth directory, and starts QR pairing in the same Pi process. No Pi restart or manual file rename is required. Only the three newest quarantined auth directories are retained. `Logoff (Delete Session)` also guarantees local credential deletion even when the remote logout call fails.

An exclusive lock next to each auth directory prevents two Pi processes from using the same WhatsApp credentials. The lock is acquired lazily when a process connects or changes auth, stale locks are recovered, and a live second owner fails with an actionable error instead of replacing the first connection.

## Speech-to-text for WhatsApp voice notes

Incoming WhatsApp voice/audio messages are transcribed before they are routed to the child Pi session.

By default, the router uses local `whisper-cpp-node` transcription. That path also needs `ffmpeg` so incoming audio can be converted to WAV before transcription.

To use OpenRouter instead, load these environment variables before starting Pi:

```bash
export STT_PROVIDER="openrouter"
export OPENROUTER_API_KEY="sk-or-..."
export STT_MODEL="openai/whisper-1"
```

`STT_PROVIDER` may be left unset, or set to `local`, `whisper`, `whisper-cpp`, or `whisper_cpp`, to use local whisper-cpp transcription. When `STT_PROVIDER=openrouter`, the router sends the converted WAV file as base64 JSON to OpenRouter's audio transcription endpoint using `STT_MODEL` or `openai/whisper-1` by default. If OpenRouter fails and local whisper-cpp is available, the router falls back to local transcription.

## Text-to-speech voice replies

Routed child Pi sessions can send WhatsApp voice notes through OpenRouter TTS. Open `/whatsapp` → `Voice Reply Settings` to configure the reply mode, speech model, voice, and speed. Settings are stored at `~/.pi/agent/extensions/whatsapp-pi/voice-replies.json` and apply to the next routed turn.

Voice replies are off by default to avoid surprise API spend. Available modes are:

- `off` — always send routed replies as text.
- `explicit` — send voice only when the child agent adds `<!-- whatsapp_voice -->` on its own line. The router prompts the child agent to use this marker when the user asks for voice, then strips it before delivery.
- `mirror` — incoming voice/audio receives a voice reply; text input receives text.
- `mirror-explicit` — mirror incoming voice and also allow explicit voice replies to text input. This is the recommended mode.
- `always` — synthesize every non-empty routed reply.

The router sends text to OpenRouter's `/api/v1/audio/speech` endpoint and converts the response with `ffmpeg` to mono OGG/Opus before sending it through Baileys as a push-to-talk voice note. Gemini TTS models request 24 kHz, 16-bit mono PCM as required; other OpenRouter TTS models request MP3. The default model is `google/gemini-3.1-flash-tts-preview`, with voice `Sulafat` and speed `1`. Models and voice catalogs change over time, so configure a current OpenRouter speech model/voice when overriding the defaults.

Each TTS input includes a clear synthesis preamble and director's notes before the transcript. The model is told to speak only the transcript; the notes ask for Emily's warm, casual vocal smile, relaxed pacing, clear enunciation, neutral General American English, and native pronunciation for other languages.

TTS uses the same `OPENROUTER_API_KEY` as OpenRouter STT. If synthesis, conversion, or voice delivery fails, the router logs the error and falls back to the cleaned text reply. Replies over 4096 characters also fall back to text rather than being truncated or incurring an unexpectedly large TTS request. Temporary source-audio/OGG files are mode `0600` and removed after delivery.

TTS currently applies to automatic replies from routed per-conversation child Pi sessions. Menu sends, the file-backed outbound queue, and legacy main-session forwarding remain text-only.

## Generated image replies

Routed child Pi sessions have a dedicated `send_wa_image(path, caption?)` tool. An image skill should render the requested image to a local file, then call this tool with the file path and an optional caption. The tool is bound to the current routed conversation, so it does not accept a recipient JID.

The child process copies the image into a private per-turn handoff directory. After the child exits, the parent router independently validates the handoff, sends the image through its connected Baileys socket, records the outgoing message, and removes the staged files. PNG and JPEG images up to 5 MiB are accepted; captions are limited to 1024 characters. If image delivery fails, the router sends the caption or a short text failure notice instead.

The main WhatsApp extension is still disabled inside child sessions to prevent recursive router startup. Only the small media-handoff extension that provides `send_wa_image` is explicitly loaded.

## Identity mapping and LID routing

WhatsApp may identify direct chats with `@lid` privacy IDs instead of phone-number JIDs. The router runs on Baileys v7, records Baileys `lid-mapping.update` and `chats.phoneNumberShare` events, and stores local identity links in `~/.pi/agent/extensions/whatsapp-pi/identity-map.json` so a known WhatsApp conversation can be tied to a LID, phone, email, or external record ID without using display names as stable lookup keys.

For direct chats, LID is preferred as the reply identity when WhatsApp provides one. If an incoming message includes both a phone JID and a LID alternate, the router stores the PN↔LID mapping, routes the child Pi session by the LID, and sends replies to the LID. If a manual outbound send starts from a phone JID, Baileys' LID mapping store is checked before send and the message is upgraded to the mapped LID when available.

Use `/whatsapp` → `Recents` → a conversation → `Link Phone`, `Link Email`, or `Link External Record ID` to add business-system context. The child Pi prompt receives the known linked identity as private context. Specific agents can decide whether an external record ID maps to a customer profile, helpdesk ticket, sales record, or another system. WhatsApp display names are still passed as weak candidates for greeting, manual review, or clarifying questions, but they are not stable lookup keys. Groups remain explicit allowlist conversations and do not get identity links.

### External CRM enrichment (separate writer)

The router exclusively owns `identity-map.json`. External CRM jobs must **not**
rewrite it: the router keeps that map in memory and later persists it.

Instead, a single external sync writes `identity-enrichment.json` beside the map,
using a private temporary file and atomic rename. Its version-1 format is:

```json
{
  "version": 1,
  "identities": {
    "123456789@lid": {
      "basis": { "phone": "15550102030", "email": null, "externalRecordId": null },
      "phone": "15550102030",
      "email": "person@example.com",
      "externalRecordId": "123",
      "updatedAt": 1788560000000
    }
  },
  "updatedAt": 1788560000000
}
```

The router rereads enrichment when each queued turn starts and in the identity
menu. Only missing `phone`, `email`, and `externalRecordId` are merged into private
context, and only for an existing routing entry. `basis` must exactly match that
entry's current three fields (absent/empty is `null`; phone digits and CRM ID are
normalized as in the router). A changed phone or manual relink invalidates stale
context instead of mixing records. Routing JIDs and allowlists are never taken
from enrichment; the merged view is never written back to the router map.

**Clear linked identity** suppresses enrichment for that entry via
`enrichmentDisabled: true`, including after a restart. Explicitly linking it again
reenables enrichment. Missing/invalid enrichment falls back to router-only context;
invalid files emit a sanitized warning. Enrichment changes need no router reload.

Roll out the reader and producer together, pause old shared-file writers first,
and preserve existing router links for compatibility. Do not restore a stale
identity-map backup over new conversations on rollback. Keep old shared-file sync
jobs disabled if rolling the reader back. This storage boundary does not establish
identity ownership: the producer must separately validate its matching policy.

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

### Child Pi model and thinking

Open `/whatsapp` → `Child Pi Settings` to set the model and thinking level used by routed child Pi turns. Settings are stored outside the package at `~/.pi/agent/extensions/whatsapp-pi/child-pi.json`, so extension updates do not overwrite them. A saved change applies to the next routed WhatsApp turn, including turns for an existing per-conversation session; it does not change a child turn that is already running.

For deployment-managed configuration, set environment overrides before starting the host Pi process:

```bash
export WHATSAPP_PI_ROUTER_MODEL="openai-codex/gpt-5.6-luna"
export WHATSAPP_PI_ROUTER_THINKING="low"
```

Precedence is environment override → saved `/whatsapp` setting → normal Pi default/session behavior. When an environment override is active, the settings screen marks it as such; UI changes are saved as fallbacks but do not become effective until that environment variable is unset and the host Pi process is restarted. Supported thinking values are `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, and `max`.

Optional environment variables:

- `WHATSAPP_PI_ROUTER_PI_BIN` — Pi executable to spawn. Defaults to `pi`.
- `WHATSAPP_PI_ROUTER_TIMEOUT_MS` — child Pi turn timeout. Defaults to 10 minutes.
- `WHATSAPP_PI_ROUTER_MODEL` — model pattern passed to child Pi as `--model`, for example `openai-codex/gpt-5.6-luna`.
- `WHATSAPP_PI_ROUTER_THINKING` — thinking level passed to child Pi as `--thinking`.
- `WHATSAPP_ROUTER_ALLOW_NUMBERS` — comma-separated numbers/JIDs to force-add to the allowlist at startup.
- `WHATSAPP_ROUTER_ALLOW_ALL` or `WHATSAPP_ROUTER_ALLOW_ALL_DIRECT_CHATS` — set to `true`, `1`, `yes`, `on`, `all`, or `*` to route every inbound direct chat without allowlist checks.
- `WHATSAPP_ROUTER_ALLOW_ALL_GROUPS` — set to a truthy value to route every inbound group without allowlist checks. Groups are explicit-only by default.
- `WHATSAPP_ROUTER_OUTBOUND_POLL_MS` — outbound queue polling interval in milliseconds. Defaults to `2000`; values below `500` are ignored.
- `STT_PROVIDER` — speech-to-text provider for inbound WhatsApp voice/audio. Defaults to local whisper-cpp. Set to `openrouter` to use OpenRouter.
- `OPENROUTER_API_KEY` — required when `STT_PROVIDER=openrouter`.
- `STT_MODEL` — OpenRouter STT model. Defaults to `openai/whisper-1`.
- `WHATSAPP_PI_ROUTER_TTS_MODE` — voice reply mode: `off`, `explicit`, `mirror`, `mirror-explicit`, or `always`.
- `WHATSAPP_PI_ROUTER_TTS_MODEL` — OpenRouter speech model. Defaults to `google/gemini-3.1-flash-tts-preview`.
- `WHATSAPP_PI_ROUTER_TTS_VOICE` — voice supported by the selected speech model. Defaults to `Sulafat`.
- `WHATSAPP_PI_ROUTER_TTS_SPEED` — speech speed from `0.5` to `2`. Defaults to `1`.

TTS environment overrides take precedence over saved `/whatsapp` settings, which take precedence over router defaults. `OPENROUTER_API_KEY` is required whenever the effective TTS mode is not `off`.

## Development

```bash
git clone https://github.com/x4484/whatsapp-pi-router.git
cd whatsapp-pi-router
npm install
pi -e ./src/whatsapp-router.ts
```

Run checks:

```bash
npm run typecheck
npm test
```

## Notes

- Child Pi turns use `--no-extensions` and explicitly load only the non-recursive `send_wa_image` handoff extension.
- Session history remains persistent because each WhatsApp JID maps to one stable private session directory.
- Turns for the same conversation are serialized so simultaneous messages cannot create or update competing sessions.
- Streaming is intentionally not implemented; WhatsApp receives the final answer once the child Pi turn completes.
