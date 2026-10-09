# session-restore test instruments

Instruments for testing `session-restore.ps1` and for investigating how the Claude desktop app
stores its sidebar: chat entries, custom groups and pinned chats. In the repository they sit in
`instruments\` beside the tool; they can live anywhere, since nothing here is registered and
every path they use is passed to them or derived.

These files carry no personal information. Account emails and ids are passed as parameters or
read from the machine when a tool runs; paths are derived from the user profile, the temp folder
or a tool's own location.

## The test loop

Every change to `session-restore.ps1` is proven here before it replaces the installed copy. Run
the version under test from a scratch copy of the whole tool folder (the script, `lib\` and
`session-restore.config.json`), never from the folder it is installed in: the script writes each
run's `created-entries-<stamp>.txt` beside itself, and a sandbox run's manifest in the installed
folder would become a step of the real `-Undo` stack. Use one scratch copy for one sandbox at a
time, for the same reason: `-Undo` takes the newest manifest beside the script.

The whole proof of a build runs with one command, which makes its own sandboxes and scratch
copies and removes them, and only reads the tool folder it is given:
`node prove-tool.js --tool <tool folder> --receiving <key> --source <key>`. The steps below are
what it does, for running one by hand.

1. Build a sandbox signed in as the account that should receive the chats, groups and pins:
   `.\new-sandbox.ps1 -Name <name> -SignedInEmail <email>`. It prints the sandbox's profile folder.
   Claude Code's account files name only the account it last ran under, so for the other account
   pass its id instead, the name of its folder under `claude-code-sessions`:
   `.\new-sandbox.ps1 -Name <name> -SignedInAccount <account uuid>`.
2. Preview, then run, the scratch copy against it:
   `& <copy>\session-restore.ps1 -DryRun -UserProfile <profile>`, then without `-DryRun`.
3. Check what the run wrote, independently of the script's own code. The two scope keys are
   `<accountUuid>/<orgUuid>`; the script prints the signed-in account's, and the folders under
   `claude-code-sessions` give both. The run's data is in `<profile>\.session-restore\`.
   `node verify-entries.js <profile> <copy>\created-entries-<stamp>.txt <receiving key> <source key> <sandbox>\fingerprints-at-build.json [<data>\backups\<stamp>]`
   `node verify-plan.js <profile> <data>\sidebar-plan.json <source key> <receiving key>`
   The backup folder exists only when the run moved a chat to another folder or filled in the
   config. A run that planned nothing (no account configured, or the configured one was the
   receiving one or could not be found) is checked with `verify-entries.js` alone, with
   `none/none` as the source key.
4. Make the calls. A sandbox has no running app, so `sidebar-sim.js` stands in for the app's
   sidebar tools. Keep a copy of the sandbox's `claude_desktop_config.json` first.
   `& <copy>\session-restore.ps1 -Sidebar -UserProfile <profile>` lists the calls;
   `node sidebar-sim.js <profile> <receiving key> <data>\sidebar-calls.json` makes them;
   `-Sidebar` again should say the sidebar matches the plan;
   `node verify-sidebar.js <profile> <data>\sidebar-plan.json desired <the copy of the settings file>`.
   The same with `-Sidebar -Back` and `before`.
5. Put the copy of the settings file back, undo, then compare with the build:
   `& <copy>\session-restore.ps1 -Undo -UserProfile <profile>`, then
   `.\new-sandbox.ps1 -Name <name> -Compare` (it should report 0 changed, 0 gone, 0 added).
6. Remove the sandbox: `.\new-sandbox.ps1 -Name <name> -Remove`.

A change to how `-Sidebar` works out its calls is also checked case by case:
`node check-sidebar-calls.js <copy> <profile> <receiving key>`. A change to how the list of an
account's groups and pins is saved is checked after `-Sidebar`, or a run, under that account:
`node verify-list.js <profile> <account key>`; an export with `--file <export>`. A change to
`-Import` is checked on the plan it saves:
`node verify-plan.js <profile> <data>\sidebar-plan.json <key of the file's account> <receiving key> --source-from file:<file>`.
A change to
`lib\Transcripts.ps1` is checked on its own: `node check-transcript-lib.js <copy>` and
`node check-shared-read.js <copy>`; a change to `Read-TextFile`:
`powershell -NoProfile -ExecutionPolicy Bypass -File check-shared-textread.ps1 -Tool <copy>`.

A checker that reports clean has only been shown to pass. Before trusting a new or changed one,
damage its input on purpose (in the sandbox, restoring the file afterwards) and see it fail on
exactly that; for `check-sidebar-calls.js`, make the fault in a throwaway copy of the script. A
sandbox's entries can also be edited before a run to stage a case the real data lacks; take the
fingerprints again afterwards, the way `new-sandbox.ps1` takes them, so `-Compare` and
`verify-entries.js` measure against the staged state.

The stand-in is only as true as what was seen of the app. Its header says what it models, when
that was seen, and what was read in the app's code instead. After an app update that changes
the sidebar tools, try the tools on the real sidebar again, with one chat and a throwaway group,
before trusting it.

## The tools

- `prove-tool.js` — the proof of a build of the tool, in named passes: `static` (the `.ps1`
  files parse in Windows PowerShell 5.1 and are ASCII; the shared reads and
  `lib\Transcripts.ps1`), `run` (a run, its entries and plan, the calls forward with one left
  unmade, and back, `-Undo`), `calls`, `source-by-id`, `source-from-settings`,
  `source-from-list`, `as-source`, `config`, `list`, `export-import`, `sections` and
  `left-alone`. Each pass builds its sandboxes from this computer's data and removes them, runs
  its own scratch copy of the tool, reads what it expects (group names, labels, the sections)
  from the sandbox's data, and has `make-faults.js` make the faults the checkers and
  `check-sidebar-calls.js` must catch. `--pass <names>` runs some; `--keep` keeps the work
  folder, which is kept anyway when something is wrong. PROOF INCOMPLETE names what this data could not test. It
  needs Node and Windows PowerShell 5.1, and accounts with groups and pins; its header says what
  each pass stages. Made 2026-10-08 from the drivers of that day's proofs.
- `stage-sandbox.js` — stages states in a sandbox for `prove-tool.js`, or by hand: an account's
  groups and pins taken out, a group with no chat, a chat filed, pinned or made newer than a
  plan, a list without pins, the scratch config naming an account by its email or its id. It
  writes nothing outside the sandboxes' folder. Its header lists the commands.
- `make-faults.js` — makes one fault at a time in a checker's input (a plan, a list or export,
  the settings file, a chat entry) or in a throwaway copy of the script, and checks that it is
  caught by exactly the check meant for it, or that the result stays clean where the app makes
  such a change itself. A fault runs only beside its undamaged input passing, and one this data
  cannot stage is reported as not tested. Used by `prove-tool.js`; its header lists the modes.
- `new-sandbox.ps1` — builds, compares or removes a sandbox: copies of the app's sidebar index,
  settings file, browser storage and IndexedDB, minimal account files naming the same accounts as
  Claude Code's real ones, and a junction (a folder link) to the real transcripts folder, which the
  script only reads. Sandboxes go under the temp folder, private to the user, because the storage
  copies hold everything the app keeps there.
- `verify-entries.js` — checks a run's chat entries: each chat the receiving account lacked got
  exactly one entry, and no transcript an entry keeps as another part of its chat got one; each
  new entry's dates and folder are what the script's rules give, recomputed here from the
  entries and transcripts; each new entry has its twin's title, model, effort, archived state
  and earlier transcripts, holds no other field, and is in the default permission mode; each
  existing entry whose twin in the source account names another folder moved there unless a rule
  forbids it; and every entry file the run neither created nor backed up is as the sandbox was
  built. Which transcripts belong to an entry's chat is worked out here from the desktop app's
  own rules (2.19675.0.0), not from the script.
- `verify-plan.js` — checks a run's sidebar plan: it names the two accounts; its groups are the
  source's, in order, each with exactly the receiving account's entries for the chats the source
  filed in it; its pins are the entries for the source's pinned chats; and it records the
  receiving account's own groups and pins as they were. It reads the source's groups from the
  sandbox's browser storage with `read-localstorage.js`, or with `--source-from` from the
  settings file, from a saved list, or from nowhere (`none`: the plan must leave the groups
  alone). With `--source-from file:<file>` it checks a plan `-Import` made from that file: the
  groups and the pins to reach are the file's (no pins planned when the file keeps none), the
  groups as they were come from the settings file, and the plan names the file and leaves chats
  created after the file was saved as they are.
- `sidebar-sim.js` — stands in for the app's sidebar tools in a sandbox: makes the calls
  `-Sidebar` listed in the sandbox's copy of the app's settings file, the way the app was seen
  to make them, refuses what the tools refuse, and changes the receiving account's sidebar
  sections the way the app does (below). `--skip <n>` leaves one call unmade. It refuses to run
  on anything but a sandbox. `sidebar-sim-fixture.json` holds the sections the app wrote for one
  account when two groups were created and filled (desktop app 2.26454.2.0, 2026-10-08), group
  ids and names replaced; `prove-tool.js` compares the stand-in's sections with it.
- `verify-sidebar.js` — checks, after the calls, that the receiving account's groups and pins in
  the settings file are what the plan aims at (`desired` or `before`), or, when the plan leaves
  the groups alone, that they and their sections were left as they were; that every other
  account's pins are as they were, that the account's sidebar sections are in step with its
  groups (below), and that nothing else in the file changed.
- `verify-list.js` — checks the list of an account's groups and pinned chats the script saves for
  a switch (`sidebar-list-<account>.json` in the profile's `.session-restore\`), or an export
  (`--file <file>`): it names the account and its org, holds the groups of the app's settings
  file in order, each with the transcripts of the chats filed in it in their saved place, and the
  transcripts of the account's pinned chats in the pin list's order, and no half-written file is
  left beside it. It reads a sandbox's profile or the real one.
- `check-sidebar-calls.js` — checks the calls `-Sidebar` lists against calls written out by
  hand, in eleven cases it stages in a sandbox: an empty sidebar, groups that exist, an archived
  chat, a group the plan lacks, a chat made after the plan, a pinned chat that is filed, more
  than 100 chats, a part of the plan left out, two groups of one name, a sidebar that matches
  (with `-Back`, and a change after the plan was applied), and a plan for another account or
  none. It puts the sandbox's settings file and plan back when it ends.
- `check-shared-textread.ps1` — checks that `Read-TextFile` in a tool folder's script reads a
  file another handle has open for writing, and leaves it free to be replaced. Its control,
  `[System.IO.File]::ReadAllText`, must fail the first case, or the check fails. It works on a
  scratch file.
- `check-transcript-lib.js` — checks `lib\Transcripts.ps1` of a given tool folder by running its
  functions in Windows PowerShell: project folder names against the desktop app's own naming
  function, last-record times against a parse of every transcript, and the copy comparison on
  crafted cases and on every transcript stored in more than one project folder.
- `check-shared-read.js` — checks that `Read-TranscriptHeadLines` in a tool folder's
  `lib\Transcripts.ps1` lets another process keep writing to the transcript it reads: it reads a
  file another process holds open for appending, and once it has returned another process can
  append while the reading PowerShell still runs. Its control, `[System.IO.File]::ReadLines`
  left with `break`, must fail both, or the check fails. It works on a scratch file.
- `measure-file-times.js` — read-only: for the chats an account has no entry for, how far each
  transcript's last write time is from its last timestamped record, which is how far off an entry
  dated from file times would be (the script dated new entries that way until 2026-09-29).
  `--receiving <account uuid> [--source <account uuid>] [--profile <dir>]`.
- `classify-missing.js` — read-only: every transcript the receiving account has no entry for,
  sorted into chats another account lists (twins), earlier transcripts of chats already listed (an entry's
  `priorCliSessionIds`), and transcripts no entry names. `<receiving account uuid>`.
- `compare-copies.js` — read-only: every transcript stored in more than one project folder, each
  copy's size, write time, hash and last timestamped record, and whether the copies agree.
- `summarize-sidebar.js` — read-only: the structure of the sidebar's saved state (`dframe-store`)
  from a copy of `Local Storage\leveldb`: per account its groups and sizes, its Code sidebar
  sections and the pin order's length, without chat ids or titles.
- `compare-app-methods.js` — cuts one method out of two desktop-app captures and prints every
  difference once renamed identifiers are set aside. Added 2026-10-01 to recheck, after an app
  update, the code the tool relies on (`resolveProjectDirForSession`, `setProjectDir`,
  `copyTranscriptUntil`, `copyTranscriptUntilSettled`). Its controls are in its header.
- `delete-chat.ps1` — deletes one local chat from the app's data the way the app's own Delete
  does, without signing in to the account that lists it, sending to the Recycle Bin everything
  the app would remove: the entry, the old `archived-sessions.idx` (rewritten without it), the
  transcript and its folder, the session's files across Claude Code's folders and its temp
  folder; it writes the tombstones and the release marker the app writes. Files the app does not
  handle but that are named after the chat can be added with `-AlsoRecycle "<path>|<path>"`. It
  never opens a transcript. It refuses while the app runs signed in to the chat's account, and
  refuses before touching anything if a path reaches 260 characters (below). Usage in its header;
  `-DryRun` previews. Added 2026-10-01.
- `test-delete-chat.ps1` — proves `delete-chat.ps1` on fake profiles under the temp folder: its
  preview, every refusal, a real run, a chat another account also lists, a transcript written in
  the last 10 minutes, a path that is too long. `-PlanOnly` runs every check except the real run.
- `read-localstorage.js` — reads the newest value of browser-storage keys from a copy of a
  `Local Storage\leveldb` folder. It shares no code with the script's own reader, which is the point.
- `chromium-read-localstorage.py` — opens a copy of a `Local Storage\leveldb` folder in Playwright's
  Chromium and reads keys through the browser itself. No network: every request is answered locally
  or aborted.
- `scan-personal.js` — before anything is published: scans files and folders for the user's own
  email addresses, account, organization, session and group ids, user name and any words given,
  all read from this computer rather than written in it, with a control for each kind that must
  match first; it prints counts and places, never the details. `--allow <file>::<line>` lets a
  line through, such as a copyright notice. Usage in its header.
- `webui-cache\` — how the app's web interface code was found, since the app downloads it rather
  than shipping it: `scan-cache.js` decodes every body in the app's HTTP cache and saves those
  containing given strings; `decode-build.js` decodes one download batch and finds modules by what
  they export; `map-urls.js` reads the cache index to name each cached file's web address.
  Added 2026-10-01: `compare-webui-builds.js` compares two downloads statement by statement, so
  a change to the code that stores groups, pins or sections shows up although every build
  renames its identifiers (its controls are in its header); `enclosing-fns.js` prints the whole
  function around each occurrence of a text; `resolve-names.js` says where a file defines or
  imports a minified name (names are local to each file). The web interface is rebuilt several
  times a day. Since 2026-10-08 the tool writes nothing the web interface stores, so these are
  for investigating, not a step before every install.
  Added 2026-10-08, all read-only, each one's usage in its header: `cache-bodies.js` reads a
  cached body wherever
  Chromium keeps it, in an `f_` file or, for one under about 16 KB, inside the block files `data_1`
  to `data_4`, which `scan-cache.js` and `decode-build.js` never see; it lists entries with their
  times, searches the decoded bodies, writes one or all of them, and prints a response's headers
  with the endpoint and certificate it came through. `export-of.js` gives the module-local name a
  file exports under a given name, with its definition, case-sensitively. `leveldb-dump.js` reads
  a live `Local Storage\leveldb` or IndexedDB folder in place: every key, or every version still
  held (`read-localstorage.js` above reads given keys from a copy). `org-timeline.js` reads the
  app's `main.log` files for the organization whose sign-in was active when each Code session
  started, which the folder of a session's entry does not tell. `session-efforts.js` reads the
  effort Claude Code recorded on each session's reply records.

## What to know before using them

- **Never delete a sandbox recursively.** Its `.claude\projects` junction points at the real
  transcripts; a delete that follows the link would destroy them. `-Remove` unlinks it first
  (`rmdir` removes a link, not its target) and refuses if any other link remains.
- **The storage copies are taken while the app may be writing.** If the script reports that the
  browser storage was read while it was being written, rebuild the sandbox.
- **The app changes the receiving account's sidebar sections itself**, in
  `epitaxyPrefs["dframe-code-sections"]`: every group, empty or not, has one section of kind
  `manual` under its id and name, saved with no members; `create_group` adds one before
  Ungrouped, and `delete_group` drops it; where the sidebar's grouping does not yet show custom
  groups and it does not lay sessions out in sections (a feature switch of Anthropic's),
  `create_group` and a move into a group set Ungrouped's `groupBy` to "none"; and a move into a
  group expands that group's section (read, not yet seen). So `verify-sidebar.js` leaves that
  account's entry of the key out of its whole-file check and checks it on its own: one section
  for each group that holds a chat, under its id and name; any other group section there before
  the calls, unchanged, for a group that held no chat then; the built-in sections as before
  apart from their order and `groupBy`. Read in the web interface downloaded 2026-10-08 02:44,
  and seen on the real app at 07:57 that day; the stand-in makes that change byte for byte. The
  web interface is rebuilt often: after a change to the sidebar, read its function that
  reconciles the sections with the groups again (`webui-cache\scan-cache.js`, needle
  `kind:"manual"`) before trusting either.
- **A file a Claude session's shell creates under `AppData` is stored in the app's package
  folder**, because the desktop app is a packaged app; a console outside the app does not see it
  at the path asked for. So anything both a console run and a session's run must find is kept
  outside `AppData`: the tool's data folder is `.session-restore\` under the user profile.
  Sandboxes are under the temp folder, which is not redirected, so a sandbox cannot show this:
  it was found by asking Windows for the final path of a file a session's shell had just
  created (2026-10-08).
- **The web interface's module file names carry content hashes and change with every build**, and
  the app downloads a new build often. Find code by its content (a storage key such as
  `dframe-group-scopes`), never by a remembered file name.
- **The Windows shell's delete call destroys, instead of recycling, any item whose full path
  reaches 260 characters**, and reports success: measured 2026-10-01 on dummy files, with
  FOF_ALLOWUNDO and FOF_WANTNUKEWARNING set, no dialog and no Recycle Bin record. Check every path,
  and every file inside a folder, before sending anything to the Recycle Bin, as
  `delete-chat.ps1` does. The shell's Restore verb puts an item back but leaves its `$I` record in
  the Recycle Bin folder, where the shell no longer lists it, so emptying the bin does not remove
  it: a full run of `test-delete-chat.ps1` leaves 11 such records, which only deleting those
  files removes; use `-PlanOnly` unless the moving code itself changed.
- **Windows PowerShell 5.1 has built-in aliases a script's own function cannot override**, such
  as `diff` for `Compare-Object`: a function named `Diff` never runs, and a check built on it
  passes without comparing anything. Give helper functions Verb-Noun names.
- **A script's variables and its parameters share one set of names, whatever their letter case.**
  A parameter `-Sidebar` and a variable `$sidebar` are one variable, and assigning an object to
  it fails on the parameter's type. Met 2026-10-08.
- **`@(...)` around a `System.Collections.Generic.List[object]` made with `New-Object` throws
  "Argument types do not match"**, in Windows PowerShell 5.1 and PowerShell 7.6 alike; the same
  list made with `::new()`, a `List[string]` or `List[int]` made with `New-Object`, and an
  `ArrayList` are fine. Make such a list with `::new()`, or turn it into an array with
  `.ToArray()` first. And an empty array returned from `$(...)` becomes nothing: assign it to a
  variable to keep it a list. Both met 2026-10-08; the first checked in both shells that day.
- **Windows PowerShell 5.1 started with PowerShell 7's `PSModulePath` loses some of its own
  commands**: a program run from PowerShell 7, such as Node, passes 7's module folders, which come
  first, on to the `powershell.exe` it starts, and 5.1 then finds 7's copy of each module both
  have before its own. Of 17 commands tried, `Get-FileHash`, `Format-Hex`, `New-Guid`,
  `New-TemporaryFile`, `Get-Acl` and `Find-Module` were not found, and `new-sandbox.ps1` fails
  without `Get-FileHash`; the other 11, `Get-Date` and `Get-ChildItem` among them, were found.
  PowerShell 7 corrects the variable when it starts `powershell.exe` itself; Node does not.
  `prove-tool.js` and `make-faults.js` remove the variable before they start anything. Found
  2026-10-08; its extent checked 2026-10-09.
- **Git Bash converts doubled backslashes in arguments to native programs.** To search a transcript
  for a Windows path as JSON stores it (two backslashes), pass four; test any such search with a
  string known to be present first.
