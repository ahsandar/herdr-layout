#!/usr/bin/env python3
"""The `bettr.context` label for an agent that has no hooks, read from what it already wrote.

Local addition. `report.py` is pushed events by agent hooks; Pi and opencode have no hook file and
nothing is installed into them, so the Context panel runs this instead, for the focused terminal:

    python3 -I pull.py <pi|opencode> <folder the agent runs in>

It prints the label's JSON (SCHEMA of mods/bettr-context) or nothing, and reads only: Pi's session
files, opencode's SQLite database and the model lists both already keep. No network, no new packages.
The newest session of the folder is taken, so two sessions in one folder show the later one.
"""
import hashlib
import importlib
from pathlib import Path
import sys
import time

HERE = Path(__file__).resolve().parent
if str(HERE) not in sys.path:  # `python3 -I` leaves this folder off sys.path.
    sys.path.insert(0, str(HERE))
sys.dont_write_bytecode = True

import context  # noqa: E402
from providers.common import dump  # noqa: E402
from report import forget_old, load, write_atomic  # noqa: E402

PROVIDERS = ("pi", "opencode")
CACHE = Path.home() / ".cache/bettr/pull"


def slot(folder, provider, key):
    return folder / (hashlib.sha256(f"{provider}:{key}".encode()).hexdigest() + ".json")


def pull_opencode(module, cwd, folder):
    """opencode has no file to follow, so the finished label is kept with the session's fingerprint
    and rebuilt only when a message or part changed."""
    file = slot(folder, "opencode", cwd)
    saved = load(file)
    saved = saved if isinstance(saved, dict) and isinstance(saved.get("label"), str) else {}
    built = module.build(cwd, saved.get("fingerprint"))
    if built is None:
        return None
    session, fingerprint, ops = built
    if ops is None:
        return saved["label"]
    state = context.fresh("opencode", session, str(module.database()))
    context.apply(state, ops, module)
    label = dump(context.summary(state, module))
    folder.mkdir(parents=True, exist_ok=True, mode=0o700)
    write_atomic(file, {"fingerprint": fingerprint, "label": label})
    forget_old(folder, time.time())  # Removes files unused for report.CACHE_DAYS.
    return label


def pull(provider, cwd, cache=None):
    """The label's JSON text for `cwd`, or None when the agent has no session there."""
    if provider not in PROVIDERS or not cwd:
        return None
    module = importlib.import_module(f"providers.{provider}")
    folder = cache or CACHE
    if provider == "opencode":
        return pull_opencode(module, cwd, folder)
    found = module.locate(cwd)
    if found is None:
        return None
    session, path = found
    # Pi's reader state (file offset and sums) is kept, so a poll reads only the new lines.
    file = slot(folder, provider, path)
    state = context.valid(load(file))
    if not state or state["sessionId"] != session or state["path"] != path:
        state = context.fresh(provider, session, path)
    if not context.read(state, path, module):
        return None
    folder.mkdir(parents=True, exist_ok=True, mode=0o700)
    state["label"] = dump(context.summary(state, module))
    write_atomic(file, state)
    forget_old(folder, time.time())  # Removes files unused for report.CACHE_DAYS.
    return state["label"]


if __name__ == "__main__":
    try:
        label = pull(sys.argv[1], sys.argv[2]) if len(sys.argv) == 3 else None
    except Exception as error:  # A panel poll must never print a traceback into the label.
        print(f"bettr-pull: {error}", file=sys.stderr)
        label = None
    if label:
        print(label)
