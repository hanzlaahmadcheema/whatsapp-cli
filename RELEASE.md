# Release checklist

Manual verification steps before shipping a build of the `wa` CLI.

All steps assume a fresh terminal, Node >= 18, and that you are in the repo
root. Real WhatsApp traffic is used; do **not** run these in tight loops to
avoid hitting send-rate limits (see the safety note at the end).

## 1. First-run QR login

```sh
rm -rf .data .wwebjs_cache
node scripts/fetch-web-build.js   # populates the local webVersion cache
wa login                          # shows a QR, blocks until linked + healthy
```

- `wa login` should print a QR and wait (not exit).
- After scanning on your phone, it should report linked/ready and exit.
- If a preserved session already exists, `wa login` should skip the QR and
  report `Already linked and ready.`

## 2. Restart without re-scan

```sh
wa status            # expect state: ready
kill <daemon-pid>    # daemon pid shown in `wa status`
wa status            # should auto-spawn daemon and reach ready again
```

- No QR prompt may appear after restart.
- LocalAuth session under `.wwebjs_auth/session` is reused.

## 3. Send to one contact

```sh
wa send 15551234567 "hello from wa cli"
```

- Validates the number, formats JID, checks state is ready, sends.
- Confirms with the message id.

## 4. Send to a group

```sh
wa contacts | grep -i <friend>     # find a group id
wa send "120363000000000000@g.us" "hello group"
```

- Group JIDs (`<id>@g.us`) are accepted without a number check.

## 5. Daemon reconnect after process kill

```sh
wa daemon --foreground   # or `node src/daemon/index.js`
# in another shell:
kill $(cat .data/daemon.json | python3 -c 'import sys,json;print(json.load(sys.stdin)["pid"])')
wa chats                 # auto-spawns; should list chats again
```

- The transient-disconnect path schedules exponential backoff reconnects.

## 6. Clear failure messaging when WhatsApp invalidates the session

```sh
# On the phone: Settings > Linked devices > Log out of this device
wa status                # should report logged_out / invalid session
wa login                 # re-issues the QR, complete step 1 again
```

- CLI must fail cleanly and point the user at `wa login`, never hang.

## 7. Cache + config compatibility

```sh
node scripts/fetch-web-build.js --force   # re-fetch pinned web build
wa status
```

- The daemon must fall back to the newest cached build if the pinned one is
  pruned upstream (known `wa-version` behavior in 2026).

## Scope / safety note

This tool is personal-use only. Keep sends rate-limited (`wa send` with a
manual delay between messages) and do not script bulk/circular sends.

## whatsapp-web.js in-place patch

`whatsapp-web.js@1.34.7` breaks against 2026 WhatsApp web builds: the internal
message-key field `_serialized` was minified to `$1`, so `Msg.get(undefined)`
throws and `getChats()`/`sendMessage()` crash with `r: r` / `t: t`.

A pinned fork is avoided for now; instead `scripts/wwebjs-patch.js` (run
automatically by `postinstall`) applies the upstream PR #2018 fix idempotently
to `node_modules/whatsapp-web.js/src/util/Injected/Utils.js`:

- tolerant `getMsgKeyId()` helper (`_serialized ?? $1`),
- rebuilds `_serialized` on serialized message keys,
- `getChats()` processes each chat independently,
- LID group-metadata lookups are try/caught.

You can re-apply or force-unapply with:

```sh
npm run patch        # idempotent; re-applies after a fresh `npm install`
```

If you upgrade `whatsapp-web.js`, re-check whether the upstream fix landed and
remove this postinstall script.

## Upgrade branch process

1. `git checkout -b upgrade/whatsapp-web`
2. Bump `whatsapp-web.js` in `package.json`, run `npm install`.
3. Run `npm test` and steps 2-6 above.
4. If green merge into a main, else revert and keep the pinned `1.34.7`.