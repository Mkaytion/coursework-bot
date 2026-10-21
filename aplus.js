// A+ (plus.cs.aalto.fi) — where Aalto CS courses keep their exercises.
// Deadlines live on the MODULE ("round"), not the individual exercise, so one round
// becomes one reported item carrying a submitted/total count.
//
// Auth: a permanent API token from https://plus.cs.aalto.fi/api/v2/get-token/
// (unlike the Moodle cookie, this does not expire).

const BASE = 'https://plus.cs.aalto.fi';

async function api(path) {
  const res = await fetch(`${BASE}${path}`, {
    headers: { authorization: `Token ${process.env.APLUS_TOKEN}`, accept: 'application/json' },
  });
  if (res.status === 401 || res.status === 403)
    throw new Error('A+ rejected APLUS_TOKEN — regenerate it at /api/v2/get-token/');
  if (!res.ok) throw new Error(`A+ HTTP ${res.status} for ${path}`);
  return res.json();
}

// A+ names are bilingual: "1. |en:Recap and basic data structures|fi:Kertausta...|"
export function cleanName(s = '') {
  if (!s.includes('|')) return s.trim();
  const prefix = s.slice(0, s.indexOf('|')).trim();
  const en = /\|en:([^|]*)\|/.exec(s);
  const rest = en ? en[1] : s.replace(/\|[a-z]{2}:/g, ' ').replace(/\|/g, ' ');
  return `${prefix} ${rest}`.replace(/\s+/g, ' ').trim();
}

// submission_count is the only honest signal: `passed` is true whenever points_to_pass
// is 0, which is the default, so it reports untouched exercises as done.
export function summarise(module, pointsModule) {
  const counts = new Map((pointsModule?.exercises || []).map((e) => [e.id, e.submission_count || 0]));
  const total = module.exercises.length;
  const done = module.exercises.filter((e) => (counts.get(e.id) || 0) > 0).length;
  return { done, total, status: done === 0 ? 'not-submitted' : done === total ? 'submitted' : 'partial' };
}

// A finished course clamps every unfinished round's deadline to its end date, so an old
// self-study course dumps its whole backlog into the week it expired. Require the course
// to still be running at the end of the week we're asking about.
export function courseRuns(detail, weekEnd) {
  const from = detail.starting_time ? new Date(detail.starting_time) : null;
  const to = detail.ending_time ? new Date(detail.ending_time) : null;
  if (from && from > weekEnd) return false;
  if (to && to < weekEnd) return false;
  return true;
}

export async function fetchAplus(start, end) {
  if (!process.env.APLUS_TOKEN) return [];
  const filters = (process.env.COURSE_FILTER || '')
    .split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);

  const me = await api('/api/v2/users/me/');
  const items = [];

  for (const course of me.enrolled_courses || []) {
    if (filters.length && !filters.some((f) => (course.code || '').toLowerCase().includes(f))) continue;

    let modules;
    try {
      modules = (await api(`/api/v2/courses/${course.id}/exercises/`)).results || [];
    } catch {
      continue; // archived course we can't read; not worth failing the whole report
    }
    const due = modules.filter((m) => {
      if (!m.closing_time || m.is_hidden || !m.exercises?.length) return false;
      const t = new Date(m.closing_time);
      return t >= start && t < end;
    });
    if (!due.length) continue;

    // only worth a detail call once we know the course has candidate deadlines
    if (!courseRuns(await api(`/api/v2/courses/${course.id}/`), end)) continue;

    const points = await api(`/api/v2/courses/${course.id}/points/me/`);
    const byId = new Map((points.modules || []).map((m) => [m.id, m]));
    for (const m of due) {
      const { done, total, status } = summarise(m, byId.get(m.id));
      items.push({
        uid: 'aplus:' + m.id,
        name: `${cleanName(m.display_name)} (${done}/${total} submitted)`,
        course: course.code,
        courseName: course.name,
        dueDate: new Date(m.closing_time),
        status: status === 'partial' ? 'not-submitted' : status,
        source: 'A+',
      });
    }
  }
  return items;
}
