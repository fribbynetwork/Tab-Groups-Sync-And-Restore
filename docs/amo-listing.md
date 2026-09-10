# AMO listing copy

Paste each section into the matching field when submitting the extension.

---

## Summary

*(AMO limits this to 250 characters)*

Sync your Firefox tab groups between computers using a destination you choose —
Firefox Sync, Nextcloud, a Git host, or your own server. Nothing is sent to the
developer, and nothing is applied without your say-so.

---

## Description

Firefox syncs your open tabs between devices, but not the groups they belong to.
Tab Groups Sync & Restore fills that gap, and lets you decide where your data
goes.

**You choose where it is stored.** Four destinations, each with its own
settings, so you can switch between them and switch back without setting
anything up twice:

* **Firefox Sync** — no setup at all. Uses your existing Mozilla account. Fine
  for a handful of groups; the space Firefox allows extensions is limited, so
  history is not available here.
* **Nextcloud or ownCloud** — sign in through your own server. Your password is
  never stored: the extension asks the server for an app password you can revoke
  at any time.
* **Any WebDAV server** — Synology, kDrive, Fastmail, a plain Apache. Give it
  the address and a login.
* **A Git host or your own endpoint** — GitHub, Gitea or Forgejo, or a small
  JSON API you run yourself. The reference implementation is under a hundred
  lines and is documented.

**Each computer has its own file.** You give the computer a name, and that name
is the file it writes. No machine ever writes to another's file, so nothing is
overwritten by accident and there is nothing to merge. Reinstall Firefox, type
the same name, and it carries on where it left off.

**Nothing happens behind your back.** When another computer changes something,
the toolbar icon says so and the popup offers three answers:

* *Open here* — add its groups to the ones you already have open.
* *Replace mine* — close what is open here and take that computer's session
  instead.
* *Do nothing* — dismiss the notice. You will only be asked again when that
  computer changes something new.

Nothing is ever applied on its own, not even at startup.

**Optional encryption.** Choose a master password and your tab titles and
addresses are sealed on your computer before they are uploaded. Whoever runs the
server sees only unreadable files. You type the password once on each computer.
It is never transmitted and cannot be recovered.

**History.** On the server destinations, a snapshot is kept each time your
groups change, per computer. Close a group by mistake and you can bring it back
— including from another computer's history. Firefox's own list of recently
closed tabs is in the popup too, which covers tabs that were not in a group.

**What is not synced.** Tabs outside a group stay on the computer they are open
on. That gives you a scratch space that never leaves the machine, and it is why
a restore never closes them. Private windows are ignored entirely.

Restored tabs are opened unloaded, so bringing back a session of fifty tabs does
not fetch fifty pages.

Available in English and Italian. Free software under the GNU GPL v3; the source
code and the self-hosting guide are linked below.

---

## Notes for the submission form

* **Categories:** Tabs, and Privacy & Security as a second choice.
* **Tags:** tab groups, sync, backup, nextcloud, webdav, self-hosted.
* **Data collection:** the manifest declares `browsingActivity` as required.
  This is correct and should not be changed to "none" — the extension transmits
  tab addresses and titles to the destination the user picks. Encryption is a
  safeguard on that transmission, not a reason to omit the declaration.
* **Privacy policy:** required because of the above. Use `privacy-policy.md`.
* **Source code:** reviewers will want the repository link, since the extension
  is not minified or built — the uploaded files are the source.
