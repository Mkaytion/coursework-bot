// Merges every source. A source that fails is reported, never silently dropped —
// an empty "not submitted" list because the cookie died looks identical to being done.
import { fetchMoodle } from './moodle.js';
import { fetchAplus } from './aplus.js';

export async function fetchExercises(start, end) {
  const sources = { MyCourses: fetchMoodle, 'A+': fetchAplus };
  const settled = await Promise.allSettled(
    Object.values(sources).map((fn) => fn(start, end)),
  );
  const items = [];
  const errors = [];
  settled.forEach((r, i) => {
    const name = Object.keys(sources)[i];
    if (r.status === 'fulfilled') items.push(...r.value);
    else errors.push(`${name}: ${r.reason.message}`);
  });
  return { items, errors };
}
