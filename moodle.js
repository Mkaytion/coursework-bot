// Aalto MyCourses (Moodle). Two code paths, chosen by whether MOODLE_WS_TOKEN is set:
//
//  * API path (preferred): a ~3-month mobile web-service token. Reads assignments, quizzes
//    and per-user submission status straight from the REST API. No cookie, no HTML scraping.
//  * Cookie path (fallback): the old MoodleSession cookie + calendar AJAX + activity-page
//    scraping. Kept dormant so unsetting the token reverts to a known-good path.
//
// Both return the same item shape:
//   { uid, name, course, courseName, dueDate, status, source:'MyCourses', modulename }
// status ∈ submitted | not-submitted | draft | offline | offline-graded

const BASE = 'https://mycourses.aalto.fi';

// "COE-C2003 - Basic course on fluid mechanics, Contact teaching, 1.9.2026-16.10.2026"
//   -> "Basic course on fluid mechanics"
export const title = (fullname = '') =>
  (fullname.split(' - ').slice(1).join(' - ') || fullname).split(',')[0].trim();

async function pool(items, size, fn) {
  const out = [];
  for (let i = 0; i < items.length; i += size)
    out.push(...(await Promise.all(items.slice(i, i + size).map(fn))));
  return out;
}

// ─── API path (token) ──────────────────────────────────────────────────────

export const WS_EXPIRED = 'MOODLE_WS_TOKEN invalid or expired — recapture via launch.php + ws-token.mjs';

const arrParams = (key, ids) => ids.reduce((o, id, i) => ((o[`${key}[${i}]`] = id), o), {});

async function wsCall(wsfunction, params = {}) {
  const body = new URLSearchParams({
    wstoken: process.env.MOODLE_WS_TOKEN, wsfunction, moodlewsrestformat: 'json', ...params,
  });
  const res = await fetch(`${BASE}/webservice/rest/server.php`, {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body,
  });
  const data = await res.json();
  if (data && data.errorcode) {
    if (['invalidtoken', 'accessexception'].includes(data.errorcode)) throw new Error(WS_EXPIRED);
    throw new Error(`${wsfunction}: ${data.errorcode}`);
  }
  return data;
}

// Names come bilingual and marked up: "{mlang en,sv}Essay 1{mlang}{mlang fi}Essee{mlang}".
export function stripMlang(s = '') {
  const str = String(s);
  const en = /\{mlang\s+en[^}]*\}([\s\S]*?)\{mlang\}/i.exec(str);
  const base = en ? en[1] : str.replace(/\{mlang[^}]*\}/gi, ' ');
  return base.replace(/\s+/g, ' ').trim();
}

// `passed`/grade can't be trusted the way A+ taught us; here the submission record is direct.
export function assignStatus(assignment, status) {
  const offline = assignment.nosubmissions === 1 || status?.lastattempt?.submissionsenabled === false;
  const g = status?.feedback?.grade?.grade;
  const graded = g != null && g !== '' && Number(g) >= 0;
  if (offline) return graded ? 'offline-graded' : 'offline';
  const st = status?.lastattempt?.submission?.status;
  if (st === 'submitted') return 'submitted';
  if (st === 'draft') return 'draft';
  return 'not-submitted'; // 'new', or no submission record yet
}

export function quizStatus(attempts = []) {
  // A finished attempt is submitted; 'inprogress'/'overdue'/none is not.
  return attempts.some((a) => a.state === 'finished') ? 'submitted' : 'not-submitted';
}

async function courseMap() {
  const byId = new Map();
  for (const classification of ['inprogress', 'future']) {
    const data = await wsCall('core_course_get_enrolled_courses_by_timeline_classification', { classification });
    for (const c of data.courses || [])
      byId.set(c.id, { code: c.shortname.split('_')[0], title: title(c.fullname) });
  }
  return byId;
}

async function fetchMoodleApi(start, end) {
  const filters = (process.env.COURSE_FILTER || '')
    .split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);

  const byId = await courseMap();
  let ids = [...byId.keys()];
  if (filters.length) ids = ids.filter((id) => filters.some((f) => byId.get(id).code.toLowerCase().includes(f)));
  if (!ids.length) return [];

  const within = (sec) => sec > 0 && sec * 1000 >= +start && sec * 1000 < +end;

  // One call each lists every assignment / quiz across this period's courses.
  const asg = await wsCall('mod_assign_get_assignments', arrParams('courseids', ids));
  const assignTargets = (asg.courses || []).flatMap((c) =>
    (c.assignments || []).filter((a) => within(a.duedate)).map((a) => ({ a, courseId: c.id })));

  const qz = await wsCall('mod_quiz_get_quizzes_by_courses', arrParams('courseids', ids));
  const quizTargets = (qz.quizzes || []).filter((q) => within(q.timeclose));

  // Then one status call per in-window item.
  const assignments = await pool(assignTargets, 6, async ({ a, courseId }) => {
    const s = await wsCall('mod_assign_get_submission_status', { assignid: a.id });
    const c = byId.get(courseId) || {};
    return {
      uid: `moodle:assign:${a.id}`, name: stripMlang(a.name),
      course: c.code, courseName: c.title, dueDate: new Date(a.duedate * 1000),
      status: assignStatus(a, s), source: 'MyCourses', modulename: 'assign',
    };
  });

  const quizzes = await pool(quizTargets, 6, async (q) => {
    const r = await wsCall('mod_quiz_get_user_attempts', { quizid: q.id, status: 'all', includepreviews: 0 });
    const c = byId.get(q.course) || {};
    return {
      uid: `moodle:quiz:${q.id}`, name: stripMlang(q.name),
      course: c.code, courseName: c.title, dueDate: new Date(q.timeclose * 1000),
      status: quizStatus(r.attempts), source: 'MyCourses', modulename: 'quiz',
    };
  });

  return [...assignments, ...quizzes];
}

// ─── Cookie path (fallback) ──────────────────────────────────────────────────

const cookie = () => `MoodleSession=${process.env.MOODLE_SESSION}`;

export const EXPIRED = 'MOODLE_SESSION expired — copy a fresh MoodleSession cookie into .env';

// A dead session 303s to /login/index.php, which then redirects to itself forever.
export const isLoginRedirect = (location = '') => /\/login\//.test(location);

async function get(url, hops = 0) {
  const res = await fetch(url, {
    headers: { cookie: cookie(), 'user-agent': 'Mozilla/5.0' },
    redirect: 'manual',
  });
  if (res.status >= 300 && res.status < 400) {
    const location = res.headers.get('location') || '';
    if (isLoginRedirect(location) || hops >= 2) throw new Error(EXPIRED);
    return get(new URL(location, url).href, hops + 1);
  }
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.text();
}

let _sesskey;
async function sesskey() {
  if (_sesskey) return _sesskey;
  const html = await get(`${BASE}/my/courses.php`);
  const m = /"sesskey":"([^"]+)"/.exec(html);
  if (!m) throw new Error('Not logged in — MOODLE_SESSION is missing or expired. Grab a fresh cookie.');
  return (_sesskey = m[1]);
}

/** Swap in a new cookie at runtime. Clears the cached sesskey, which is session-bound. */
export function setSession(value) {
  process.env.MOODLE_SESSION = value;
  _sesskey = undefined;
}

async function ajax(methodname, args) {
  const res = await fetch(`${BASE}/lib/ajax/service.php?sesskey=${await sesskey()}&info=${methodname}`, {
    method: 'POST',
    headers: { cookie: cookie(), 'content-type': 'application/json' },
    body: JSON.stringify([{ index: 0, methodname, args }]),
    redirect: 'manual',
  });
  if (res.status !== 200) { // a dead session redirects here too, and never returns JSON
    _sesskey = undefined;
    throw new Error(EXPIRED);
  }
  const [out] = await res.json();
  if (out.error) {
    _sesskey = undefined;
    throw new Error(out.exception?.message || 'Moodle AJAX error');
  }
  return out.data;
}

async function activeCourses() {
  const byId = new Map();
  for (const classification of ['inprogress', 'future']) {
    const data = await ajax('core_course_get_enrolled_courses_by_timeline_classification',
      { classification, limit: 0, offset: 0, sort: 'fullname' });
    for (const c of data.courses || []) byId.set(c.id, { code: c.shortname.split('_')[0], title: title(c.fullname) });
  }
  return byId;
}

/**
 * Narrow to the page's main region before matching. The nav, side panel and footer carry
 * course and activity names that can contain the very phrases the classifier keys on.
 */
export function mainRegion(html) {
  const m = /<section[^>]*id=["']region-main["'][\s\S]*?<\/section>/i.exec(html)
    || /<div[^>]*role=["']main["'][\s\S]*?<\/div>/i.exec(html);
  return m ? m[0] : html;
}

export const flatten = (html) =>
  html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&#0?39;/g, "'")
    .replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ');

export function classify(modulename, text) {
  if (modulename === 'assign') {
    if (/does not require you to submit anything online/i.test(text))
      return /Grading status\s*Graded/i.test(text) ? 'offline-graded' : 'offline';
    if (/Submitted for grading/i.test(text)) return 'submitted';
    if (/Draft \(not submitted/i.test(text)) return 'draft';
    return 'not-submitted';
  }
  const attempted = /Your final grade for this quiz is|Summary of your previous attempts|Your attempts|Re-attempt quiz|Attempt \d+ summary/i.test(text);
  if (!attempted) return 'not-submitted';
  if (/Status\s*Finished|Your final grade for this quiz is/i.test(text)) return 'submitted';
  if (/Status\s*In progress|Continue (your|the)( last)? attempt/i.test(text)) return 'not-submitted';
  return 'submitted';
}

export function selectEvents(events, courses, filters, start, end) {
  return events.filter((e) => {
    if (!['due', 'close'].includes(e.eventtype)) return false;
    if (!['assign', 'quiz'].includes(e.modulename)) return false;
    const c = courses.get(e.course?.id);
    if (!c) return false;
    if (filters.length && !filters.some((f) => c.code.toLowerCase().includes(f))) return false;
    const ms = e.timesort * 1000;
    return ms >= +start && ms < +end;
  });
}

const monthsBetween = (start, end) => {
  const out = [];
  const d = new Date(start.getFullYear(), start.getMonth(), 1);
  while (d <= end) {
    out.push([d.getFullYear(), d.getMonth() + 1]);
    d.setMonth(d.getMonth() + 1);
  }
  return out;
};

async function fetchMoodleCookie(start, end) {
  const filters = (process.env.COURSE_FILTER || '')
    .split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  const courses = await activeCourses();

  const seen = new Set();
  const events = [];
  for (const [year, month] of monthsBetween(start, end)) {
    const view = await ajax('core_calendar_get_calendar_monthly_view', {
      year, month, courseid: 1, categoryid: 0, includenavigation: false, mini: true, day: 1,
    });
    const all = view.weeks.flatMap((w) => w.days).flatMap((d) => d.events || []);
    for (const e of selectEvents(all, courses, filters, start, end)) {
      if (seen.has(e.id)) continue;
      seen.add(e.id);
      events.push({
        uid: 'moodle:' + e.url,
        name: e.name, course: courses.get(e.course.id).code, courseName: courses.get(e.course.id).title,
        source: 'MyCourses', dueDate: new Date(e.timesort * 1000), url: e.url, modulename: e.modulename,
      });
    }
  }

  return pool(events, 6, async (e) => ({
    ...e,
    status: classify(e.modulename, flatten(mainRegion(await get(e.url)))),
  }));
}

// ─── dispatch ────────────────────────────────────────────────────────────────

/** Deadlines between start and end in this period's courses, each with its real status. */
export async function fetchMoodle(start, end) {
  return process.env.MOODLE_WS_TOKEN ? fetchMoodleApi(start, end) : fetchMoodleCookie(start, end);
}

/** Liveness probe at startup: validates whichever credential is active. */
export async function checkSession() {
  if (process.env.MOODLE_WS_TOKEN) { await wsCall('core_webservice_get_site_info'); return; }
  await sesskey();
}
