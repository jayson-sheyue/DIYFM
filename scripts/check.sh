#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
if [ -n "${DIYFM_PYTHON:-}" ]; then
    task_python="$DIYFM_PYTHON"
elif [ -x .venv/bin/python ]; then
    task_python=.venv/bin/python
else
    task_python=python3
fi
export PYTHONPYCACHEPREFIX="${PYTHONPYCACHEPREFIX:-/tmp/diyfm-pycache}"
"$task_python" -m unittest discover -s tests
node --check static/app.js
for task_module in static/*.mjs; do node --check "$task_module"; done
npm test
"$task_python" -m py_compile app.py broadcast.py harness.py llm.py store.py preview_cache.py fm_synth.py settings.py
