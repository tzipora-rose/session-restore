// Copyright (C) 2026 tzipora-rose
//
// This file is part of session-restore.
//
// session-restore is free software: you can redistribute it and/or modify it under the
// terms of the GNU Affero General Public License, version 3, as published by
// the Free Software Foundation.
//
// session-restore is distributed in the hope that it will be useful, but WITHOUT ANY
// WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS
// FOR A PARTICULAR PURPOSE. See the GNU Affero General Public License for
// more details.
//
// You should have received a copy of the GNU Affero General Public License
// along with session-restore. If not, see <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-only

// The desktop app's rule for which chats its sidebar shows under another, written here from the
// app's code (desktop app 2.37337.1.0) for the instruments; it shares no code with the script.
//   lineageOf(entry)   what the app's main process makes of an entry's link fields each time it
//                      loads the entry: the parent's entry id, and whether the app looks past an
//                      archived parent (side sessions and hand-offs; the others only where a switch
//                      of Anthropic's is on, taken here to be off). None once lineageDetached is set.
//   families(entries)  the web interface's map of each chat shown under another to the chat at the
//                      top of its family: a chat goes under its parent when the parent is listed
//                      and is not archived while the chat is not; a side session or a hand-off
//                      whose parent is archived goes under the nearest chat above it that is not.
//                      A chat whose projectThreadStarted is true is in no family.
// The app moves a family only whole: move_sessions refuses a chat under another unless the chat
// at the top of its family is named in the same call. A move files the chat at the top by its own
// key alone (nm in shared-16, whose family set Pi holds only the cloud rows under it); the chats
// under it show under it wherever it goes, whatever keys of their own they hold, and one named
// with its top loses its own key. Only the chat named, and the chat at the top when it moves, are
// unpinned by a move into a group.
'use strict';

function lineageOf(e) {
  if (e.lineageDetached) return null;
  const spawned = e.spawnedFrom && e.spawnedFrom.sessionId !== e.sessionId ? e.spawnedFrom : undefined;
  const fork = e.forkedFromSessionId === e.sessionId ? undefined : e.forkedFromSessionId;
  if (spawned && spawned.sideSession && !spawned.userFork &&
      (fork === undefined || fork === spawned.sessionId || fork === (spawned.deletedParent && spawned.deletedParent.sessionId))) {
    return { parent: spawned.sessionId, attaches: true };
  }
  if (fork !== undefined) return { parent: fork, attaches: false };
  if (spawned) return { parent: spawned.sessionId, attaches: false };
  return null;
}

// entries: [{ id, e }] for one account's org folder; gives Map child id -> id at the top
function families(entries) {
  const listed = new Map();
  for (const x of entries) if (x.e && x.e.projectThreadStarted !== true) listed.set(x.id, x.e);
  const archived = id => listed.get(id).isArchived === true;
  const parentFor = (id) => {
    const e = listed.get(id), l = lineageOf(e);
    if (!l) return undefined;
    if (!l.attaches || e.isArchived) return l.parent;
    const seen = new Set([id]);
    let at = l.parent;
    for (let k = 0; k < 32; k++) {
      if (!listed.has(at) || seen.has(at)) return l.parent;
      if (!archived(at)) return at;
      seen.add(at);
      const up = lineageOf(listed.get(at));
      if (!up || !up.attaches) return l.parent;
      at = up.parent;
    }
    return l.parent;
  };
  const under = id => {
    const p = parentFor(id);
    if (p === undefined || !listed.has(p) || p === id) return undefined;
    if (archived(p) && !archived(id)) return undefined;
    return p;
  };
  const top = new Map();
  for (const id of listed.keys()) {
    let t = under(id);
    if (t === undefined) continue;
    const seen = new Set([id, t]);
    for (let n = under(t); n !== undefined && !seen.has(n); n = under(t)) { t = n; seen.add(n); }
    top.set(id, t);
  }
  return top;
}

module.exports = { lineageOf, families };
