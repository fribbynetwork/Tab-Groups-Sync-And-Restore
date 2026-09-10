# Notes for reviewers

Paste this into the "Notes for reviewers" field. Adjust the two marked spots
before sending.

---

Thank you for reviewing. A few things that should save you time.

**No build step.** The uploaded files are the source: plain ES modules, no
minification, no bundling, no transpilation. There is nothing to reproduce and
no source upload is needed. Roughly 5,300 lines across 20 JavaScript files.

**No remote code, ever.** The extension fetches JSON data from the server the
user configures and parses it with `JSON.parse`. Nothing fetched is executed.
There is no `eval`, no `new Function`, no `importScripts`, no injected script
tags, and no third-party or bundled libraries of any kind. Every `innerHTML`
assignment in the codebase sets the empty string to clear a list; all content is
built with `createElement` and `textContent`.

**No content scripts and no required host access.** The extension never runs
code on web pages.

## About `optional_host_permissions: ["https://*/*", "http://*/*"]`

This is the part that looks alarming, so it is worth explaining precisely.

The extension syncs tab groups to a destination the **user** chooses and types
in: a Nextcloud instance, a WebDAV server, a Git host, or a small JSON endpoint
they run themselves. That address cannot be known in advance, which is why the
optional pattern is broad.

It is never requested wholesale. When the user configures a destination,
`permissions.request()` is called for **that single origin only**, derived from
the address they typed:

* `adapters/base.js` → `originPatternFor()` and `requestHostPermission()`
* `options/options.js` → `withHostPermission()`, which wraps the click handlers

`originPatternFor` deliberately strips the port, because match patterns must not
contain one, and rejects any scheme other than http/https. The adapters
themselves only ever *check* the permission with `permissions.contains()` and
never request it — requesting is confined to user-gesture handlers in the
options page.

If you would prefer a narrower declaration, we are happy to change it, but we
could not find a way to express "one origin, chosen at runtime" in the manifest.

## Permissions and why each is needed

* `tabs`, `tabGroups` — read the address and title of grouped tabs, and recreate
  groups on another computer. This is the extension's entire purpose.
* `storage` — settings and credentials locally; also the data itself when the
  user picks Firefox Sync as the destination.
* `alarms` — periodic sync instead of a timer in a persistent page.
* `sessions` — only `getRecentlyClosed()` and `restore()`, to show Firefox's own
  recently-closed list in the popup.
* `contextualIdentities` — resolve a group's container by name when restoring it,
  falling back to the default container.

## Data collection declaration

The manifest declares `browsingActivity` as required. Tab addresses and titles
are transmitted to the destination the user configures, so `none` would have
been untrue even though nothing reaches the developer. There is no server
operated by us, no analytics, no telemetry, and no third parties. The privacy
policy sets out exactly what is handled and what is not.

Optional encryption uses WebCrypto only — PBKDF2 to derive, AES-GCM to seal — in
`lib/crypto.js`. No cryptography is implemented by hand. The derived key is
non-extractable and kept in IndexedDB; the passphrase is never stored or
transmitted.

## How to test it without setting up a server

The quickest path needs no infrastructure at all:

1. Install and open the settings page. It opens by itself on first run.
2. Step 1: name the computer, anything.
3. Step 2: choose **Firefox Sync** as the destination. No credentials, no host
   permission prompt, nothing to configure.
4. Step 3: choose no encryption, or set a password to exercise that path.
5. Create a couple of tab groups and press **Sync now** in the popup.

That exercises capture, storage, the popup and the settings page. The data goes
to `storage.sync` and never leaves the machine unless the profile is signed into
a Mozilla account.

To see the cross-computer flow, do the same in a second Firefox profile
(`firefox --no-remote -P`) pointed at the same destination. The second profile's
popup will offer the first computer with three choices: open its groups here,
replace the local ones, or dismiss. Nothing is ever applied automatically, not
even at startup.

<!-- OPTIONAL — delete this block if you would rather not provide one -->
If it helps to exercise the WebDAV or custom-endpoint paths, a throwaway test
server is available:

* Address: [YOUR TEST URL]
* Token / credentials: [YOUR TEST CREDENTIALS]

It holds nothing but test data and can be wiped at any time.
<!-- end optional block -->

## Source and licence

GNU GPL v3. Repository: [YOUR REPOSITORY URL]

Happy to answer anything or to make changes — please just ask rather than
rejecting if something looks off; we would rather fix it.
