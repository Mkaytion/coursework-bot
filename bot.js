import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  Client, GatewayIntentBits, EmbedBuilder, MessageFlags,
  ModalBuilder, TextInputBuilder, TextInputStyle, ActionRowBuilder,
} from 'discord.js';
import { fetchExercises } from './scraper.js';
import { checkSession, setSession } from './moodle.js';

const ENV_FILE = fileURLToPath(new URL('./.env', import.meta.url));

/** People paste the whole cookie pair or stray quotes; take just the value. */
export function cleanCookie(raw = '') {
  return raw.trim().replace(/^["']|["';]+$/g, '').replace(/^MoodleSession\s*=\s*/i, '').trim();
}
export const looksLikeCookie = (v) => /^[A-Za-z0-9]{16,128}$/.test(v);

/** Rewrite one key in .env, leaving every other line untouched. */
export function upsertEnv(text, key, value) {
  const line = `${key}=${value}`;
  const re = new RegExp(`^${key}=.*$`, 'm');
  return re.test(text) ? text.replace(re, line) : `${text.replace(/\n?$/, '\n')}${line}\n`;
}

const SNAPSHOT = fileURLToPath(new URL('./seen.json', import.meta.url));

// Monday 00:00 of the week containing `now`, and the Monday after it.
export function weekRange(now = new Date()) {
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  start.setDate(start.getDate() - ((start.getDay() + 6) % 7)); // Sun=0 -> 6
  const end = new Date(start);
  end.setDate(end.getDate() + 7);
  return { start, end };
}

/** The week `weeksAhead` weeks from the one containing `now`. Negative looks back. */
export function weekFor(weeksAhead = 0, now = new Date()) {
  const base = new Date(now);
  base.setDate(base.getDate() + weeksAhead * 7);
  return weekRange(base);
}

/** Next occurrence of `hour`:00 (optionally on `weekday`) strictly in the future. */
export function nextRun(hour, weekday = null, now = new Date()) {
  const t = new Date(now);
  t.setHours(hour, 0, 0, 0);
  while (+t <= +now || (weekday !== null && t.getDay() !== weekday)) t.setDate(t.getDate() + 1);
  return t;
}

// Offline assignments can't be submitted online at all, so nagging about them is a lie.
export function split(items) {
  return {
    submitted: items.filter((e) => e.status === 'submitted' || e.status === 'offline-graded'),
    missing: items.filter((e) => e.status === 'not-submitted' || e.status === 'draft'),
    offline: items.filter((e) => e.status === 'offline'),
  };
}

/**
 * Compare a fetch against the last snapshot. Keyed on uid, so renames and A+ progress
 * counts don't masquerade as new work. Merges rather than replaces: a source that failed
 * today keeps its old keys instead of re-announcing everything when it recovers.
 */
export function diffSnapshot(previous, items) {
  const added = [];
  const moved = [];
  const next = { ...previous };
  for (const it of items) {
    const due = new Date(it.dueDate).toISOString();
    if (!(it.uid in previous)) added.push(it);
    else if (previous[it.uid] !== due) moved.push({ ...it, was: previous[it.uid] });
    next[it.uid] = due;
  }
  return { added, moved, next };
}

const fmtDay = (d) => new Date(d).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });

// Grouped under a course heading so the course is named once, not repeated per line.
export function list(items) {
  if (!items.length) return '_nothing_';
  const byCourse = new Map();
  for (const e of [...items].sort((a, b) => a.dueDate - b.dueDate)) {
    const head = `**${e.course}** — ${(e.courseName || '').slice(0, 55)}`;
    if (!byCourse.has(head)) byCourse.set(head, []);
    byCourse.get(head).push(e);
  }
  let out = '';
  let dropped = 0;
  for (const [head, group] of byCourse) {
    const lines = group.map((e) =>
      `• ${e.name} — ${fmtDay(e.dueDate)}${e.was ? ` _(was ${fmtDay(e.was)})_` : ''}`);
    const block = `${head}\n${lines.join('\n')}\n`;
    if (out.length + block.length > 900) { dropped += group.length; continue; }
    out += block;
  }
  return dropped ? `${out}_…and ${dropped} more_` : out;
}

const weekLabel = (n) => (n === 0 ? 'This week' : n === 1 ? 'Next week' : n === -1 ? 'Last week'
  : n > 0 ? `In ${n} weeks` : `${-n} weeks ago`);

async function buildEmbed(weeksAhead = 0) {
  const { start, end } = weekFor(weeksAhead);
  const { items, errors } = await fetchExercises(start, end);
  const { submitted, missing, offline } = split(items);
  const embed = new EmbedBuilder()
    .setTitle(`${weekLabel(weeksAhead)} — ${fmtDay(start)} to ${fmtDay(new Date(end - 1))}`)
    .setColor(missing.length ? 0xe74c3c : 0x2ecc71)
    .addFields(
      { name: `✅ Submitted (${submitted.length})`, value: list(submitted) },
      { name: `❌ Not submitted (${missing.length})`, value: list(missing) },
    );
  if (offline.length)
    embed.addFields({ name: `ℹ️ No online submission (${offline.length})`, value: list(offline) });
  if (!items.length) embed.setDescription('No deadlines found.');
  // A source that died must be visible: an empty list otherwise reads as "all done".
  if (errors.length) embed.setFooter({ text: `⚠ source unavailable — ${errors.join(' | ')}` });
  return embed;
}

if (import.meta.main) {
  const client = new Client({ intents: [GatewayIntentBits.Guilds] });
  const scanWeeks = Number(process.env.SCAN_WEEKS ?? 4);
  let ownerId = null; // resolved from the Discord application; /session is owner-only

  /** Daily: look ahead `scanWeeks`, post only what changed. Silent when nothing has. */
  async function dailyCheck(c) {
    const { start } = weekFor(0);
    const { end } = weekFor(scanWeeks - 1);
    const { items, errors } = await fetchExercises(start, end);
    if (!items.length && errors.length)
      return console.error(`daily check: every source failed — ${errors.join(' | ')}`);

    let previous = null;
    try { previous = JSON.parse(fs.readFileSync(SNAPSHOT, 'utf8')); } catch { /* no baseline yet */ }
    const { added, moved, next } = diffSnapshot(previous ?? {}, items);
    fs.writeFileSync(SNAPSHOT, JSON.stringify(next, null, 2));

    if (!previous)
      return console.log(`daily check: baseline recorded (${items.length} items), posting nothing`);
    if (!added.length && !moved.length) return console.log('daily check: nothing new');

    const embed = new EmbedBuilder()
      .setTitle(`Coursework update — next ${scanWeeks} weeks`)
      .setColor(0x3498db);
    if (added.length) embed.addFields({ name: `🆕 New (${added.length})`, value: list(added) });
    if (moved.length) embed.addFields({ name: `🔁 Deadline moved (${moved.length})`, value: list(moved) });
    if (errors.length) embed.setFooter({ text: `⚠ source unavailable — ${errors.join(' | ')}` });

    const ch = await c.channels.fetch(process.env.CHANNEL_ID);
    await ch.send({ embeds: [embed] });
    console.log(`daily check: posted ${added.length} new, ${moved.length} moved`);
  }

  // Recomputes the next occurrence after every run, so DST can't drift the schedule.
  function repeat(hour, weekday, fn) {
    const arm = () => {
      const at = nextRun(hour, weekday);
      setTimeout(async () => {
        try { await fn(); } catch (err) { console.error('scheduled task failed:', err.message); }
        arm();
      }, at - Date.now());
      return at;
    };
    return arm();
  }

  client.once('clientReady', async (c) => {
    console.log(`up as ${c.user.tag}`);
    if (!process.env.APLUS_TOKEN)
      console.warn('no APLUS_TOKEN — A+ courses (e.g. CS-A1140) will be missing from reports');
    // report a dead cookie at startup rather than leaving it to be discovered mid-command
    try { await checkSession(); console.log('MyCourses session ok'); }
    catch (err) { console.error(`MyCourses: ${err.message}`); }

    // Owner of the Discord application, so /session needs no configuring. Fails closed:
    // if this can't be resolved, nobody may set the cookie through Discord.
    const app = await c.application.fetch();
    ownerId = app.owner?.ownerId ?? app.owner?.id ?? process.env.OWNER_ID ?? null;
    console.log(ownerId ? `/session restricted to owner ${ownerId}` : '/session disabled — owner unknown');

    // Fail loudly: a wrong GUILD_ID would otherwise skip registration in silence.
    const guild = c.guilds.cache.get(process.env.GUILD_ID);
    if (!guild) {
      console.error(`GUILD_ID ${process.env.GUILD_ID} not found. /exercises will NOT appear.`);
      console.error(`Invite the bot first (VIEW_CHANNEL + SEND_MESSAGES + EMBED_LINKS):
  https://discord.com/api/oauth2/authorize?client_id=${c.user.id}&permissions=19456&scope=bot%20applications.commands`);
    } else {
      await guild.commands.set([
        {
          name: 'exercises',
          description: "What you've submitted this week, and what you haven't",
          options: [{
            type: 4, // INTEGER
            name: 'week-after',
            description: 'Weeks from now: 0 = this week (default), 1 = next week, -1 = last week',
            required: false,
            min_value: -8,
            max_value: 8,
          }],
        },
        // No option here on purpose: a command option is rendered in the channel.
        // This opens a modal instead, so the cookie never appears as message content.
        { name: 'session', description: 'Update the MyCourses session cookie (owner only)' },
      ]);
      console.log(`/exercises and /session registered in "${guild.name}"`);
    }

    if (!process.env.CHANNEL_ID) return console.log('no CHANNEL_ID — scheduled posts off');
    try {
      const ch = await c.channels.fetch(process.env.CHANNEL_ID);
      console.log(`post target: #${ch.name}`);
    } catch (err) {
      return console.error(`CHANNEL_ID unusable (${err.message}) — scheduled posts disabled.`);
    }

    const weekly = repeat(8, 1, async () => {
      const ch = await c.channels.fetch(process.env.CHANNEL_ID);
      await ch.send({ embeds: [await buildEmbed(Number(process.env.WEEKLY_POST_OFFSET ?? 0))] });
    });
    const daily = repeat(Number(process.env.DAILY_HOUR ?? 18), null, () => dailyCheck(c));
    console.log(`weekly summary: ${weekly.toLocaleString()}`);
    console.log(`daily change check: ${daily.toLocaleString()} (looks ${scanWeeks} weeks ahead)`);
  });

  client.on('interactionCreate', async (i) => {
    if (i.isChatInputCommand() && i.commandName === 'exercises') {
      const weeks = i.options.getInteger('week-after') ?? 0;
      // logs the interaction id: one id twice = a bug here, two ids = it was invoked twice
      console.log(`[${new Date().toISOString()}] interaction ${i.id} week-after=${weeks} by ${i.user.tag}`);
      await i.deferReply(); // reading the sources takes a few seconds
      try {
        await i.editReply({ embeds: [await buildEmbed(weeks)] });
      } catch (err) {
        console.error(err);
        await i.editReply(`Couldn't build the report: ${err.message}`);
      }
      return;
    }

    if (i.isChatInputCommand() && i.commandName === 'session') {
      if (!ownerId || i.user.id !== ownerId) {
        console.warn(`/session refused for ${i.user.tag} (${i.user.id})`);
        return i.reply({ content: 'Only the bot owner can update the session cookie.', flags: MessageFlags.Ephemeral });
      }
      return i.showModal(
        new ModalBuilder().setCustomId('session-modal').setTitle('MyCourses session')
          .addComponents(new ActionRowBuilder().addComponents(
            new TextInputBuilder()
              .setCustomId('cookie')
              .setLabel('MoodleSession cookie value')
              .setPlaceholder('DevTools > Application > Cookies > MoodleSession')
              .setStyle(TextInputStyle.Short)
              .setRequired(true)
              .setMaxLength(128))));
    }

    if (i.isModalSubmit() && i.customId === 'session-modal') {
      if (!ownerId || i.user.id !== ownerId) return; // belt and braces
      const value = cleanCookie(i.fields.getTextInputValue('cookie'));
      if (!looksLikeCookie(value)) // never echo the value back
        return i.reply({ content: "That doesn't look like a MoodleSession value (expected 16+ letters/digits).", flags: MessageFlags.Ephemeral });

      await i.deferReply({ flags: MessageFlags.Ephemeral });
      const previous = process.env.MOODLE_SESSION;
      setSession(value);
      try {
        await checkSession();
      } catch (err) {
        setSession(previous); // keep the old one rather than persisting a dud
        return i.editReply(`Rejected, keeping the previous cookie — ${err.message}`);
      }
      try {
        fs.writeFileSync(ENV_FILE, upsertEnv(fs.readFileSync(ENV_FILE, 'utf8'), 'MOODLE_SESSION', value), { mode: 0o600 });
      } catch (err) {
        return i.editReply(`Session works but saving to .env failed (${err.message}) — it will be lost on restart.`);
      }
      console.log('MOODLE_SESSION updated via /session and verified');
      await i.editReply('MyCourses session updated and verified. Saved to .env.');
    }
  });

  client.login(process.env.DISCORD_TOKEN);
}
