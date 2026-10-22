# MyCourses -> Discord

A Discord bot that tells you which Aalto [MyCourses](https://mycourses.aalto.fi) and
[A+](https://plus.cs.aalto.fi) assignments you have and haven't submitted.

## Commands

- `/exercises [week-after:<n>]` — this week's work; `n` shifts the week (-8..8).
- `/session` — replace the MyCourses cookie (owner only, cookie fallback only).

It also posts a weekly summary (Monday 08:00) and, daily, any newly published
assignments or moved deadlines.

## Setup

Requires Node.js 22.9+.

    cp .env.example .env    # fill it in
    npm install
    npm start

| Variable | |
| --- | --- |
| `DISCORD_TOKEN` | Bot token from the [developer portal](https://discord.com/developers/applications) |
| `GUILD_ID`, `CHANNEL_ID` | Server and post channel (Developer Mode -> right-click -> Copy ID) |
| `MOODLE_WS_TOKEN` | MyCourses token, ~3 months (see below) |
| `APLUS_TOKEN` | From https://plus.cs.aalto.fi/api/v2/get-token/ |

Optional: `COURSE_FILTER`, `WEEKLY_POST_OFFSET`, `DAILY_HOUR`, `SCAN_WEEKS`, `OWNER_ID`,
`MOODLE_SESSION` — see `.env.example`.

**MyCourses token.** While logged in, open
`https://mycourses.aalto.fi/admin/tool/mobile/launch.php?service=moodle_mobile_app&passport=1&urlscheme=moodlemobile`,
copy the `moodlemobile://token=…` URL from the `location` header in DevTools -> Network,
and run `node ws-token.mjs "<url>"`.

`node --env-file=.env smoke.js` checks your tokens without touching Discord.
`npm test` runs the tests.

## Running it permanently

**Linux.** Install Node (`apt install nodejs` via [NodeSource](https://github.com/nodesource/distributions),
`pacman -S nodejs npm`, or [nvm](https://github.com/nvm-sh/nvm)), then add a systemd unit:

    # /etc/systemd/system/coursework-bot.service
    [Unit]
    After=network-online.target

    [Service]
    WorkingDirectory=/opt/coursework-bot
    ExecStart=/usr/bin/node --env-file=.env bot.js
    Restart=always

    [Install]
    WantedBy=multi-user.target

`sudo systemctl enable --now coursework-bot`; logs via `journalctl -u coursework-bot -f`.

**Windows.** `powershell -ExecutionPolicy Bypass -File install-task.ps1` starts it at
logon with a tray icon (Show log / Restart / Quit). Runs only while you're logged in.

## Notes

- `.env` holds credentials in plaintext; keep it private.
- If one source fails, the other still reports and the post carries a ⚠ footer.
- Delete `seen.json` to reset change tracking.
