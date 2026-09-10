# Privacy Policy — Tab Groups Sync & Restore

*Last updated: 9 September 2026*

## The short version

**Nothing is sent to the developer.** There is no server operated by us, no
analytics, no telemetry, no error reporting, no accounts, and no third parties
of any kind.

Your data travels between your own browser and the destination **you** choose
and configure. We never see it, never hold it, and have no way to obtain it.

## What the extension handles

To sync your tab groups, the extension reads and stores:

* the **address and title** of each tab inside a tab group
* whether a tab is **pinned**, and its position in the group
* the **favicon address** of each tab — the address only, never the image itself
* the **name, colour and collapsed state** of each group
* the **name of the container** a group uses, if any
* the **name you gave the computer**, and a random identifier generated on that
  computer so it can recognise its own file after a reinstall

Tab addresses and titles are personal data — they describe what you browse. That
is why the extension declares `browsingActivity` in its manifest, and why this
policy exists.

## What the extension never handles

* **Tabs that are not in a group.** They are never read, never stored and never
  transmitted. This is deliberate: it gives you a working area that stays on the
  machine it is open on.
* **Private browsing windows.** Ignored entirely.
* **Internal pages.** Addresses beginning with `about:`, `file:`, `moz-extension:`,
  `data:`, `blob:`, `view-source:`, `chrome:`, `resource:` and `javascript:` are
  filtered out before anything is stored.
* **Page content.** The extension never reads the contents of any web page. It
  has no content scripts and no permission to run code on websites.
* **Cookies, passwords, form data, bookmarks, browsing history, downloads.** None
  of these are accessed.

## Where your data goes

Only to the destination you configure. You choose one of four, and you can
change it at any time:

| Destination | Where the data is stored | Who else can reach it |
|---|---|---|
| **Firefox Sync** | Mozilla's sync servers, via your Mozilla account | Mozilla, subject to their privacy policy. Firefox encrypts sync data end-to-end with a key derived from your account password. |
| **Nextcloud / ownCloud** | The server you name | Whoever operates that server |
| **Any WebDAV server** | The server you name | Whoever operates that server |
| **Git host** (GitHub, Gitea, Forgejo) | The repository you name | Whoever can read that repository. **Use a private repository** — a public one is readable by anyone. |
| **Your own endpoint** | The server you run | You |

The extension makes network requests **only** to the destination you have
configured. Firefox asks your permission for that specific address before the
first request, and grants access to nothing else.

## Encryption

Encryption is optional and we recommend it, particularly on a server you do not
control.

When it is enabled, tab addresses and titles are encrypted on your computer,
with AES-GCM, **before** they are uploaded. Anyone with access to the server —
including the operator — sees only unreadable data.

* Your master password is **never transmitted** and never stored. It is stretched
  with PBKDF2 into a key held only on your computer, in a form the extension
  itself cannot read back out.
* You type it once on each computer.
* **It cannot be recovered.** If you lose it, the data on the server cannot be
  read again by anyone, including us.

Two things stay readable even when encryption is on, because the extension needs
them before it can decrypt anything: the **name you gave each computer**, which
is the filename, and the **time the file was last written**. Choose a computer
name you would not mind the server operator seeing.

## Credentials

The password or token for your destination is stored **locally**, in the
extension's own storage on that computer. It is not transmitted anywhere except
to the server it authenticates against.

With Nextcloud, your actual account password is never handled at all: the
extension asks the server for an application password, which you can revoke at
any time from Nextcloud's security settings.

There is one option, off by default, to carry those credentials to your other
computers — and it does so **encrypted with your master password**, so they are
readable only by someone who already knows it.

## What is kept on your computer

The extension stores locally: your settings, your destination's credentials, a
record of which computers you have already responded to, and a small cache of
favicon addresses. Snapshots of your groups are kept on the destination, not
locally, and only when you have chosen a server destination.

## Retention and deletion

You are in control of all of it:

* **Remove a computer** — Settings → History → *Remove this computer*. Deletes
  its file and its snapshots from the destination.
* **Delete a snapshot** — Settings → History, next to each one.
* **Delete everything** — remove the folder or the repository from your
  destination. The extension holds no copy anywhere else.
* **Clear this computer** — Settings → Advanced → *Reset everything*. Clears the
  local settings and credentials.

Snapshots are pruned automatically according to the limits you set, by default
after 14 days or 25 snapshots per computer, whichever comes first.

## Permissions, and why each is needed

* `tabs`, `tabGroups` — to read the addresses and titles of grouped tabs, and to
  recreate groups. This is the extension's whole purpose.
* `storage` — to keep your settings and credentials on your computer, and, if you
  choose Firefox Sync as your destination, to store the data itself.
* `alarms` — to sync periodically rather than constantly.
* `sessions` — to show Firefox's own list of recently closed tabs in the popup.
* `contextualIdentities` — to put a restored group back in the same container it
  came from.
* Access to a website — requested at runtime, only for the address of the
  destination you configure, and only when you configure it.

## Changes to this policy

Any change will be published with the version that introduces it, and the date
above updated. Material changes will be noted in the extension's release notes.

## Source code

The extension is free software under the GNU General Public License v3. It is
distributed unminified and unbundled: the files you install are the source. Every
claim on this page can be checked against the code.

## Contact

For questions about this policy or about the extension, contact the developer
through the repository's issue tracker or at the address on the add-on's listing
page.
