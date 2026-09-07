# WhatsApp router startup and recovery

Use this Linux/systemd deployment for an always-on WhatsApp agent. Installing the
extension and selecting `/whatsapp` → Connect **does not create a service**: it
connects WhatsApp inside the current Pi process and saves linked-device credentials.
Set up supervision separately after pairing.

```text
systemd service → Python supervisor → dedicated tmux server → Pi + WhatsApp router
                                                               └→ headless child turns
```

Each inbound conversation uses its own persistent Pi history. The long-running
parent holds the WhatsApp connection and spawns headless child turns. The dedicated
tmux console is for operations; no attached SSH terminal is required.

## Templates and prerequisites

Use [`whatsapp-router.service.in`](whatsapp-router.service.in) for **new agents**.
It is a substitution template, not a ready-to-install unit or a systemd `@` instance
unit. Replace every token and save it as `whatsapp-router-<agent>.service`.

Prerequisites: Linux with systemd, `/usr/bin/python3`, `/usr/bin/tmux`, a working Pi
installation with this extension, provider authentication, and paired WhatsApp
credentials belonging to the intended service user/config directory. Install
`ffmpeg` and configure STT/TTS credentials if voice features are enabled. Adjust
Python/tmux executable paths in the scripts if the host uses different locations.

| Token | Value to determine on the target host |
|---|---|
| `@AGENT@` | Unique lowercase letters/digits/hyphens/underscores name, e.g. `sales`; shared by unit, runtime directory, and tmux session |
| `@USER@` | Existing operating-system account that owns the agent and its credentials |
| `@HOME@` | Absolute home directory for that account |
| `@WORKDIR@` | Absolute agent working directory, containing its intended project context |
| `@PI_CONFIG_DIR@` | Actual Pi configuration directory, usually `<home>/.pi/agent` |
| `@NODE_BIN_DIR@` | Absolute directory containing the Node runtime used by Pi |
| `@PI_BIN@` | Absolute Pi executable path, resolved as the service user |
| `@ROUTER_STATE_DIR@` | Actual router state directory containing `config.json`, `auth.lock`, and `connection-events.jsonl`; usually `<pi-config>/extensions/whatsapp-pi` |

This simple template assumes paths without whitespace, `%`, quotes, backslashes,
or newlines. If the host needs such paths, render a correctly escaped systemd unit
rather than doing blind string substitution. Do not put secrets into token values.
Both scripts must receive the **same explicit `--session` and `--socket`**. The
service user must own its credentials/state and be able to execute Pi and Node.
Use an existing verified account/environment; changing ownership or isolating a
worker into a new account is a separate migration.

## First-time installation

1. Install the router, launch Pi as the intended user in the intended working
   directory, and pair through `/whatsapp`. Confirm allowed contacts/groups and
   child model/thinking settings. Verify it can connect before service handover.
2. Privately back up affected configuration and record the current router PID,
   authentication-lock owner, state directory, and effective child settings.
3. Install `supervise-router.py` and `wait-router-ready.py` under
   `/usr/local/libexec/whatsapp-router/`, owned by root and mode 0755. These scripts
   are shared code; review compatibility before replacing them on multi-agent hosts.
4. Create `/etc/whatsapp-router/<agent>.env`, owned by root and mode 0600, from the
   existing trusted secret source. Preserve the router's necessary environment
   (for example `OPENROUTER_API_KEY` and STT provider when configured). Create an
   empty file if no extra variables are needed: the template requires the file.
   Never place secrets in unit files, command arguments, source control, or logs.
   Do not override HOME, PATH, or config paths accidentally in this file. Existing
   on-disk Pi authentication remains in use.
5. Render the template with verified paths, confirm no `@TOKEN@` placeholders
   remain, and install `/etc/systemd/system/whatsapp-router-<agent>.service` owned
   by root, mode 0644. Run `systemd-analyze verify` on it and
   `systemctl daemon-reload`. These steps alone do not start the router.
6. Wait for active customer turns to finish. Gracefully stop the manually started
   router and verify its authentication lock is released. Never start two routers
   against the same credentials; do not delete a live lock to force takeover.
7. Run `systemctl enable --now whatsapp-router-<agent>.service`.
8. Verify a fresh `connection-open` event from the new Pi PID and matching lock
   owner. Confirm child model/thinking, required credentials availability, and any
   configured identity enrichment are preserved. Do not expose secret values.
9. In an approved idle maintenance window, test a service restart and controlled
   process exit. Do not reboot the host merely to test setup. Unfinished customer
   turns are not durably replayed by this supervision layer.
10. Record the service name, user, state/config paths, and exact attach command in
    the handoff. The old setup tmux session is redundant once the new service is
    verified; check for unrelated jobs before removing it.

## Operations

Replace `<agent>` in these commands; they are not literal shell arguments:

```bash
systemctl status whatsapp-router-<agent>.service
journalctl -u whatsapp-router-<agent>.service --since '10 minutes ago'
systemctl restart whatsapp-router-<agent>.service
systemctl stop whatsapp-router-<agent>.service
systemctl start whatsapp-router-<agent>.service

# Attach as the service user (or authorized root operator):
tmux -S /run/whatsapp-router-<agent>/tmux.sock attach -t <agent>
# Detach: Ctrl+B, then D. Detaching does not stop the router.
```

The dedicated server is **not** visible in a plain `tmux ls` against the default
server. Do not start another Pi router because an old/default tmux pane is empty.
Use `systemctl stop` for intentional maintenance: quitting Pi in the console causes
a supervised restart. `/reload` is available for compatible extension changes;
use a planned service restart when a new Pi core or startup environment must take
effect. Never reload/restart active customer work merely to inspect status.

## Readiness and recovery semantics

- Boot launches Pi with `--whatsapp-pi-online`. Process exit/crash restarts after
  five seconds. `systemctl stop` stays stopped.
- The foreground supervisor observes the actual Pi pane process. Systemd owns the
  supervisor, dedicated tmux server, Pi, and descendants in one cgroup. It never
  supervises the unrelated default tmux server.
- The startup gate requires a fresh `connection-open` from the new Pi PID with
  matching authentication-lock ownership. Old `status=connected` JSON alone
  cannot pass. If startup stalls for 90 seconds, systemd stops/retries the process.
- Missing/rejected credentials and connection conflicts require operator action.
  The gate warns and leaves the console accessible rather than resetting
  credentials or forcing restarts. An active service is **not proof of connection**.
- Saved linked-device credentials can have `registered=false` with a valid `me.id`;
  the router recognizes the saved login identity without rewriting credentials.
- The successful startup gate is not an ongoing socket watchdog. The router's
  transient-disconnect retry/backoff handles later connection interruptions.
- SIGTERM allows up to 20 seconds for Pi cleanup before closing the dedicated tmux
  server; systemd's 35-second stop deadline bounds remaining cleanup.

Do not call `tmux kill-server` without the correct dedicated `-S` path. Reset
WhatsApp credentials only when deliberately re-pairing. Preserve identity maps
and enrichment boundaries; never overwrite newer conversations with stale backups.

## Existing deployments and rollback

`emily-router.service` remains a **legacy host-specific example**, not the template
for new installations. Existing units can keep their names and paths. For backward
compatibility, the supervisor still defaults to session `emily` and cwd `/root`,
and the readiness checker defaults to session `emily` when omitted. New units must
always pass explicit session/cwd/socket/state paths as the generic template does.
No existing service needs to be renamed or restarted merely because this reusable
template was added. Never install the new unit alongside an old unit using the
same WhatsApp credentials.

For a deliberate rollback, stop and disable the new service first, confirm its
lock is released, and restore only the backed-up code/configuration changes.
Do not restore stale identity or credential snapshots over newer state. Return
to the previous service or manual console, never both. Preserve any separate
identity-enrichment producer and its single-writer storage contract.

## Tests

```bash
npm run typecheck
npm test
python3 tests/test_router_supervisor.py
python3 tests/test_router_readiness.py
```

Mocks test generic session targeting and legacy compatibility without starting
Pi or touching WhatsApp credentials. Full Linux acceptance testing should use a
sleeping fake process with an isolated transient systemd unit and tmux socket:
child crash, supervisor crash/orphan cleanup, service restart, intentional stop,
and readiness. Do not use live WhatsApp credentials for those tests.
