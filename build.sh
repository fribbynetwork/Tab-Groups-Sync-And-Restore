#!/bin/sh
# Builds the AMO package.
#
# The zip must contain manifest.json at its root. Zipping the containing folder
# instead produces "No manifest.json was found at the root of the extension",
# and — because the linter then cannot read browser_specific_settings.gecko.id —
# a warning for every storage.sync call in the codebase.
set -e

VERSION=$(python3 -c "import json;print(json.load(open('extension/manifest.json'))['version'])")
OUT="tab-groups-sync-restore-${VERSION}.zip"

rm -f "$OUT"
cd extension
zip -qr "../$OUT" . -x '*.DS_Store' -x '__MACOSX/*'
cd ..

# Fail loudly rather than uploading something AMO will reject.
unzip -l "$OUT" | grep -q ' manifest.json$' || {
  echo "manifest.json is not at the root of $OUT" >&2
  exit 1
}

# Mozilla's own linter, run here rather than discovered on upload.
if [ -x node_modules/.bin/addons-linter ]; then
  node_modules/.bin/addons-linter "$OUT"
elif command -v npx >/dev/null 2>&1; then
  npx --yes addons-linter "$OUT"
else
  echo "addons-linter not available; skipping validation" >&2
fi

echo "$OUT"
unzip -l "$OUT" | tail -1
