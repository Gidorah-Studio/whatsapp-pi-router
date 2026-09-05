# Emily startup and recovery

This Linux/systemd deployment preserves Pi's interactive console in a **dedicated**
tmux server. The foreground Python supervisor observes the actual Pi pane process;
systemd owns the supervisor, tmux server, Pi and their descendants in one cgroup.
It does not supervise the unrelated default tmux server.

## What this fixes

- Boot starts the router with `--whatsapp-pi-online`.
- Process exit/crash restarts after five seconds. `systemctl stop` stays stopped.
- A startup gate requires a fresh `connection-open` from the new Pi PID and matching
  instance-lock owner. Old `status=connected` JSON alone cannot pass it. If startup
  stalls for 90 seconds, systemd stops/retries the process.
- Saved linked-device credentials with `registered=false` and a valid `me.id` are
  recognized. Baileys uses `me` to select its login path. No credential bytes or
  flags need rewriting.
- Missing/rejected credentials and connection conflicts require operator attention.
  The startup gate logs a warning and leaves the console accessible, rather than
  forcing restarts or resetting credentials. In this case, an active systemd unit
  is **not** proof of a healthy WhatsApp connection.
- A successful startup gate is not an ongoing socket watchdog. The router retains
  its existing transient-disconnect retry/backoff behavior after startup.

## Install

Review paths in `emily-router.service` for the target host. This deployment keeps
Emily's existing root account, `/root` working directory and pinned Node binary
path; it is not the separate worker-isolation/security-hardening project.

1. Privately back up the affected code and record the current runtime/lock owner.
2. Install the patched `session.manager.ts` and `whatsapp-router.ts`, preserving
   previous identity-enrichment changes. Do not update unrelated packages.
3. Install `supervise-router.py` and `wait-router-ready.py` under
   `/usr/local/libexec/emily-router/`, owned by root and mode 0755.
4. Create `/etc/emily-router.env`, owned by root and mode 0600, from the existing
   trusted secret source. It needs `OPENROUTER_API_KEY` for the existing voice setup.
   Do not put secret values in unit files, command arguments, source control or logs.
   Pi continues using its existing on-disk provider authentication/settings.
5. Install the unit under `/etc/systemd/system/emily-router.service`, mode 0644.
   Run `systemd-analyze verify` and `systemctl daemon-reload`.
6. Wait for customer child turns to finish, then gracefully stop the **old** Pi
   process and verify its lock is released. Do not start two routers on the same auth.
7. `systemctl enable --now emily-router.service`.
8. Verify a fresh socket-open from the new lock owner, and verify child model,
   thinking level, secrets availability and identity enrichment are unchanged.
9. Test `systemctl restart` and one controlled process exit while no customer turn
   is active. Do not reboot the host merely to test this change.

## Operations

```bash
systemctl status emily-router.service
journalctl -u emily-router.service --since '10 minutes ago'
systemctl restart emily-router.service
systemctl stop emily-router.service
systemctl start emily-router.service

# Attach/detach without stopping Emily:
tmux -S /run/emily-router/tmux.sock attach -t emily
# Default detach keys: Ctrl+B, then D.
```

Use `systemctl stop` for intentional maintenance: quitting Pi in the console causes
supervised restart. `/reload` remains available for compatible extension changes,
but use `systemctl restart` when a new startup readiness check is needed.
Do not call `tmux kill-server` without the dedicated `-S` path. Do not reset WhatsApp
credentials unless the operator deliberately chooses to re-pair.

The supervisor forwards SIGTERM to Pi and allows up to 20 seconds of cleanup, then
closes its dedicated tmux server. systemd's 35-second stop deadline bounds cleanup
of remaining processes. Unfinished customer turns are not durably replayed by this
change; that is the separate message-ledger/queue fix. Check for active turns before
planned maintenance.

## Rollback

Stop and disable `emily-router.service` first. Restore only backed-up code, not stale
identity/credential snapshots. Start the old manual Pi console and use Connect
WhatsApp if the old credential check still prevents auto-connect. Keep the separate
identity-enrichment producer in place. Never run the old and new routers together.

## Tests

```bash
npm run typecheck
npm test
python3 tests/test_router_supervisor.py
python3 tests/test_router_readiness.py
```

Additional isolated Linux acceptance tests use a sleeping fake process with its
own transient systemd unit and tmux socket, never live WhatsApp auth: child crash,
supervisor crash/orphan cleanup, service restart, intentional stop and readiness.
