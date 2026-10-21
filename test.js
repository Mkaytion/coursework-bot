import assert from 'node:assert/strict';
import { weekRange, weekFor, split, list } from './bot.js';
import { classify, selectEvents, title, flatten } from './moodle.js';
import { cleanName, summarise } from './aplus.js';

// --- week boundaries ---
const wed = new Date('2026-08-26T15:00:00');
assert.equal(weekRange(wed).start.getDay(), 1, 'week starts Monday');
assert.equal(weekRange(wed).start.getDate(), 24);
assert.equal(weekRange(wed).end.getDate(), 31);
assert.equal(weekRange(new Date('2026-08-30T23:00:00')).start.getDate(), 24, 'Sunday stays in its week');

// --- week-after offset ---
assert.equal(weekFor(0, wed).start.getDate(), 24, '0 = this week');
assert.equal(weekFor(1, wed).start.getDate(), 31, '1 = next week');
assert.equal(weekFor(-1, wed).start.getDate(), 17, '-1 = last week');
{
  const w = weekFor(2, wed).start;
  assert.equal(w.getMonth(), 8, 'rolls over month');
  assert.equal(w.getDate(), 7);
  assert.equal(w.getDay(), 1, 'still a Monday');
}

// --- bucketing: offline used to be reported as missing ---
const r = split([
  { name: 'a', status: 'submitted' }, { name: 'b', status: 'not-submitted' },
  { name: 'c', status: 'draft' }, { name: 'd', status: 'offline' },
  { name: 'e', status: 'offline-graded' },
]);
assert.deepEqual(r.submitted.map((x) => x.name), ['a', 'e']);
assert.deepEqual(r.missing.map((x) => x.name), ['b', 'c']);
assert.deepEqual(r.offline.map((x) => x.name), ['d'], 'offline must not be reported as missing');

// --- Moodle classifier, against text taken from real pages ---
assert.equal(classify('assign', 'Submission status Submitted for grading Grading status Graded'), 'submitted');
assert.equal(classify('assign', 'Submission status No attempt Grading status Not graded'), 'not-submitted');
assert.equal(classify('assign', 'This assignment does not require you to submit anything online Grading status Graded'), 'offline-graded');
assert.equal(classify('assign', 'This assignment does not require you to submit anything online Grading status Not graded'), 'offline');
assert.equal(classify('quiz', 'Attempts allowed: 1 Your final grade for this quiz is 1.00/1.00.'), 'submitted');
assert.equal(classify('quiz', 'Lecture 1 Opens: Tuesday, 1 September 2026 Closes: Wednesday'), 'not-submitted');

// --- Moodle course selection: this period only ---
const courses = new Map([
  [52107, { code: 'CS-A1140', title: 'Tietorakenteet ja algoritmit' }],
  [50516, { code: 'TU-A1300', title: 'Introduction to Industrial Engineering' }],
]);
const ts = (s) => Math.floor(new Date(s).getTime() / 1000);
const evs = [
  { id: 1, eventtype: 'due',   modulename: 'assign', course: { id: 52107 }, timesort: ts('2026-08-26T10:00') },
  { id: 2, eventtype: 'close', modulename: 'quiz',   course: { id: 50516 }, timesort: ts('2026-08-27T10:00') },
  { id: 3, eventtype: 'due',   modulename: 'assign', course: { id: 46398 }, timesort: ts('2026-08-26T10:00') },
  { id: 4, eventtype: 'open',  modulename: 'quiz',   course: { id: 52107 }, timesort: ts('2026-08-26T10:00') },
  { id: 5, eventtype: 'due',   modulename: 'forum',  course: { id: 52107 }, timesort: ts('2026-08-26T10:00') },
  { id: 6, eventtype: 'due',   modulename: 'assign', course: { id: 52107 }, timesort: ts('2026-09-02T10:00') },
];
const { start, end } = weekRange(wed);
assert.deepEqual(selectEvents(evs, courses, [], start, end).map((e) => e.id), [1, 2]);
assert.deepEqual(selectEvents(evs, courses, ['cs-a1140'], start, end).map((e) => e.id), [1]);

// --- course title extraction ---
assert.equal(title('COE-C2003 - Basic course on fluid mechanics, Contact teaching, 1.9.2026-16.10.2026'),
  'Basic course on fluid mechanics');
assert.equal(title('No dash here'), 'No dash here');

// --- A+ bilingual names ---
assert.equal(cleanName('1. |en:Recap and basic data structures|fi:Kertausta ja perustietorakenteita|'),
  '1. Recap and basic data structures');
assert.equal(cleanName('1.2.1 |fi:Tehtävä|en:Assignment|'), '1.2.1 Assignment');
assert.equal(cleanName('Plain round name'), 'Plain round name');

// --- A+ progress. `passed` is true whenever points_to_pass is 0, so it must be ignored. ---
const mod = { exercises: [{ id: 1 }, { id: 2 }, { id: 3 }] };
assert.deepEqual(
  summarise(mod, { exercises: [
    { id: 1, submission_count: 2, passed: true },
    { id: 2, submission_count: 0, passed: true },
    { id: 3, submission_count: 1, passed: true },
  ] }),
  { done: 2, total: 3, status: 'partial' }, 'partial progress, not "passed"');
assert.equal(summarise(mod, { exercises: [
  { id: 1, submission_count: 0, passed: true },
  { id: 2, submission_count: 0, passed: true },
  { id: 3, submission_count: 0, passed: true },
] }).status, 'not-submitted', 'untouched round is not submitted despite passed:true');
assert.equal(summarise(mod, { exercises: [
  { id: 1, submission_count: 1 }, { id: 2, submission_count: 3 }, { id: 3, submission_count: 1 },
] }).status, 'submitted');
assert.equal(summarise(mod, undefined).status, 'not-submitted', 'missing points data is not "done"');

// --- rendering: course named once per group, not per line ---
const rendered = list([
  { course: 'COE-C2003', courseName: 'Basic course on fluid mechanics', name: 'Problem 1', dueDate: new Date('2026-09-10T12:00') },
  { course: 'COE-C2003', courseName: 'Basic course on fluid mechanics', name: 'Problem 2', dueDate: new Date('2026-09-10T12:00') },
  { course: 'TU-A1300', courseName: 'Introduction to Industrial Engineering', name: 'Lecture 2 Quiz', dueDate: new Date('2026-09-07T12:00') },
]);
assert.equal(rendered.match(/COE-C2003/g).length, 1, 'course header appears once');
assert.match(rendered, /Basic course on fluid mechanics/, 'readable course name is shown');
assert.match(rendered, /• Problem 1 — Thu 10 Sep/);
assert.equal(list([]), '_nothing_');


// --- A+ course window: a finished course clamps its backlog to its end date ---
import { courseRuns } from './aplus.js';
const wkEnd = new Date('2026-09-07T00:00:00');
assert.equal(courseRuns({ starting_time: '2026-08-26', ending_time: '2026-12-31' }, wkEnd), true, 'current course');
assert.equal(courseRuns({ starting_time: '2025-08-25', ending_time: '2026-08-31' }, wkEnd), false, 'english ended 31 Aug');
assert.equal(courseRuns({ starting_time: '2025-09-02', ending_time: '2026-09-01' }, wkEnd), false, 'CS-A1141 ended 1 Sep');
assert.equal(courseRuns({ starting_time: '2027-01-01', ending_time: '2027-05-01' }, wkEnd), false, 'not started yet');
assert.equal(courseRuns({}, wkEnd), true, 'no dates = keep rather than silently drop');

// --- scheduling: next occurrence, no fixed-interval drift ---
import { nextRun, diffSnapshot } from './bot.js';
assert.equal(nextRun(8, 1, new Date('2026-08-30T12:00:00')).getDate(), 31, 'Sunday -> Monday');
assert.equal(nextRun(8, 1, new Date('2026-08-31T06:00:00')).getDate(), 31, 'Monday 06:00 -> today 08:00');
assert.equal(nextRun(8, 1, new Date('2026-08-31T09:00:00')).getDate(), 7, 'Monday 09:00 -> next Monday');
assert.equal(nextRun(18, null, new Date('2026-08-30T12:00:00')).getDate(), 30, 'daily: later today');
assert.equal(nextRun(18, null, new Date('2026-08-30T19:00:00')).getDate(), 31, 'daily: tomorrow');

// --- daily change detection ---
const snapItems = [
  { uid: 'a', course: 'X', courseName: 'X', name: 'One', dueDate: new Date('2026-09-10T12:00') },
  { uid: 'b', course: 'X', courseName: 'X', name: 'Two', dueDate: new Date('2026-09-11T12:00') },
];
const first = diffSnapshot({}, snapItems);
assert.equal(first.added.length, 2, 'all new against an empty snapshot');
assert.equal(diffSnapshot(first.next, snapItems).added.length, 0, 'unchanged fetch reports nothing');

// an A+ progress count changes the name but not the uid
const renamed = [{ ...snapItems[0], name: 'One (3/9 submitted)' }, snapItems[1]];
assert.equal(diffSnapshot(first.next, renamed).added.length, 0, 'rename is not new work');

const shifted = [{ ...snapItems[0], dueDate: new Date('2026-09-12T12:00') }, snapItems[1]];
assert.equal(diffSnapshot(first.next, shifted).moved.length, 1, 'due-date change is a move');
assert.equal(diffSnapshot(first.next, shifted).added.length, 0);

// a source failing must not drop its keys and re-announce everything on recovery
const partial = diffSnapshot(first.next, [snapItems[0]]);
assert.ok('b' in partial.next, 'absent item keeps its snapshot entry');
assert.equal(diffSnapshot(partial.next, snapItems).added.length, 0, 'recovery does not re-announce');


// --- expired-session detection: a login bounce must be named, not surface as "fetch failed" ---
import { isLoginRedirect, EXPIRED } from './moodle.js';
assert.equal(isLoginRedirect('https://mycourses.aalto.fi/login/index.php?loginredirect=1'), true);
assert.equal(isLoginRedirect('/login/index.php'), true);
assert.equal(isLoginRedirect('https://mycourses.aalto.fi/mod/assign/view.php?id=1'), false);
assert.equal(isLoginRedirect(''), false);
assert.match(EXPIRED, /MOODLE_SESSION/, 'message names the variable to fix');


// --- /session input handling ---
import { cleanCookie, looksLikeCookie, upsertEnv } from './bot.js';
assert.equal(cleanCookie('  abc123DEF456ghi789jkl012  '), 'abc123DEF456ghi789jkl012');
assert.equal(cleanCookie('MoodleSession=abc123DEF456ghi789jkl012'), 'abc123DEF456ghi789jkl012', 'strips the key');
assert.equal(cleanCookie('moodlesession = abc123DEF456ghi789jkl012;'), 'abc123DEF456ghi789jkl012', 'case and trailing ;');
assert.equal(cleanCookie('"abc123DEF456ghi789jkl012"'), 'abc123DEF456ghi789jkl012', 'strips quotes');
assert.equal(looksLikeCookie('abc123DEF456ghi789jkl012'), true);
assert.equal(looksLikeCookie('too-short'), false);
assert.equal(looksLikeCookie('has spaces in it here ok'), false);

// upsert must leave every other key alone, and add the key when absent
const env = 'DISCORD_TOKEN=aaa\nMOODLE_SESSION=old\nAPLUS_TOKEN=bbb\n';
const updated = upsertEnv(env, 'MOODLE_SESSION', 'new');
assert.equal(updated, 'DISCORD_TOKEN=aaa\nMOODLE_SESSION=new\nAPLUS_TOKEN=bbb\n');
assert.match(upsertEnv('DISCORD_TOKEN=aaa\n', 'MOODLE_SESSION', 'new'), /^DISCORD_TOKEN=aaa\nMOODLE_SESSION=new\n$/);
assert.match(upsertEnv('DISCORD_TOKEN=aaa', 'MOODLE_SESSION', 'new'), /aaa\nMOODLE_SESSION=new\n$/, 'handles missing trailing newline');


// --- quiz wording varies by course; a withheld grade shows only an attempts table ---
import { mainRegion } from './moodle.js';
assert.equal(classify('quiz', 'Re-attempt quiz Your attempts Attempt 1 summary Status Finished Started Tuesday Review'),
  'submitted', 'finished attempt with no grade line still counts');
assert.equal(classify('quiz', 'Grading method: Highest grade This quiz is currently not available.'),
  'not-submitted', 'unopened quiz');
assert.equal(classify('quiz', 'Your attempts Attempt 1 summary Status In progress Continue your attempt'),
  'not-submitted', 'started but not finished is not submitted');
assert.equal(classify('quiz', 'Attempts allowed: 1 Your final grade for this quiz is 1.00/1.00.'),
  'submitted', 'graded wording still works');

// main-region extraction: nav text must not reach the classifier, and the status row must survive
const page = '<html><nav>Submitted for grading</nav><section id="region-main">'
  + '<p>Submission status</p><p>No attempt</p></section><footer>x</footer></html>';
assert.equal(classify('assign', flatten(mainRegion(page))), 'not-submitted', 'nav must not leak in');
assert.match(flatten(mainRegion(page)), /Submission status/, 'status row survives extraction');
assert.equal(mainRegion('<html><p>no main region here</p></html>'), '<html><p>no main region here</p></html>',
  'falls back to the whole document rather than returning nothing');


// --- token-path mappers ---
import { stripMlang, assignStatus, quizStatus } from './moodle.js';
assert.equal(stripMlang('{mlang en, sv}Essay 1: SE challenges{mlang}{mlang fi}Essee{mlang}'), 'Essay 1: SE challenges');
assert.equal(stripMlang('Assignment 0'), 'Assignment 0', 'plain name untouched');
assert.equal(stripMlang('{mlang fi}Vain suomeksi{mlang}'), 'Vain suomeksi', 'no-en falls back to stripping tags');

assert.equal(assignStatus({ nosubmissions: 0 }, { lastattempt: { submission: { status: 'submitted' } } }), 'submitted');
assert.equal(assignStatus({ nosubmissions: 0 }, { lastattempt: { submission: { status: 'new' } } }), 'not-submitted');
assert.equal(assignStatus({ nosubmissions: 0 }, { lastattempt: { submission: { status: 'draft' } } }), 'draft');
assert.equal(assignStatus({ nosubmissions: 0 }, { lastattempt: {} }), 'not-submitted', 'no submission record');
assert.equal(assignStatus({ nosubmissions: 1 }, { feedback: { grade: { grade: '2.0' } } }), 'offline-graded');
assert.equal(assignStatus({ nosubmissions: 1 }, {}), 'offline');
assert.equal(assignStatus({ nosubmissions: 0 }, { lastattempt: { submissionsenabled: false } }), 'offline', 'submissionsenabled=false is offline');
assert.equal(assignStatus({ nosubmissions: 0 }, { lastattempt: { submission: { status: 'submitted' } }, feedback: { grade: { grade: '-1.00000' } } }), 'submitted', 'online submitted stays submitted even with -1 grade');

assert.equal(quizStatus([{ state: 'finished' }]), 'submitted');
assert.equal(quizStatus([{ state: 'inprogress' }]), 'not-submitted');
assert.equal(quizStatus([]), 'not-submitted', 'no attempts');

console.log('ok');
