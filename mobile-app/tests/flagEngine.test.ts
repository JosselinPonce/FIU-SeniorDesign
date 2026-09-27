import { test } from 'node:test';
import assert from 'node:assert/strict';

import { FlagEngine, thresholds, type EngineEvent, type Reading } from '../lib/analysis/flagEngine.ts';
import { bmi, personalBand, profilePrior, news2Pulse, news2Spo2 } from '../lib/analysis/profileModel.ts';

let n = 0;
const id = () => `e${++n}`;
const T0 = 1_800_000_000_000;

const adult = profilePrior({ age: 30, sex: 'male', weight_kg: 80, height_cm: 180, conditions: [], medications: [] });
const band0 = personalBand(adult, null);

test('simultaneous confirmations queue behind their owner and cannot resolve by a different ID', () => {
  const e = engine();
  const events = run(e, 0, 20, () => ({ bpm: 155, spo2: 85 }));
  const confirmed = events.filter(event => event.type === 'emergency');
  assert.equal(confirmed.length, 1);
  const first = confirmed[0]!.episode;
  assert.equal(first.kind, 'bpm_high');
  assert.equal(e.resolve('ok', T0 + 20_000, 'wrong-episode'), null);
  assert.equal(e.pending?.id, first.id);
  assert.equal(e.resolve('not_ok', T0 + 20_000, first.id)?.id, first.id);
  const next = run(e, 21, 1, () => ({ bpm: 155, spo2: 85 })).find(event => event.type === 'emergency');
  assert.equal(next?.episode.kind, 'spo2_low');
  assert.notEqual(next?.episode.id, first.id);
});

function engine(prior = adult, band = band0) {
  return new FlagEngine(thresholds(prior, band), id);
}

/** Feed `seconds` readings from `from`, value from fn(i); returns events with their second. */
function run(e: FlagEngine, from: number, seconds: number, fn: (i: number) => Partial<Reading>) {
  const out: (EngineEvent & { at: number })[] = [];
  for (let i = 0; i < seconds; i += 1) {
    const r: Reading = { t: T0 + (from + i) * 1000, bpm: 75, spo2: 98, quality: 85, finger: true, ...fn(i) };
    for (const ev of e.feed(r)) out.push({ ...ev, at: from + i });
  }
  return out;
}

test('profile prior follows Avram 2019 coefficients', () => {
  assert.equal(bmi(80, 180), 24.7);
  const f = profilePrior({ age: 25, sex: 'female', weight_kg: 95, height_cm: 165, conditions: ['diabetes'], medications: [] });
  // 80.2 (21-30) + 2.14 (female) + 0.21*(34.9-27.5) + 4.48 (diabetes)
  assert.ok(Math.abs(f.hrMean - (80.2 + 2.14 + 0.21 * (34.9 - 27.5) + 4.48)) < 0.11, String(f.hrMean));
  assert.equal(f.hrMax, Math.round(208 - 0.7 * 25));
  assert.deepEqual([news2Pulse(40), news2Pulse(45), news2Pulse(75), news2Pulse(100), news2Pulse(120), news2Pulse(131)], [3, 1, 0, 1, 2, 3]);
  assert.deepEqual([news2Spo2(91, 1), news2Spo2(93, 1), news2Spo2(95, 1), news2Spo2(96, 1), news2Spo2(89, 2), news2Spo2(83, 2)], [3, 2, 1, 0, 0, 3]);
});

test('normal driving with noise: no flags', () => {
  const e = engine();
  const ev = run(e, 0, 600, (i) => ({ bpm: 72 + ((i * 7) % 9) - 4, spo2: 97 + (i % 3) - 1 }));
  assert.deepEqual(ev.map((x) => x.type), []);
});

test('isolated artifact spikes are rejected, never flagged', () => {
  const e = engine();
  const ev = run(e, 0, 300, (i) => ({ bpm: i % 9 === 0 ? 170 : 74 }));
  assert.deepEqual(ev.map((x) => x.type), []);
  assert.ok(e.rejected > 20);
});

test('sustained critical heart rate: warning flag, then emergency within ~8 s of confirmation', () => {
  const e = engine();
  run(e, 0, 30, () => ({ bpm: 75 }));
  const ev = run(e, 30, 40, () => ({ bpm: 142 }));
  const w = ev.find((x) => x.type === 'warning' || x.type === 'escalated');
  const em = ev.find((x) => x.type === 'emergency');
  assert.ok(w && em, JSON.stringify(ev.map((x) => [x.type, x.at])));
  assert.ok(em!.at - w!.at <= 12, `warning ${w!.at} -> emergency ${em!.at}`);
  assert.equal(em!.episode.kind, 'bpm_high');
  assert.equal(em!.episode.level, 'critical');
});

test('warning-level heart rate needs the longer 15 s confirmation', () => {
  const e = engine();
  run(e, 0, 30, () => ({ bpm: 75 }));
  const ev = run(e, 30, 60, () => ({ bpm: 118 }));
  const w = ev.find((x) => x.type === 'warning')!;
  const em = ev.find((x) => x.type === 'emergency')!;
  assert.ok(em.at - w.at >= 14 && em.at - w.at <= 17, `${w.at} -> ${em.at}`);
  assert.equal(em.episode.level, 'warning');
});

test('a short burst that recovers is cleared, not an emergency', () => {
  const e = engine();
  run(e, 0, 30, () => ({ bpm: 75 }));
  const ev = run(e, 30, 40, (i) => ({ bpm: i < 8 ? 125 : 78 }));
  assert.ok(ev.some((x) => x.type === 'warning'));
  assert.ok(!ev.some((x) => x.type === 'emergency'));
  const c = ev.find((x) => x.type === 'cleared')!;
  assert.equal(c.episode.outcome, 'recovered');
});

test('poor signal cannot confirm: closed as unconfirmed after 60 s', () => {
  const e = engine();
  run(e, 0, 30, () => ({ bpm: 75 }));
  const ev = run(e, 30, 90, (i) => (i < 6 ? { bpm: 125 } : i % 2 ? { bpm: 125 } : { finger: false, bpm: null }));
  assert.ok(!ev.some((x) => x.type === 'emergency'), JSON.stringify(ev.map((x) => [x.type, x.at])));
  assert.equal(ev.find((x) => x.type === 'cleared')?.episode.outcome, 'unconfirmed');
});

test('personal baseline: an athlete at 47 bpm is fine, the general profile only notices', () => {
  const athleteBand = personalBand(adult, { readings: 6000, sessions: 12, bpmMedian: 50, bpmP10: 45, bpmP90: 56 });
  const a = engine(adult, athleteBand);
  assert.deepEqual(run(a, 0, 300, () => ({ bpm: 47 })).map((x) => x.type), []);
  const g = engine();
  const ev = run(g, 0, 300, () => ({ bpm: 42 }));
  assert.ok(!ev.some((x) => x.type === 'emergency'));
});

test('low SpO2: a typical driver is critical at ≤91 and warned at 93', () => {
  const e = engine();
  run(e, 0, 20, () => ({}));
  const ev = run(e, 20, 30, () => ({ spo2: 89 }));
  assert.equal(ev.find((x) => x.type === 'emergency')?.episode.kind, 'spo2_low');
  const w = engine();
  assert.ok(run(w, 0, 60, () => ({ spo2: 93 })).some((x) => x.type === 'emergency'));
});

test('COPD (Little 1999): normal 93 % is not flagged; a fall of more than 4 points is', () => {
  const copd = profilePrior({ age: 68, sex: 'male', weight_kg: 80, height_cm: 175, conditions: ['copd'], medications: [] });
  assert.equal(copd.spo2Baseline, 93.9);
  const th = thresholds(copd, personalBand(copd, null));
  assert.deepEqual([th.spo2Notice, th.spo2Warn, th.spo2Crit], [90, 89, 85]);
  const c = new FlagEngine(th, id);
  assert.deepEqual(run(c, 0, 300, (i) => ({ spo2: 92 + (i % 3) })).map((x) => x.type), []); // 92-94: their normal
  const ev = run(c, 300, 40, () => ({ spo2: 88 }));
  assert.equal(ev.find((x) => x.type === 'emergency')?.episode.level, 'warning');
  // Once their own baseline is known (say 96 %), the line follows it: > 4 below = ≤ 91.
  const own = thresholds(copd, personalBand(copd, null), 96);
  assert.equal(own.spo2Warn, 91);
});

test('after "I\'m OK" the same warning stays quiet for 5 min, but a worse level re-arms', () => {
  const e = engine();
  run(e, 0, 20, () => ({}));
  const first = run(e, 20, 40, () => ({ bpm: 118 }));
  assert.ok(first.some((x) => x.type === 'emergency'));
  e.resolve('ok', T0 + 60_000);
  const quiet = run(e, 60, 120, () => ({ bpm: 118 }));
  assert.ok(!quiet.some((x) => x.type === 'emergency' || x.type === 'warning'));
  const worse = run(e, 180, 30, () => ({ bpm: 145 }));
  assert.ok(worse.some((x) => x.type === 'emergency'));
});

test('hands off the wheel for 15 s: no-contact notice, never an emergency', () => {
  const e = engine();
  run(e, 0, 10, () => ({}));
  const ev = run(e, 10, 40, () => ({ finger: false, bpm: null, spo2: null }));
  assert.deepEqual(ev.map((x) => [x.type, x.episode.kind]), [['notice', 'no_contact']]);
});

test('"I\'m OK" feedback moves a warning line, within safe limits', () => {
  const base = thresholds(adult, band0);
  const moved = thresholds(adult, band0, null, { high: 118 + 5, low: null });
  assert.equal(moved.highWarn, 123);
  assert.equal(moved.highCrit, 131); // critical never moves
  assert.equal(thresholds(adult, band0, null, { high: 160, low: null }).highWarn, 125); // capped
  assert.equal(thresholds(adult, band0, null, { high: null, low: 30 }).lowWarn, 43); // floored
  assert.equal(thresholds(adult, band0, null, { high: 80, low: null }).highWarn, base.highWarn); // never lowers
  // After adapting, a sustained 118 is no longer an emergency, but 140 still is.
  const e = new FlagEngine(moved, id);
  run(e, 0, 20, () => ({}));
  assert.ok(!run(e, 20, 60, () => ({ bpm: 118 })).some((x) => x.type === 'emergency'));
  assert.ok(run(e, 80, 30, () => ({ bpm: 140 })).some((x) => x.type === 'emergency'));
});

test('the profile sets the starting warning line (Avram 2019 age-group 95th percentile)', () => {
  const line = (p: Partial<Parameters<typeof profilePrior>[0]>) => {
    const pr = profilePrior({ age: 30, sex: null, weight_kg: null, height_cm: null, conditions: [], medications: [], ...p });
    return thresholds(pr, personalBand(pr, null)).highWarn;
  };
  assert.equal(line({ age: 30 }), 110);
  assert.equal(line({ age: 50 }), 100);
  assert.equal(line({ age: 70 }), 95);
  assert.ok(line({ age: 70, sex: 'female' }) > line({ age: 70, sex: 'male' }), 'women run ~4 bpm higher');
  assert.ok(line({ age: 50, conditions: ['diabetes'] }) > line({ age: 50 }), 'diabetes raises the usual rate');
  assert.equal(line({ age: 25, sex: 'female', conditions: ['diabetes', 'sleep_apnea'] }), 111); // never past NEWS2 "2"
  assert.equal(line({ age: 85, sex: 'male', weight_kg: 50, height_cm: 185 }), 91); // never below a clinically normal rate
  const afib = profilePrior({ age: 60, sex: 'male', weight_kg: null, height_cm: null, conditions: ['arrhythmia'], medications: [] });
  assert.equal(afib.knownArrhythmia, true);
});
