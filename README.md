# MyCourses -> Discord

`/exercises` reports what you submitted on mycourses.aalto.fi and A+ and what you didn't.

`/exercises week-after:<n>` shifts the window: `0` (default) is this week, `1` next week,
`-1` last week. Range -8..8.

`/session` replaces the MyCourses cookie without touching the server. It opens a **modal**
rather than taking a command option, so the value is never rendered as message content;
the reply is ephemeral. Restricted to the Discord application's owner, resolved
automatically at startup (set `OWNER_ID` only if the app is team-owned). The new cookie is
verified against MyCourses before it is written to `.env` — a bad value is rejected and the
previous one kept.

Note it still passes through Discord's servers. It stays out of channel history, but if you
want it never to reach Discord at all, edit `.env` and restart instead.

## Scheduled posts

- **Weekly summary**, Monday 08:00 -> `CHANNEL_ID`. Same content as the command. Because it
  runs Monday morning it previews the week ahead; set `WEEKLY_POST_OFFSET=-1` for a recap
  of the week just finished.
- **Daily change check**, `DAILY_HOUR` (default 18:00). Scans `SCAN_WEEKS` (default 4)
  weeks ahead and posts **only what changed** since yesterday: newly published assignments
  and moved deadlines. Silent when nothing changed. This is what catches a course that
  publishes its exercises mid-term.

There is no cache — the command and both scheduled jobs always fetch live. The daily
check exists to *notify* you of changes, not to refresh anything.

Change detection keys on a stable id (Moodle activity URL, A+ module id), so renaming an
assignment or submitting part of an A+ round does not register as new work. State lives in
`seen.json`; delete it to re-baseline (the next run then posts nothing and re-records).
The snapshot merges rather than replaces, so a source that fails one day does not
re-announce its whole backlog when it recovers.

Scope: **this period's courses only** — the bot asks Moodle which of your enrolments are
`inprogress` or `future` and ignores the rest. Courses move between those states on their
own, so this needs no edit next period.

## Setup

1. **Discord bot**: https://discord.com/developers/applications -> New Application ->
   Bot -> Reset Token. Copy the token into `.env` yourself.
2. **Invite it** to the server, or nothing registers. The bot prints the correct URL on
   startup if it isn't in the guild.
3. **IDs**: Discord Settings > Advanced > Developer Mode, then right-click the server ->
   Copy Server ID (`GUILD_ID`), right-click the channel -> Copy Channel ID (`CHANNEL_ID`).
4. **MOODLE_WS_TOKEN**: see "MyCourses auth" below (one-time, ~3-month token).
5. **APLUS_TOKEN**: https://plus.cs.aalto.fi/api/v2/get-token/ while logged in.
6. `npm install && npm start`

Put real values in `.env`, never in `.env.example` — nothing reads the latter and it is
not gitignored.

`node --env-file=.env smoke.js` prints the data without touching Discord — use it to check
whether the MyCourses token is still valid.

## Running it unattended

    powershell -ExecutionPolicy Bypass -File install-task.ps1

Registers a Windows scheduled task (`MyCoursesBot`) that starts the bot at logon with **no
window and no taskbar entry** — just a tray icon (`tray.ps1`). Right-click it for
Show log / Restart / Quit. Quit stays quit until next logon (or `Start-ScheduledTask
MyCoursesBot`). The tray restarts the bot within ~10s if it crashes. No admin rights
needed. Output goes to `bot.log`.

    Get-ScheduledTask MyCoursesBot            # state
    Get-Content bot.log -Tail 20 -Wait        # follow the log
    Stop-ScheduledTask  -TaskName MyCoursesBot
    Unregister-ScheduledTask -TaskName MyCoursesBot   # remove it entirely

Two things about how it is set up:

- Recovery is the tray's **watchdog**, not `RestartCount`. Task Scheduler's "if the task
  fails, restart" only covers the task failing to *launch* — a process that exits leaves the
  task "Ready" and it never comes back. There is deliberately no repeating trigger either:
  it would resurrect the bot minutes after you chose Quit. The tray process itself is not
  supervised; if it dies, the bot stays down until next logon.
- It launches through `conhost --headless` because Windows 11 opens scheduled console apps
  in Windows Terminal, which ignores `-WindowStyle Hidden`.
- It runs **only while you are logged on**. Running whether-logged-on-or-not means storing
  your Windows password in the task, which isn't worth it here. Consequence: with the
  machine off or logged out at 18:00, that day's change check is skipped. Nothing is lost —
  the snapshot is cumulative, so the next run reports everything that changed since the
  last one. For genuinely 24/7 operation it needs to live somewhere that is always on.

## Sources

- **MyCourses** (Moodle) — assignments and quizzes, via the mobile web-service REST API.
- **A+** (plus.cs.aalto.fi) — Aalto CS exercises. Deadlines sit on the module/round, so a
  round reports as one line with an (n/total submitted) count.

Each source is fetched independently; if one fails the other still reports and the embed
carries a warning footer. `APLUS_TOKEN` never expires; `MOODLE_WS_TOKEN` lasts ~3 months.

## MyCourses auth: web-service token (with a cookie fallback)

The bot authenticates to MyCourses with a **mobile web-service token** (`MOODLE_WS_TOKEN`),
the same kind the Moodle mobile app uses. It lasts ~3 months and reads assignments, quizzes
and per-user submission status straight from the REST API — no browser cookie, no HTML
scraping.

Getting / refreshing the token (once per term, Aalto is SSO so it can't be automated):
1. Logged into MyCourses, visit
   `https://mycourses.aalto.fi/admin/tool/mobile/launch.php?service=moodle_mobile_app&passport=1&urlscheme=moodlemobile`
2. Copy the `location` response header (a `moodlemobile://token=…` URL) from DevTools → Network.
3. `node ws-token.mjs "moodlemobile://token=…"` — decodes and writes `MOODLE_WS_TOKEN` to `.env`.

**Fallback:** if `MOODLE_WS_TOKEN` is unset, the bot reverts to the old `MoodleSession`
cookie path (calendar AJAX + activity-page scraping), and `/session` updates that cookie.
The cookie expires every few days; the token is the reason you no longer deal with that.

## How it reads submission status

Via the API: `mod_assign_get_submission_status` gives each assignment's real state
(submitted / draft / new / offline), and `mod_quiz_get_user_attempts` marks a quiz
submitted once an attempt is `finished`. No page-text matching.

On A+ it counts `submission_count`, never the `passed` flag — `passed` is true whenever
`points_to_pass` is 0, which is the default, so it marks untouched exercises as done.

A+ also clamps an expired course's unfinished rounds to the course end date, so a finished
course dumps its whole backlog into the week it expired. The bot requires a course to
still be running at the end of the week being asked about.

Buckets: **submitted** (incl. offline-and-graded), **not submitted** (incl. drafts and
partly-done A+ rounds), **no online submission** (offline, ungraded).

## Caveats

- `MOODLE_WS_TOKEN` lasts ~3 months, then API calls fail and the report carries a ⚠ footer.
  Recapture it with the steps above. (The old `MoodleSession` cookie fallback still expires
  every few days if you ever drop back to it.)
- A web-service token is a longer-lived credential than the cookie was; `.env` holds it in
  plaintext, so guard `.env` accordingly.
- A course only appears once it exposes assignments/quizzes to the MyCourses API (or lives
  on A+). One on neither, published nowhere the bot can see, needs a new source in
  `scraper.js`.
