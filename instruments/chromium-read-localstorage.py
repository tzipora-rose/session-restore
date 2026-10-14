# Copyright (C) 2026 tzipora-rose
#
# This file is part of session-restore.
#
# session-restore is free software: you can redistribute it and/or modify it under the
# terms of the GNU Affero General Public License, version 3, as published by
# the Free Software Foundation.
#
# session-restore is distributed in the hope that it will be useful, but WITHOUT ANY
# WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS
# FOR A PARTICULAR PURPOSE. See the GNU Affero General Public License for
# more details.
#
# You should have received a copy of the GNU Affero General Public License
# along with session-restore. If not, see <https://www.gnu.org/licenses/>.
#
# SPDX-License-Identifier: AGPL-3.0-only

"""Read-only probe: open a COPY of a Local Storage leveldb folder in Playwright's Chromium and
read localStorage values for https://claude.ai through Chromium itself. No network: every
request is answered locally or aborted.

Usage: python chromium-check.py <leveldb folder copy> <scratch profile dir> <key> [<key> ...]
"""
import json
import shutil
import sys
from pathlib import Path

from playwright.sync_api import sync_playwright

leveldb_src = Path(sys.argv[1])
profile = Path(sys.argv[2])
keys = sys.argv[3:]

target = profile / "Default" / "Local Storage" / "leveldb"
if profile.exists():
    raise SystemExit(f"profile dir already exists, refusing to reuse it: {profile}")
target.parent.mkdir(parents=True)
shutil.copytree(leveldb_src, target)

STUB = "<!doctype html><title>stub</title>"


def handle(route):
    if route.request.url.startswith("https://claude.ai/"):
        route.fulfill(status=200, content_type="text/html", body=STUB)
    else:
        route.abort()


with sync_playwright() as p:
    ctx = p.chromium.launch_persistent_context(
        str(profile),
        headless=True,
        args=["--disable-background-networking", "--disable-component-update", "--no-first-run"],
    )
    ctx.route("**/*", handle)
    page = ctx.new_page()
    page.goto("https://claude.ai/")
    result = page.evaluate("""(keys) => {
        const out = { count: localStorage.length };
        for (const k of keys) { const v = localStorage.getItem(k); out[k] = v === null ? null : { length: v.length, head: v.slice(0, 90) }; }
        const store = localStorage.getItem('dframe-store');
        if (store) { try { out.scopeKeys = Object.keys(JSON.parse(store).state.customGroupsByScope || {}); } catch (e) { out.parseError = String(e); } }
        return out;
    }""", keys)
    ctx.close()

print(json.dumps(result, indent=1))
leftover = list(target.iterdir())
print("files in the Chromium copy after closing:", sorted(f.name for f in leftover))
