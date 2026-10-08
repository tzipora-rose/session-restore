# session-restore — every local conversation in the sidebar, and one account's groups, pins and chat folders on another

One script, `session-restore.ps1`, for the Claude desktop app on Windows. It does four things:

1. **Chats.** It synthesizes a sidebar index entry for every chat on disk that the signed-in
   account's sidebar does not list. Transcripts are account-agnostic while the index
   is per-account, so the net effect is **consolidation**: the entire on-disk chat corpus —
   whichever account created each conversation — gathers under whichever account is signed in
   now. Its natural moment is right after an **account switch** (the sidebar empties because the
   index is account-scoped); it also resurrects chats lost to an app reinstall or sidebar aging.
   Each entry it creates is modelled on the same chat's entry in another account: its dates,
   folder, title, model, effort, archived state and earlier transcripts. A chat no other account
   lists is built from its transcript. A chat's earlier transcripts get no entry of their own.
2. **Folders.** If `session-restore.config.json` names an account in `copyGroupsFromEmail`, each
   chat the signed-in account already lists goes in the folder its twin in that account names.
3. **Groups and pins.** For the same account, it works out what has to change so that the
   signed-in account's custom sidebar groups and pinned chats are an **exact copy** of that
   account's, and saves that as a plan. It writes no group and no pin itself. The app does,
   through its own sidebar tools, called by a Claude session in the app: `-Sidebar` lists the
   calls that are left, and the session makes them.
4. **Export and import.** It writes an account's groups and pinned chats to a file of their own,
   and turns such a file back into a plan that makes the signed-in account's groups and pins the
   file's, under the same account or another one. The plan is applied the same way, by a
   Claude session with `-Sidebar`.

## Getting started

- **What it needs:** Windows, the Claude desktop app, and Windows PowerShell 5.1, which comes
  with Windows 10 and 11. The test instruments also need Node.js.
- **Where it goes:** anywhere. Every path the script uses is derived from its own folder, the
  user profile, or the config, so the folder can be moved or renamed.
- **Its settings:** copy `session-restore.config.example.json` to `session-restore.config.json`
  beside the script, and fill it in (below). Without it, the script brings back chats and plans
  no groups.
- **Running it:** from its folder, `powershell -ExecutionPolicy Bypass -File .\session-restore.ps1`
  with the switches below; `-DryRun` first shows what a run would do.
- It works with the files the Claude desktop app keeps, whose form Anthropic can change with any
  update; it was checked against the versions named under "How it was verified". It is not made
  by Anthropic.
- The test instruments are in `instruments\`; their `README.md` holds the test loop.

## Why this exists (the mechanics)

The app is MSIX/Store-packaged, so its real data store is
`AppData\Local\Packages\Claude_<suffix>\LocalCache\Roaming\Claude\` — a normal console cannot
follow the `AppData\Roaming\Claude` alias the app presents. Inside that store:

- **Transcripts** (the conversations themselves) live under `~\.claude\projects\<project>\*.jsonl`
  and are **account-agnostic** — they survive account switches untouched.
- **The sidebar index** is per-account: `claude-code-sessions\<accountUuid>\<orgUuid>\*.json`,
  one small JSON per listed conversation, each naming its transcript in `cliSessionId`. The
  sidebar shows ONLY conversations with an entry under the CURRENT account+org.
- **Groups and pins name conversations by their index entry id** (`local_<guid>`), which differs
  between accounts. That is why neither carries over a switch: each chat is matched to its twin
  in the other account through the transcript both entries point at.

### Why the groups and pins are left to the app

The app keeps groups in three places and pins in five, across its settings file, its browser
storage and its IndexedDB, and syncs the list of groups with its server. Until 2026-10-08 this
script wrote all of those itself. It no longer does: the app has tools of its own for the
sidebar (`mcp__ccd_sidebar__*`: `list_groups`, `create_group`, `move_sessions`, `set_pinned`,
`delete_group`), which it gives to the Claude sessions it runs, and a change made through them
is the app's own change, saved and synced by the app. No other program can call those tools, so
this half of a switch needs a Claude session in the app. The script does everything else: it
reads what the source account's groups and pins are, matches every chat, and lists the exact
calls, so the session only has to make them.

### What the script reads of the app's data

| what | where | used for |
|---|---|---|
| the sidebar's own saved state | browser storage key `dframe-store` → `state.customGroupsByScope`, per `"<accountUuid>/<orgUuid>"` | the source account's groups, and the signed-in account's groups before a run. Read through a private copy of the `Local Storage\leveldb` folder |
| the saved form of the groups | `claude_desktop_config.json` → `preferences.epitaxyPrefs["dframe-group-scopes"]` | the same, when the saved state does not hold the account; and, in `-Sidebar`, the signed-in account's groups as they are now. The app rewrites it within a second of a change. A group with no chats is not in it |
| the pin list | `claude_desktop_config.json` → `preferences.epitaxyPrefs["starred-local-code-sessions"]` | pins. It is **one list for all accounts**: each account's sidebar shows the entries in it that belong to that account |
| the chat entries | `claude-code-sessions\<accountUuid>\<orgUuid>\local_*.json` | which transcript each entry resumes, its folder, its title, whether it is archived |

It writes none of these but the chat entries: new ones, and the folder of existing ones.

Checked against the desktop app 2.26454.2.0 on 2026-10-08. The web interface is downloaded, not
shipped, and changes often; if it ever saves groups differently, the script says it does not
know the shape and plans nothing, rather than guess.

### Where the app keeps a chat's folder

Each entry names the folder its chat runs in, in `cwd` and `originCwd`, and the sidebar lists
chats under that folder. Claude Code keeps the transcripts of chats run in a folder in the
project folder named after it: every character other than an ASCII letter or digit becomes `-`
(`C:\` gives `C--`), and a name over 200 characters is cut to 200 and followed by a hash. So an
entry and its transcript have to agree:

- when an entry names a folder whose project folder lacks the transcript, the app copies the
  transcript there when the chat is opened, which leaves two copies of it;
- when an entry names a folder that no longer exists, the app cannot start the chat there: it
  records a `cwd_not_found` error and refuses new messages, saying the project folder no longer
  exists.

A transcript records the folder its chat began in, which may since have moved or gone, so the
script never takes a folder from a transcript without checking that it exists.

## The two steps of a switch

1. Sign in, in the app, to the account that should **receive** the chats, groups and pins.
2. Fully quit Claude, including from the system tray, and run the script (`-DryRun` first shows
   what it will do). It creates the chat entries, moves chats to their twin's folder, and saves
   the plan for the groups and pins.
3. Reopen Claude and give any session the line the script printed. The session runs
   `-Sidebar`, makes the calls it lists with the app's sidebar tools, and runs it again until
   it says the sidebar matches the plan.

Before signing out of the account the groups come from, `-Sidebar` can be run once there: it
saves a list of that account's groups and pinned chats, which a later run falls back on if the
app's own files no longer show the groups. It reads the saved list back and ends by saying what
it holds and where (`Saved for a switch: the groups and pins of ...`), or that the list could
not be saved and why (`NOT saved for a switch: ...`), in which case the list saved before is as
it was. Under the account `copyGroupsFromEmail` names, it adds that a run under another account
copies these groups and pins. A run without `-Sidebar` under that account saves the list and
says the same. The list always follows what the app shows: when the app shows no group for the
account, the list says so too. To keep a copy that does not change, export it (below).

## Export and import

```
.\session-restore.ps1 -Export
.\session-restore.ps1 -ExportTo <file>
.\session-restore.ps1 -Import <file>
```

- **`-Export`** writes the signed-in account's groups and pinned chats, as the app's settings
  file holds them now, each chat by its transcript, to a new file in the `exports\` folder of the
  tool's data folder, named with the account's email and the time. **`-ExportTo <file>`** writes
  to the file you name instead, in a folder that exists; a relative path is taken from the
  folder the command runs in. An export never replaces a file. It reads the file back, says
  what it holds, and prints the command that imports it. It works with Claude open or closed:
  it reads plain files only.
- **`-Import <file>`** takes a file `-Export` wrote, or a list the script saved
  (`sidebar-list-<account>.json`), and saves a plan that makes the signed-in account's groups
  and pins those of the file, chat for chat, matched by transcript, under the account the file
  came from or another one. A Claude session applies it with `-Sidebar`, as after a switch;
  `-Sidebar -Back` lists the calls back, and `-Undo` turns the plan around. It changes nothing
  in the app itself and replaces the saved plan, as a run does.

What an import copies follows the exact copy below, with the file as the source: groups the
file lacks are deleted once their chats are out of them, and chats the file does not pin are
unpinned. Chats created after the file was saved are left as they are. A group none of whose
chats has an entry here is left out; when none of the file's groups can be filed here, the
groups here are left alone. A list saved before lists kept pins leaves the pins alone. An import
refuses a file that is not there, a file that is not such a list, and a list that names one
group twice.

**Why an import makes a plan rather than putting the file back as the saved list:** a run reads
the source account's groups from the app's own storage first, and falls back on the saved list
only when the app holds nothing at all for that account. If the groups were deleted in the app,
or come back empty after a reinstall, the app still holds the account, and a file put back as
the saved list would never be read. (That a reinstall brings the groups back empty is read from
the app's code of 2026-10-01, not tried: its server keeps the list of groups, but not which local
chats are in them.)

### For the Claude session that applies the plan

Run `-Sidebar`. It prints the calls that are left, one per line, as a tool of
`mcp__ccd_sidebar__` and its input, in the order to make them:

- `create_group {"name": ...}` — call `list_groups` first and skip the call when a group of
  exactly that name is already there (a group that holds no chat yet is not visible to the
  script);
- `move_sessions {"group": <name or null>, "session_ids": [...]}` — pass the group's id from
  `list_groups` as `group_id`; `null` means `group_id` null, which is Ungrouped;
- `delete_group {"group": <name>}` — by then its chats are out of it; deleting a group never
  deletes a chat;
- `set_pinned {"session_id": ..., "pinned": true|false}`.

Make the calls in the order given: filing a pinned chat in a group unpins it, so the pins come
last. Then run `-Sidebar` again. It lists whatever is still left, or says the sidebar matches
the plan. In the app's default permission mode, the app asks the user to approve each call that
changes another session.

The same calls are written as JSON to `sidebar-calls.json` in the tool's data folder; its path
is printed after them. If `list_groups` answers that the groups are not known yet, the app's
window has not reported them: call it again a moment later.

## What an exact copy means

- **Groups:** this account has a group for each of the source account's groups that holds a
  chat, under the same name; each chat is filed in the group its twin is in; chats the source
  account has not grouped end up ungrouped; a group here that the source lacks is deleted once
  its chats are out of it.
- **Pins:** this account's pins become the twins of the source account's pins. Its own pins
  that the source has not pinned are unpinned. The source account's pins, and any other
  account's, are not touched.
- **Folders:** each chat goes in the folder its twin names, when that folder exists and holds the
  chat's transcript. Otherwise it stays where it is, and the script names it and says why: the
  folder does not exist; the transcript is not stored for it; a copy of the transcript stored
  elsewhere holds messages the one stored there lacks, so the app would show the older copy; the
  source account's entries for the chat name different folders; or the chat runs in a worktree.

What the app's tools do not do, and so is not copied:

- the order of the groups, of the pins, and of the chats inside a group. A group the calls
  create goes after the groups already there;
- an archived chat, or a routine's run: the tools refuse both;
- a group that holds no chat.

Group ids differ between accounts; the names are the same. A chat created after the plan was
made is left as it is, filed or pinned or not: it did not exist when the copy was taken.

A grouped or pinned chat whose transcript is gone from this computer cannot be matched, and the
script says how many.

## Configuration — `session-restore.config.json`, beside the script

```json
{
  "copyGroupsFromEmail": "you@example.com",
  "autoUpdateCopyGroupsFromEmail": 0,
  "titleSkipPrefixes": [
    "The opening words of text your own setup injects into a first message"
  ]
}
```

- `copyGroupsFromEmail` — the account whose groups, pins and folders are the template for
  whichever account is signed in when the script runs, and whose entries date and place new
  entries first. Its email, or its account id (the name of its folder under
  `claude-code-sessions`) for an account whose email the script has never seen. Leave it out to
  skip the copy. Run under that account itself, the script copies nothing.
- `autoUpdateCopyGroupsFromEmail` — `0` or `1`. With `1`, at the end of each run the script
  writes the account signed in for that run into `copyGroupsFromEmail`, so that the next run,
  under another account, copies from the account just left. With `0`, or left out, the script
  never changes `copyGroupsFromEmail`.
- `titleSkipPrefixes` — openings of injected text that should never become a chat's title, on top
  of the built-in Claude Code boilerplate. Plain text, matched at the start, ignoring case.

The file holds personal details, so keep it out of any copy of this folder you publish.

**How an email is matched to an account.** Claude Code writes the signed-in account's email, id
and org to `.claude.json` in the user profile, and keeps backups of that file. The script reads
those and remembers every account it has seen in `known-accounts.json` (below), so an account
stays recognisable after you switch away from it. `.claude.json` does not follow every account
switch in the app: it can name one account while the app is signed in to another. If the value
is neither an email the script has seen nor the id of an account folder, it says so and plans
nothing.

## Commands

Preview (writes nothing):

```
.\session-restore.ps1 -DryRun
```

Do it, with Claude fully quit:

```
.\session-restore.ps1
```

With Claude open again, the calls left for the app's sidebar tools; and, run again, the check:

```
.\session-restore.ps1 -Sidebar
```

The same, aiming at the groups and pins as they were before the run:

```
.\session-restore.ps1 -Sidebar -Back
```

Undo the most recent not-yet-undone run (repeat to walk further back, run by run):

```
.\session-restore.ps1 -Undo
```

Export the signed-in account's groups and pinned chats; to a file you name; import a file
(see "Export and import"):

```
.\session-restore.ps1 -Export
.\session-restore.ps1 -ExportTo <file>
.\session-restore.ps1 -Import <file>
```

Optional: `-UserProfile <path>` overrides the profile root (testing / another user).

`-Sidebar` changes nothing in the app's data: it reads the plan, the app's settings file and
this account's chat entries, and takes a few seconds. In the tool's own data folder it writes
the calls it listed and the list of this account's groups and pinned chats, and its last lines
say what that list holds, or why it could not be saved. Once the sidebar has matched the
plan, it marks the plan applied; a later `-Sidebar` still lists any difference, and says the
plan had been applied, since chats filed or pinned afterwards differ from it by design.

## What the chat step does

1. **Auto-detects everything — no hardcoded IDs:** the package folder (`Claude_*` containing
   `claude-code-sessions`), the current account (`config.json` → `lastKnownAccountUuid`, falling
   back to the most recently written account folder), and that account's org. The org comes from,
   in order: the sidebar's own record of the account it last showed; Claude Code's account file,
   when it names the same account; the org folder holding the newest sidebar entry; the most
   recently written org folder. (An account switch can leave a stray org folder holding nothing
   but `scheduled-tasks.json`, which is why "most recently written" comes last.)
2. **Scans** every top-level `*.jsonl` transcript under `~\.claude\projects\<project>\`
   (subagent/workflow transcripts live deeper and are deliberately not scanned). A transcript
   stored in more than one project folder counts once. It skips:
   - every chat this account+org already lists, matched by the transcript its entry resumes
     (`cliSessionId`, else `unarchivedCliSessionId`);
   - every transcript that an entry, in any account, keeps as another part of its chat
     (`priorCliSessionIds` and `preClearCliSessionId`, where the app records a chat's earlier
     transcripts when the chat is rewound or cleared). These are not chats of their own; the
     output says how many were left out.
3. **Finds the chat's twin**: the same chat's entry in another account (in the account
   `copyGroupsFromEmail` names first, else the most recently active). The new entry takes from
   it what steps 4 to 8 name; a chat no other account lists is built from its transcript.
4. **Title.** The twin's. Else a title derived from the transcript's first 250 records — a
   four-tier ladder, last seen wins within a tier: the `custom-title` (a rename) > the app's own
   `ai-title` > the first REAL user message (every text block of a user record is considered;
   injected boilerplate is skipped: continuation summaries, summary-request prompts, `<`/`[`-led
   wrapper lines, anything mentioning system-reminder, plus the config's `titleSkipPrefixes`) >
   a dated fallback (`Chat YYYY-MM-DD`), whitespace-collapsed and capped at 100 characters.
5. **Model and effort.** The twin's. Else the model is read from the transcript itself — the
   LAST logged model wins, read through an adaptive tail window (256 KB, widening ×4 until a
   match or the whole file); old-format transcripts never log it → fallback `claude-opus-4-8` —
   and the effort, which is logged nowhere, is `"high"`.
6. **Dates.** The twin's `createdAt`, `lastActivityAt` and `lastFocusedAt`, so the chat sorts the
   same way there and here. A chat no other account has is dated from its transcript: created
   when its file was (the earliest copy's creation time), last active at its last record that
   carries a timestamp (else at the file's last write). A file's last write time alone is not a
   chat's last activity: something other than the chat can rewrite a transcript after its last
   message.
7. **Folder.** The folder its twin names, when that folder exists and holds the transcript; else
   the folder the transcript is stored for, learned from the folders the entries of every
   account name; else the folder the transcript records, if it exists; else the drive root. The
   output counts which rule placed how many.
8. **Archived state and earlier transcripts.** A chat archived in its twin's account is created
   archived. The twin's `priorCliSessionIds`, `preClearCliSessionId`, `rewindEdges` and
   `transcriptModelStates` are copied, so the chat keeps the step back to its earlier branches.
   If this account already lists one of those earlier transcripts as a chat of its own, the
   script says so and leaves that entry as it is.
9. **Writes one new index entry** per chat (`local_<guid>.json`), in the app's default
   permission mode. Choosing another mode for a chat is done in the app.

Every read of a file the app or Claude Code may be writing lets it keep writing: transcripts,
chat entries and the app's settings file are opened so that another program can still append
to them and replace them.

## Safety model

- **Chat entries** are new files only; nothing is overwritten and no transcript is touched. Each
  run lists what it created in its own `created-entries-<stamp>.txt` beside the script. (A legacy
  `created-entries.txt` from the single-manifest version is honored as the oldest undo step.)
- **The script never writes into the app's settings file, its browser storage or its IndexedDB.**
  It reads the browser storage through a private copy of the folder.
- **Folders** are written only while the app is fully closed, since the app rewrites its chat
  entries while it runs: the script checks for the package's running processes and for the lock
  file of the browser storage, and says so when it leaves the folders alone. The chat entries
  and the plan are made either way.
- **Backups first.** Before it moves a chat to another folder, and before it fills in the
  config's account, it copies the file to `.session-restore\backups\<stamp>\` in the user
  profile and checks the copy's SHA-256 against the original.
- **Read-back check, automatic rollback.** After moving chats it reads every entry back; if one
  differs from what it meant to write, or anything but its folder changed, it puts all the
  backed-up entries back and says so.
- **The plan holds the groups and pins as they were.** `-Sidebar -Back` lists the calls that
  put them back. Those calls are the app's own, like the calls that applied the plan.
- **`-Undo`** reverses the newest run: it deletes that run's new entries, puts the backed-up
  files back exactly as they were (checked by SHA-256), and turns the run's plan around, so that
  `-Sidebar` then lists the calls back to the groups and pins as they were. It needs the app
  closed when the run moved chats to another folder.
- The app reads chat entries at start-up: **reopen it** to see new chats and moved ones.

## Files

- `session-restore.ps1` — the tool (usage in its header comment).
- `lib\JsJson.ps1` — reads and writes JSON the way JavaScript's `JSON.stringify` writes it, so
  unchanged parts of a file are written back byte for byte (Windows PowerShell's own JSON
  commands reject keys that differ only in letter case and reformat everything).
- `lib\ChromiumLocalStorage.ps1` — reads values from Chromium's LevelDB browser storage (log,
  table and manifest formats, Snappy decompression). It only reads.
- `lib\Transcripts.ps1` — the project folder a working folder's transcripts are stored in (the
  app's naming rule), a transcript's first lines, the time of its last timestamped record, and
  whether one copy of a transcript holds messages another copy lacks. Each read opens the file
  so that Claude Code can keep appending to it, and closes it before returning.
- `session-restore.config.json` — your settings (personal).
- `created-entries-<stamp>.txt` — one manifest per run (the chat side of the `-Undo` stack).

Per-user data, kept outside this folder in `.session-restore\`, directly under the user
profile. It is not under `AppData`, because the desktop app is a packaged app: what a program
started inside it creates under `AppData`, such as a Claude session's shell running `-Sidebar`,
is stored in the app's package folder, where a console outside the app does not see it. A run
and `-Sidebar` have to see the same files.

- `known-accounts.json` — each account seen: email, account id, org id, when last seen.
- `sidebar-plan.json` — the newest plan, of a run or of an import: the receiving and the source
  account, the groups and pins to reach, and the groups and pins as they were, by chat entry id.
- `sidebar-calls.json` — the calls the last `-Sidebar` listed.
- `sidebar-list-<accountUuid>.json` — an account's groups and pinned chats, each chat by its
  transcript, saved whenever the script runs under that account. A new list is written beside
  the old one and read back before it replaces it, so a save that fails leaves the old one as it
  was. Lists saved before 2026-10-08 hold no pins.
- `exports\` — the files `-Export` writes, `groups-<email>-<stamp>.json`, in the same form as the
  saved lists. Nothing removes them; they are yours to keep or delete.
- `backups\<stamp>\` — the copies described above and `backup.json` (paths and SHA-256 hashes),
  one folder per run that moved a chat or filled in the config; `-Undo` retires it.

## How it was verified

The plan and the calls were checked on 2026-10-08, on copied profiles, against the desktop app
2.26454.2.0, by scripts that share no code with this one:

- **The plan.** For a copied profile signed in as one account with the other as the source, an
  independent script read the source's groups from the copied browser storage with its own
  LevelDB reader, matched every chat by transcript, and confirmed the plan: the source's groups
  in order, each with exactly this account's entries for its chats; the pins; and this account's
  own groups and pins as they were. The same for a source read from the settings file, from the
  saved list, and named by account id with no email known. Eight deliberate faults in a plan
  were each caught by the checks meant to catch them, and by no other.
- **The calls.** The app's tools exist only inside the app, so on a copied profile a stand-in
  made the listed calls in the copied settings file, the way the app had been seen to make them
  the same day (a new group after the existing ones; a moved chat at the end of its group;
  filing a pinned chat unpins it). After the calls, `-Sidebar` said the sidebar matched, and an
  independent script confirmed that the account's groups and pins were the plan's, that every
  other account's pins were as before, and that nothing else in the settings file had changed;
  five deliberate faults were each caught by one check alone. The same back to the state before
  the run. A call left unmade was listed again by the next `-Sidebar`.
- **The calls, case by case.** Eleven cases, seventeen checks, with hand-written expectations: an empty sidebar,
  groups that exist, an archived chat, a group the plan lacks, a chat made after the plan, a
  pinned chat that is filed, more than 100 chats, a part of the plan left out, two groups of one
  name, a sidebar that matches, a plan for another account, no plan. Four deliberate faults
  made in a copy of the script were each caught by the case meant to catch them.
- **The tools themselves** were tried on the real sidebar with one chat and a throwaway group:
  creating, filing, pinning, the unpin on filing, unpinning, deleting.
- **The run.** Entries, dates, folders, titles and the rest as before, checked by the
  independent script used since 2026-10-04. `-Undo` restored every file byte for byte, the
  config file included, after each run.
- **Reads.** `Read-TextFile` was shown to read a file another handle has open for writing, with
  a control that cannot; and to leave the file free to be replaced.
- **Where the tool's own files land.** On 2026-10-08, a file created under `AppData\Local` by a
  shell inside the app was stored in the app's package folder, and one created in a folder
  directly under the user profile was stored at the path itself, by Windows' own report of each
  open file's final path. That is why the data folder is where it is.
- **What is said about the saved list** (2026-10-08, desktop app 2.26454.2.0, copied profiles).
  Signed in as the account the groups come from, with a plan made for the other account and with
  no plan, and signed in as the receiving account, `-Sidebar` ended by naming the groups it saved
  and where, and an independent script found the list file holding exactly the groups of the
  settings file, in order; with the list's groups taken out of order, or one chat taken out, that
  script failed. With the settings file unreadable, with the old list made read-only, and with a
  fault in a copy of the script that wrote a list other than the one it meant, `-Sidebar` said
  NOT saved and why, and the old list was byte for byte as it was. With no group of the account
  in the settings file, it said the list now holds none. A run under the account the groups come
  from said the same, and `-Undo` then left the copied profile as it was built.
- **Export and import** (2026-10-08, desktop app 2.26454.2.0, copied profiles). An export, with
  no file named and to a file named, held exactly the account's groups and pinned chats, by an
  independent script; an export to a file that exists, to a folder that does not, and with an
  empty file name was refused, and so was an empty `-Import`, neither falling through to a run.
  With an account's groups and pins removed from the copied settings file, its export imported
  under the same account gave a plan an independent script confirmed; after the stand-in made
  the calls, `-Sidebar` said the sidebar matched, the settings file held exactly the plan's
  groups and pins and nothing else changed, and a new export held exactly what the first one
  did. The same export imported under the other account, and `-Sidebar -Back` back to the state
  before, checked the same way. A chat created after the file was saved, filed in a group and
  pinned, stayed filed and pinned. A file that is not there, a file that is not a list, and a
  list naming one group twice were refused, the plan left as it was; a list saved before lists
  kept pins left the pins alone; `-Undo` turned an import's plan around and undid no run. Six
  deliberate faults in an import's plan and one in an export were each caught. A run after a
  switch, and the eleven cases of the calls, behaved as before.

The chat step as it is (earlier transcripts left out; title, model, effort, archived state
and earlier transcripts taken from the twin; shared transcript reads) was checked on 2026-10-04
on copied profiles signed in as each of two accounts in turn, against the desktop app
2.19675.0.0, and its first real run was on 2026-10-05.

## License

Copyright (C) 2026 tzipora-rose

session-restore is free software: you can redistribute it and/or modify it under the terms of
the GNU General Public License, version 3, as published by the Free Software Foundation. It is
distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the
implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the GNU General
Public License in `LICENSE` for more details.
