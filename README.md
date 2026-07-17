# whatsapp-pi-router

WhatsApp-to-Pi router with one isolated Pi session per WhatsApp conversation.

This package is based on the `whatsapp-pi` WhatsApp integration, but inbound WhatsApp messages are routed to stable per-conversation Pi sessions instead of being injected into the currently active terminal session.

## Routing model

Each WhatsApp thread gets a deterministic private session directory:

- direct chats → `~/.pi/agent/extensions/whatsapp-pi/child-sessions/direct-<sha256-jid-prefix>/`
- group chats → `~/.pi/agent/extensions/whatsapp-pi/child-sessions/group-<sha256-jid-prefix>/`

On each inbound message, the extension runs a headless Pi turn that continues the latest session in that conversation directory:

```bash
pi --session-dir <conversation-directory> --continue [--model <provider/model>] [--thinking <level>] --no-extensions --print "<message>"
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

You can also enable direct-chat allow-all mode in `~/.pi/agent/extensions/whatsapp-pi/router-allow.json`:

```json
{
  "allowAllDirectChats": true,
  "allowAllGroups": false,
  "allow": []
}
```

`allowAllDirectChats` bypasses direct-chat allowlist checks at runtime without deleting the saved allowlist. Set it back to `false` or use the `/whatsapp` toggle to return to explicit allowlist mode. Legacy `"allowAll": true` is still accepted as an alias for direct chats only.

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

The router sends text to OpenRouter's `/api/v1/audio/speech` endpoint, receives MP3, converts it with `ffmpeg` to mono OGG/Opus, and sends it through Baileys as a push-to-talk voice note. The default model is `google/gemini-3.1-flash-tts-preview`, with voice `Sulafat` and speed `1`. Models and voice catalogs change over time, so configure a current OpenRouter speech model/voice when overriding the defaults.

Each TTS input includes director's notes before the transcript. They ask for Emily's warm, casual vocal smile, relaxed pacing, clear enunciation, neutral General American English, and native pronunciation for other languages.

TTS uses the same `OPENROUTER_API_KEY` as OpenRouter STT. If synthesis, conversion, or voice delivery fails, the router logs the error and falls back to the cleaned text reply. Replies over 4096 characters also fall back to text rather than being truncated or incurring an unexpectedly large TTS request. Temporary MP3/OGG files are mode `0600` and removed after delivery.

TTS currently applies to automatic replies from routed per-conversation child Pi sessions. Menu sends, the file-backed outbound queue, and legacy main-session forwarding remain text-only.

## Identity mapping and LID routing

WhatsApp may identify direct chats with `@lid` privacy IDs instead of phone-number JIDs. The router runs on Baileys v7, records Baileys `lid-mapping.update` and `chats.phoneNumberShare` events, and stores local identity links in `~/.pi/agent/extensions/whatsapp-pi/identity-map.json` so a known WhatsApp conversation can be tied to a LID, phone, email, or external record ID without using display names as stable lookup keys.

For direct chats, LID is preferred as the reply identity when WhatsApp provides one. If an incoming message includes both a phone JID and a LID alternate, the router stores the PN↔LID mapping, routes the child Pi session by the LID, and sends replies to the LID. If a manual outbound send starts from a phone JID, Baileys' LID mapping store is checked before send and the message is upgraded to the mapped LID when available.

Use `/whatsapp` → `Recents` → a conversation → `Link Phone`, `Link Email`, or `Link External Record ID` to add business-system context. The child Pi prompt receives the known linked identity as private context. Specific agents can decide whether an external record ID maps to a customer profile, helpdesk ticket, sales record, or another system. WhatsApp display names are still passed as weak candidates for greeting, manual review, or clarifying questions, but they are not stable lookup keys. Groups remain explicit allowlist conversations and do not get identity links.

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

- Child Pi turns use `--no-extensions` to avoid recursively starting another WhatsApp router.
- Session history remains persistent because each WhatsApp JID maps to one stable private session directory.
- Turns for the same conversation are serialized so simultaneous messages cannot create or update competing sessions.
- Streaming is intentionally not implemented; WhatsApp receives the final answer once the child Pi turn completes.
