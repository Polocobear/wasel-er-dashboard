#!/bin/sh
# Inline the shell + JS modules into one self-contained HTML file.
set -e
cd "$(dirname "$0")"
python3 -I - <<'PY'
import pathlib
src = pathlib.Path('src')
files = [f for f in ['00-core.js', '10-engine.js', '15-wasel.js', '16-readiness.js', '20-ai.js', '30-ui.js', '40-bridge.js', '50-viz.js'] if (src / f).exists()]
js = '\n\n'.join((src / f).read_text() for f in files)
shell = (src / 'shell.html').read_text()
assert shell.count('/*__SCRIPT__*/') == 1, 'shell must contain exactly one /*__SCRIPT__*/ placeholder'
assert '</script' not in js.lower(), 'JS must not contain a closing script tag'
html = shell.replace('/*__SCRIPT__*/', js)
pathlib.Path('er-command-center.html').write_text(html)
pathlib.Path('index.html').write_text(html)  # Cloudflare Pages serves index.html at /
print('built er-command-center.html', len(shell) + len(js), 'bytes')
PY
