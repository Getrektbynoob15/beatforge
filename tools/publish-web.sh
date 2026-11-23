#!/usr/bin/env bash
# Copy the app to the website's browser version (~/mainwebsite/beatforge-web) and add ?v=<version> to every
# script/style link in its index.html: the site caches these files for a year, so a new version needs new URLs.
set -euo pipefail
cd "$(dirname "$0")/.."
VER=$(node -p "require('./desktop/package.json').version")
DEST="$HOME/mainwebsite/beatforge-web"
rsync -a --delete --exclude dist --exclude .git --exclude node_modules --exclude desktop --exclude tools --exclude build.sh --exclude '*.pem' ./ "$DEST/"
python3 - "$DEST/index.html" "$VER" <<'PY'
import re, sys
p, ver = sys.argv[1], sys.argv[2]
s = open(p).read()
s2, n = re.subn(r'((?:src|href)="(?:js/[^"?]+\.js|app\.js|style\.css))"', lambda m: f'{m.group(1)}?v={ver}"', s)
open(p, 'w').write(s2)
print(f"beatforge-web {ver}: versioned {n} links")
PY
