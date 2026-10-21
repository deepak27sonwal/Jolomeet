#!/usr/bin/env python3
"""Stamp one version on every local stylesheet and script in the HTML pages.

GitHub Pages lets browsers keep files for 10 minutes, so right after a deploy a
phone could mix new and old files (for example a new js/chat.js with an old
js/api.js). Run this before each commit that changes CSS or JS:

    python3 scripts/stamp-version.py            # version = current UTC time
    python3 scripts/stamp-version.py 20261022a  # or pick one

It sets ?v=<version> on css/*.css and js/*.js links in every page and writes
an import map, so modules imported by other modules (./api.js, ./app.js, ...)
load the same version too.
"""
import json
import re
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
version = sys.argv[1] if len(sys.argv) > 1 else time.strftime('%Y%m%d%H%M', time.gmtime())

modules = sorted(p.name for p in (ROOT / 'js').glob('*.js'))
import_map = {'imports': {f'./js/{name}': f'./js/{name}?v={version}' for name in modules}}
map_tag = ('<script type="importmap">' + json.dumps(import_map, separators=(',', ':')) + '</script>')

for page in sorted(ROOT.glob('*.html')):
    html = page.read_text()
    # local css/js links: href="css/x.css" / src="js/x.js", with or without an old ?v=
    html = re.sub(r'((?:href|src)="(?:css|js)/[\w.-]+\.(?:css|js))(?:\?v=[\w.-]*)?"', rf'\1?v={version}"', html)
    html = re.sub(r'\n\s*<script type="importmap">.*?</script>', '', html)
    # the import map must come before the first module script
    html = re.sub(r'(\n(\s*)<script type="module")', rf'\n\2{map_tag}\1', html, count=1)
    page.write_text(html)
    print(f'{page.name}: v={version}')
