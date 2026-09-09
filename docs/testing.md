# Testing

## Two computers on one machine

You do not need a second computer for most of it. Firefox profiles are fully
separate — their own storage, their own extension instances, their own Mozilla
account session — so two profiles behave like two machines.

```
firefox --no-remote -P                     # profile manager
firefox --no-remote -P laptop &
firefox --no-remote -P desktop &
```

`--no-remote` is the important flag: without it the second command just opens a
window in the first profile.

Give each profile a different computer name during setup and point both at the
same destination.

### What a second machine adds

Three things the profiles cannot show, all of them consequences of being a
different environment rather than the same Firefox twice:

- a different Firefox build, where the fingerprint that re-attaches group
  identities across restarts has to carry more weight;
- a different set of containers, so the resolve-by-name path and its fallback to
  the default container actually run;
- real latency to the server.

Clock skew between the machines is not a concern. The comparison is always
between the `updatedAt` a device wrote and the one you acknowledged **for that
same device**, so both values come from the same clock.

## Exercising the exchange

With two profiles pointed at the same destination:

1. Open some groups in A and sync. `A.json` appears in the folder.
2. Sync again without changing anything. Nothing should be rewritten — the
   session signature is unchanged.
3. Open different groups in B and sync. `B.json` appears; `A.json` is untouched.
4. In B, the popup should now offer A, with three answers.

**Open here** adds A's groups to B's. Both sets are then open, which is the
correct outcome: after the next sync they are all B's, and A will be offered
them in turn.

**Replace mine** closes B's own groups and opens A's instead. Those closures are
published, so A follows on its next check. A snapshot is written first.

**Do nothing** dismisses the notice. It is an answer, not a postponement: the
version is acknowledged and the same change is not offered again.

After any of the three, a further check must come back empty. If it does not,
the acknowledgement is not sticking.

## Testing the Firefox Sync destination

This one needs a Mozilla account, because that is the transport. Sign both
profiles into the **same** account and enable **Add-ons** under Sync settings,
or nothing is carried between them.

Three things to expect, all by design rather than by bug:

- **A temporary add-on cannot be tested this way.** Firefox discards an
  extension's storage — local *and* sync — when a temporarily loaded add-on is
  unloaded, which happens on every restart. Testing this destination properly
  needs the extension installed and signed.
- **It is not immediate.** Firefox pushes `storage.sync` roughly every ten
  minutes and there is no way to force it from an extension. `about:sync-log`
  shows what it actually did.
- **There is no history.** Snapshots would consume the whole 100 KB quota within
  days, so history is only offered on the server destinations.

The quota is the real constraint here: about 100 KB per extension and 8 KB per
item. A device file larger than one item is split across several transparently,
but a very large session will still exhaust the total, and the popup says so
rather than failing quietly.

## Encryption across profiles

1. In profile A, finish setup choosing encryption, and note the passphrase.
2. In profile B, set up the same destination. At step 3 it should say the files
   on the server are already encrypted and ask for the passphrase.
3. Type it wrong once: it must say the password does not match, not fail with a
   decryption error.
4. Type it right: B should read A's groups.

Then change the passphrase in A. B should pause syncing and ask for the new one
rather than retrying against files it cannot read.

A computer that used a *different* password is a separate case from being locked
out: its files are listed as unreadable and are not offered, while everything
else keeps working. Readability is decided by attempting the verifier in each
file's header, not by comparing key identifiers.

## Diagnostics

Settings → Advanced holds two things worth knowing about.

**Test how the server handles writes** walks every conditional-write case and
prints the raw status of each. It distinguishes "unreachable", "credentials
rejected", "no version tags" and "version tags rewritten by a proxy", which all
otherwise surface as the same opaque network error. It writes a padded file on
purpose: a short one slips under a proxy's compression threshold and hides ETag
rewriting entirely.

**Requests from the last failed sync** shows what happened, in order, with the
conditional headers sent and the ETags received. The popup has a one-click
**Copy diagnostics** button for the same data.

## Before every commit

```
npx eslint .
./build.sh
```

`no-undef` matters more than usual: the extension loads as ES modules with no
build step, so a name that is used but never imported is valid syntax and fails
only when a user clicks the thing that calls it. `build.sh` packages the
extension and runs Mozilla's own `addons-linter` against the result, which is
the same check AMO performs on upload.
