import { fetchExercises } from './scraper.js';
import { weekFor, split } from './bot.js';

for (const [label, weeks] of [['week 0', 0], ['week +1', 1], ['week +2', 2]]) {
  const { start, end } = weekFor(weeks);
  const { items, errors } = await fetchExercises(start, end);
  const { submitted, missing, offline } = split(items);
  console.log(`\n${label} (${start.toDateString()} -> ${new Date(end - 1).toDateString()}): ${items.length} deadlines`);
  if (errors.length) console.log(`  !! ${errors.join(' | ')}`);
  console.log(`  submitted ${submitted.length} | not submitted ${missing.length} | offline ${offline.length}`);
  for (const e of items) console.log(`  [${e.source}] [${e.status}] ${e.course} — ${e.name}`);
}
