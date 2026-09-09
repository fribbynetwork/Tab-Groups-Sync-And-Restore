<?php
/**
 * Reference implementation of the "Custom endpoint" backend.
 *
 * Drop this on any PHP host, set TOKEN and DATA_DIR, and point the extension at
 * its URL. It is deliberately small: the whole contract is four routes.
 *
 *   GET    {base}/{key}            200 + JSON body + ETag, or 404
 *   PUT    {base}/{key}            200 + new ETag; 412 when If-Match is stale
 *   DELETE {base}/{key}            200 or 404
 *   GET    {base}?list={prefix}    200 + [{ key, modifiedAt }]
 *
 * Authorization: Bearer <token> on every request.
 *
 * The ETag is what keeps two computers from overwriting each other: the
 * extension sends back the version it based its change on, and a mismatch makes
 * it re-read and merge instead of clobbering.
 */

declare(strict_types=1);

const TOKEN    = 'change-me';                 // must match the token in Settings
const DATA_DIR = __DIR__ . '/tgsr-data';      // keep this outside the web root

/* ---------- auth ---------- */

/**
 * Apache with CGI or FastCGI strips the Authorization header before PHP sees
 * it unless told otherwise, which looks exactly like a wrong token. Several
 * places are checked, and a missing header is reported differently from a
 * mismatched one so the two are not confused.
 *
 * If the header never arrives, add to your Apache config:
 *     SetEnvIf Authorization "(.*)" HTTP_AUTHORIZATION=$1
 * or, on Apache 2.4.13+:
 *     CGIPassAuth On
 */
function bearerToken(): ?string
{
    $candidates = [
        $_SERVER['HTTP_AUTHORIZATION'] ?? null,
        $_SERVER['REDIRECT_HTTP_AUTHORIZATION'] ?? null,
    ];

    if (function_exists('apache_request_headers')) {
        foreach (apache_request_headers() as $name => $value) {
            if (strcasecmp($name, 'Authorization') === 0) {
                $candidates[] = $value;
            }
        }
    }

    foreach ($candidates as $header) {
        if ($header && preg_match('/^Bearer\s+(.+)$/i', trim($header), $m)) {
            return $m[1];
        }
    }
    return null;
}

$token = bearerToken();

if ($token === null) {
    http_response_code(401);
    header('Content-Type: application/json');
    echo json_encode([
        'error'  => 'missing-authorization-header',
        'detail' => 'PHP never received an Authorization header. '
                  . 'Add "SetEnvIf Authorization \"(.*)\" HTTP_AUTHORIZATION=$1" '
                  . 'to your Apache config, or CGIPassAuth On.',
    ]);
    exit;
}

if (!hash_equals(TOKEN, $token)) {
    http_response_code(401);
    header('Content-Type: application/json');
    // Lengths only: enough to spot a truncated or empty value without echoing
    // the credential back to an unauthenticated caller.
    echo json_encode([
        'error'    => 'token-mismatch',
        'received' => strlen($token) . ' characters',
        'expected' => strlen(TOKEN) . ' characters',
    ]);
    exit;
}

if (!is_dir(DATA_DIR) && !mkdir(DATA_DIR, 0700, true)) {
    http_response_code(500);
    exit;
}

/**
 * The default DATA_DIR sits next to this script, which means it sits under the
 * document root: every synced file would be one guessed URL away, and without
 * encryption that is the user's browsing history. Moving DATA_DIR outside the
 * document root is the real fix; this is the safety net for when it is not.
 */
$denyFile = DATA_DIR . '/.htaccess';
if (!is_file($denyFile)) {
    @file_put_contents($denyFile, "Require all denied\nDeny from all\n");
}

/* ---------- routing ---------- */

$method = $_SERVER['REQUEST_METHOD'];
$key    = trim($_SERVER['PATH_INFO'] ?? '', '/');

/**
 * ?selftest reports what the server is actually doing with this request, which
 * is the fastest way to tell a misrouted URL from a stripped header. It runs
 * after authentication, so it exposes nothing to an anonymous caller.
 */
if ($method === 'GET' && isset($_GET['selftest'])) {
    $inDocRoot = false;
    $root = realpath($_SERVER['DOCUMENT_ROOT'] ?? '');
    $data = realpath(DATA_DIR);
    if ($root && $data) {
        $inDocRoot = str_starts_with($data, $root);
    }

    header('Content-Type: application/json');
    echo json_encode([
        'ok'                 => true,
        'authorizationSeen'  => true,
        'pathInfo'           => $_SERVER['PATH_INFO'] ?? null,
        'pathInfoWorks'      => isset($_SERVER['PATH_INFO']),
        'dataDirWritable'    => is_writable(DATA_DIR),
        'dataDirInDocRoot'   => $inDocRoot,
        'phpVersion'         => PHP_VERSION,
    ], JSON_PRETTY_PRINT);
    exit;
}

if ($method === 'GET' && isset($_GET['list'])) {
    listing((string) $_GET['list']);
    exit;
}

// Keys look like "groups/<uuid>.json"; anything else is rejected outright so a
// crafted key cannot escape the data directory.
if ($key === '' || !preg_match('#^[A-Za-z0-9._/-]+$#', $key) || str_contains($key, '..')) {
    http_response_code(400);
    exit;
}

$path = DATA_DIR . '/' . $key;

switch ($method) {
    case 'GET':    handleGet($path); break;
    case 'PUT':    handlePut($path); break;
    case 'DELETE': handleDelete($path); break;
    default:       http_response_code(405);
}

/* ---------- handlers ---------- */

function etagOf(string $path): string
{
    return substr(hash_file('sha256', $path), 0, 16);
}

function handleGet(string $path): void
{
    if (!is_file($path)) {
        http_response_code(404);
        return;
    }
    header('Content-Type: application/json');
    header('ETag: "' . etagOf($path) . '"');
    readfile($path);
}

function handlePut(string $path): void
{
    $ifMatch     = trim($_SERVER['HTTP_IF_MATCH'] ?? '', '"');
    $ifNoneMatch = $_SERVER['HTTP_IF_NONE_MATCH'] ?? '';
    $exists      = is_file($path);

    // "*" means create-only: fail if something is already there.
    if ($ifNoneMatch === '*' && $exists) {
        http_response_code(412);
        return;
    }
    if ($ifMatch !== '' && (!$exists || etagOf($path) !== $ifMatch)) {
        http_response_code(412);
        return;
    }

    $body = file_get_contents('php://input');
    if (json_decode($body) === null && json_last_error() !== JSON_ERROR_NONE) {
        http_response_code(400);
        return;
    }

    $dir = dirname($path);
    if (!is_dir($dir) && !mkdir($dir, 0700, true)) {
        http_response_code(500);
        return;
    }

    // Written to a temporary file first so a reader never sees a half-file.
    $tmp = $path . '.tmp';
    if (file_put_contents($tmp, $body, LOCK_EX) === false || !rename($tmp, $path)) {
        http_response_code(500);
        return;
    }

    header('ETag: "' . etagOf($path) . '"');
    http_response_code(200);
}

function handleDelete(string $path): void
{
    if (!is_file($path)) {
        http_response_code(404);
        return;
    }
    unlink($path);
    http_response_code(200);
}

function listing(string $prefix): void
{
    if (str_contains($prefix, '..')) {
        http_response_code(400);
        return;
    }

    $base    = rtrim(DATA_DIR, '/');
    $results = [];

    $iterator = new RecursiveIteratorIterator(
        new RecursiveDirectoryIterator($base, FilesystemIterator::SKIP_DOTS)
    );

    foreach ($iterator as $file) {
        if (!$file->isFile() || str_ends_with($file->getFilename(), '.tmp')) {
            continue;
        }
        $relative = ltrim(substr($file->getPathname(), strlen($base)), '/');
        if ($prefix !== '' && !str_starts_with($relative, $prefix)) {
            continue;
        }
        $results[] = [
            'key'        => $relative,
            'modifiedAt' => $file->getMTime() * 1000,
        ];
    }

    header('Content-Type: application/json');
    echo json_encode($results);
}
