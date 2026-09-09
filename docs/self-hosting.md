# Self-hosting

You do not need this. Nextcloud, any WebDAV server, or a private Git repository
all work out of the box. Run your own endpoint if you want the smallest possible
thing on your server, or if you want to build the storage into something else.

The contract is four routes. `server/rest-endpoint.php` implements them in about
ninety lines and is meant to be read, not just deployed.

## The contract

Every request carries `Authorization: Bearer <token>`.

| Method | Path | Meaning |
|---|---|---|
| `GET` | `{base}/{key}` | 200 with the JSON body and an `ETag` header, or 404 |
| `PUT` | `{base}/{key}` | 200 with a new `ETag`; 412 if the precondition fails |
| `DELETE` | `{base}/{key}` | 200, or 404 |
| `GET` | `{base}?list={prefix}` | 200 with `[{ "key": "...", "modifiedAt": 1699999999000 }]` |

`key` looks like `ComputerCasa.json` or `history/ComputerCasa/<timestamp>.json`.
Reject anything outside `[A-Za-z0-9._/-]` and anything containing `..`.

Every computer owns exactly one file at the root, named after itself, and writes
only that one. The folder listing is the register of devices; there is nothing
else to keep in step with it.

### Preconditions

- `If-Match: "<etag>"` — write only if the stored version still matches.
  Otherwise **412**.
- `If-None-Match: *` — write only if nothing is stored yet. Otherwise **412**.
- Neither header — write unconditionally.

These matter less than they used to. Because each computer writes only its own
file, two machines never contend for one, and the ordinary device write carries
no precondition at all. Implementing them correctly is still worth it — the
history and the rename path use them — but an endpoint that ignores them will
not lose anybody's groups.

### ETags, caches and reverse proxies

Return an `ETag` that changes when the content changes, and make sure it is the
*same* value on `GET`, `HEAD` and `PUT`. If a `GET` and a `HEAD` for one file
disagree, something between the client and the origin is caching or rewriting —
and a conditional write then fails on a version that can never match.

Do not let the path be cached. The extension asks with `cache: no-store` and
`Cache-Control: no-cache`, but an intermediary that ignores both will serve a
stale file, and the extension will act on data that is no longer current.

Watch the proxy in front of it. Apache's `mod_deflate` appends `-gzip` to the
ETag of anything it compresses, so a client reads `"abc-gzip"` from a compressed
`GET`, sends it back in `If-Match`, and the origin — which stored `"abc"` —
refuses it. The extension strips known content-coding suffixes for exactly this
reason, but it is better not to create the problem:

```apache
# Apache: stop mod_deflate from rewriting the ETag
RequestHeader edit "If-None-Match" '^"((.*)-(gzip|br))"$' '"$1"'
Header edit ETag '^"(.*)-(gzip|br)"$' '"$1"'
```

```nginx
# nginx: simplest to not compress this path at all
location /tgsr/ {
    gzip off;
}
```

## Deploying the PHP reference

1. Copy `server/rest-endpoint.php` somewhere your web server serves.
2. Change `TOKEN` to a long random string.
3. Set `DATA_DIR` to a path **outside the document root**.
4. Point the extension at the script's URL and paste the token.

### The three things Apache gets wrong by default

Every one of these produces an error that points somewhere else, so it is worth
recognising the symptoms.

**Requests never reach the script.** With `index.php` as the DirectoryIndex only
`/` runs PHP. A `GET` for `/groups/abc.json` is a static file that does not
exist, and a `PUT` against it is a method Apache will not perform on a static
path. You get a 404 and a string of 405s — and the giveaway is that they are
Apache's own HTML error pages, not JSON from the endpoint. The extension's write
test says so explicitly when it sees one.

**The Authorization header is dropped.** Under CGI and FastCGI, Apache removes
it before PHP runs, which is indistinguishable from a wrong token unless the
endpoint says which happened. This implementation answers
`{"error":"missing-authorization-header"}` for exactly this case.

**The data directory is served over the web.** The default `DATA_DIR` sits next
to the script, so it sits under the document root, and every synced file is one
guessed URL away. Without encryption that is the user's browsing history. Move
`DATA_DIR` outside the document root; the shipped rules are a safety net, not
the fix.

`server/htaccess-example` handles all three. Copy it next to `index.php` as
`.htaccess`.

With Apache, two things need to reach the script.

```apache
<Files "rest-endpoint.php">
    AcceptPathInfo On
</Files>

# Apache strips the Authorization header before PHP sees it under CGI and
# FastCGI. Without this, every request looks like a wrong token.
SetEnvIf Authorization "(.*)" HTTP_AUTHORIZATION=$1
# On Apache 2.4.13 and later this does the same thing:
#   CGIPassAuth On
```

The reference implementation answers a missing header with
`{"error":"missing-authorization-header"}` and a wrong one with
`{"error":"token-mismatch"}`, so the two are easy to tell apart. Fetch the URL
with `curl -H "Authorization: Bearer yourtoken"` to see which you have.

With nginx and php-fpm:

```nginx
location ~ ^/tgsr(/.*)?$ {
    fastcgi_pass  unix:/run/php/php-fpm.sock;
    fastcgi_param SCRIPT_FILENAME /var/www/tgsr/rest-endpoint.php;
    fastcgi_param PATH_INFO       $1;
    include       fastcgi_params;
}
```

Serve it over HTTPS. The token is a bearer credential and the payload, if you
have not turned on encryption, is your browsing history.

## Checking it works

The endpoint answers `?selftest=1`, after authentication, with what the server is
actually doing:

```json
{
  "authorizationSeen": true,
  "pathInfoWorks": true,
  "dataDirWritable": true,
  "dataDirInDocRoot": false
}
```

`pathInfoWorks: false` means the routing rules are missing. `dataDirInDocRoot:
true` means your synced files are reachable over the web.



Settings → Advanced → **Test how the server handles writes** performs the whole
sequence and prints the status of each step:

```
207  PROPFIND folder
201  PUT new, If-None-Match:*        (expect 201)
412  PUT again, If-None-Match:*      (expect 412)
200  GET                             (expect 200 + ETag)
204  PUT with current If-Match       (expect 2xx)
412  PUT with stale If-Match         (expect 412)
204  PUT unconditional               (expect 2xx)
```

Any line where the status does not match the expectation is the thing to fix.
The probe writes a padded file on purpose: a short one slips under a proxy's
compression threshold and hides ETag rewriting entirely.

## Writing your own

The extension talks to storage through one small interface, in
`extension/adapters/base.js`:

```js
test()                  → { ok, code, detail }
read(key)               → { data, etag } | null
write(key, data, etag)  → { etag }   throws ConflictError on 412
list(prefix)            → [{ key, modifiedAt }]
remove(key)             → void
```

`write`'s third argument has three states, and merging any two of them causes
conflicts out of nowhere: a **string** means `If-Match`, **null** means
create-only, and **undefined** means unconditional. "I do not know the version"
is not the same as "this must not exist" — treating them alike makes every
update fail with 412, even with a single computer.
