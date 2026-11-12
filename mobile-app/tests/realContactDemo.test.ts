import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SafetyController, type SafetyState } from '../lib/analysis/safetyController.ts';
import { recognitionEvidence } from '../lib/voice/coreRecognition.ts';
import { RealContactDemoPermit } from '../lib/voice/realContactDemo.ts';
import { openAuthorizedPhoneInterface, openConfirmedDemoPhoneInterface } from '../lib/voice/phoneHandoff.ts';
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
const profile = { id: 'fixture', custom_id: 'KEEP-INTERNAL', display_name: 'Test Driver', language: 'en', emergency_name: 'Saved contact',
  emergency_phone: '+12025550124', updated_at: 'revision-one', created_at: '', age: 30, gender: 'female' as const, height_cm: 165, weight_kg: 65 };
function fixture(answers: (string | null)[], phone: string | null = profile.emergency_phone, incomplete = false, manual = false, automatic = false, beforeHandoff?: () => void) {
  let foreground = true;
  const states: SafetyState[] = [], opened: string[] = [], saved: unknown[] = [], learned: unknown[] = [];
  const c = new SafetyController({ demoSystemConfirmation: automatic, interactionCurrent: () => foreground, assistantMode: () => 'local',
    voiceIO: () => ({ speak: async () => {}, cancel() {}, listen: async (_l, _m, _h, id) => {
      if (manual) return new Promise<never>(() => {});
      const text = answers.shift(); return text == null ? null : recognitionEvidence(id, { status: incomplete ? 'incomplete' : 'success',
        transcript: text, finalTranscript: incomplete ? '' : text, isFinal: !incomplete, finalResultReceived: !incomplete });
    } }),
    handoffContact: async () => { throw Error('simulation must not enter live handoff'); },
    handoffDemoContact: (phone, authorize) => { beforeHandoff?.(); return openConfirmedDemoPhoneInterface(phone, authorize, () => foreground, async url => { opened.push(url); }); },
    save: async row => { saved.push(row); }, saveAck: async (...row) => { learned.push(row); },
    haptic() {}, onChange: state => states.push(state), newId: () => 'real-engine' });
  c.configure({ ...profile, emergency_phone: phone }, null);
  return { c, states, opened, saved, learned, last: () => states.at(-1)!, background() { foreground = false; c.setMonitoringContext(false, false, true); } };
}
async function simulate(t: any, f: ReturnType<typeof fixture>, opted = true, onStep?: () => void) {
  let done = false; const pending = f.c.simulate('high_critical', opted).finally(() => { done = true; });
  for (let i = 0; i < 180 && !done; i++) { t.mock.timers.tick(250); await tick(); onStep?.(); }
  assert.equal(done, true); return pending;
}
test('demo permit is once-only, expires and revokes even after conditions recover', () => {
  let now = 0, current = true;
  const p = new RealContactDemoPermit(() => current, 30, () => now);
  current = false; assert.equal(p.claim(), false); current = true; assert.equal(p.claim(), true); assert.equal(p.claim(), false);
  const expired = new RealContactDemoPermit(() => true, 30, () => now); now = 30; assert.equal(expired.claim(), false);
  const revoked = new RealContactDemoPermit(() => true, 100, () => now); revoked.revoke(); assert.equal(revoked.claim(), false);
});
test('opt-in and genuine consent only prepare a contact; final confirmation opens once and never saves simulated health', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const f = fixture(['no', 'yes']); const result = await simulate(t, f);
  assert.equal(result?.contactCall, 'accepted_offer'); assert.equal(f.opened.length, 0);
  const pending = f.last().pendingDemoContact!; assert.equal(pending.phone, profile.emergency_phone);
  assert.equal(f.last().conversation?.simulation, true);
  await Promise.all([f.c.confirmRealContactDemo(pending.confirmationId), f.c.confirmRealContactDemo(pending.confirmationId)]);
  assert.deepEqual(f.opened, [`tel:${profile.emergency_phone}`]);
  assert.deepEqual(f.saved, []); assert.deepEqual(f.learned, []); assert.equal(f.last().pendingDemoContact, null);
});
for (const mode of ['ordinary', 'refusal', 'silent', 'ambiguous', 'incomplete'] as const) test(`${mode}: no real-contact authorization`, async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const answers = mode === 'refusal' ? ['no', 'no'] : mode === 'silent' ? [] : mode === 'ambiguous' ? ['no','perhaps','maybe'] : ['no','yes'];
  const f = fixture(answers, profile.emergency_phone, mode === 'incomplete');
  await simulate(t, f, mode !== 'ordinary');
  assert.equal(f.last().pendingDemoContact ?? null, null); assert.equal(f.opened.length, 0);
  assert.equal(await f.c.confirmRealContactDemo('demo-forged'), 'cancelled');
  assert.deepEqual(f.saved, []); assert.deepEqual(f.learned, []);
});
for (const interruption of ['background', 'cancel', 'contact_change', 'recording', 'timeout', 'dismiss'] as const) test(`final demo confirmation revoked on ${interruption}`, async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const f = fixture(['no', 'yes']); await simulate(t, f); const pending = f.last().pendingDemoContact!;
  if (interruption === 'background') f.background();
  if (interruption === 'cancel') f.c.cancelCheck();
  if (interruption === 'contact_change') f.c.configure({ ...profile, emergency_phone: '+12025550125', updated_at: 'revision-two' }, null);
  if (interruption === 'recording') f.c.setRecordingSession('real-recording');
  if (interruption === 'timeout') t.mock.timers.tick(30001);
  if (interruption === 'dismiss') f.c.dismissSafetyConversation(pending.episodeId);
  assert.equal(await f.c.confirmRealContactDemo(pending.confirmationId), 'cancelled'); assert.deepEqual(f.opened, []);
});
test('missing/invalid contacts cannot opt in; no fictional fallback; live boundary still blocks all simulation provenance', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  for (const phone of [null, '911', 'invalid']) {
    const f = fixture(['no','yes'], phone); assert.equal(await f.c.simulate('high_critical', true), null); assert.equal(f.opened.length, 0);
  }
  const f = fixture(['no','yes']); f.c.setRecordingSession('recording');
  assert.equal(await f.c.simulate('high_critical', true), null);
  const calls: string[] = [];
  for (const source of ['demo','rehearsal'] as const) await assert.rejects(openAuthorizedPhoneInterface(profile.emergency_phone,
    { source, episodeId: 'demo-test' }, () => true, async url => { calls.push(url); }));
  await assert.rejects(openConfirmedDemoPhoneInterface('911', () => true, () => true, async url => { calls.push(url); }));
  assert.deepEqual(calls, []);
});

test('a genuine sensor warning revokes pending demo authorization before any phone action', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const f = fixture(['no','yes']); f.c.setMonitoringContext(true, true, true);
  await simulate(t, f); const pending = f.last().pendingDemoContact!; assert.ok(pending);
  for (let i = 0; i < 30; i++) f.c.onFrame({ version: 3, rateHz: 0, quality: 90, seq: i, startMs: 0, endMs: 0,
    heartRate: 155, spo2: 98, flags: 15, samples: [], finger: true, usable: true, raw: new Uint8Array() }, new Date(100000 + i * 1000), 0);
  assert.equal(await f.c.confirmRealContactDemo(pending.confirmationId), 'cancelled'); assert.deepEqual(f.opened, []);
  f.c.cancelCheck();
});

test('an old confirmation cannot authorize a new opted-in run', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const answers = ['no','yes','no','yes']; const f = fixture(answers);
  await simulate(t, f); const first = f.last().pendingDemoContact!;
  await simulate(t, f); const second = f.last().pendingDemoContact!;
  assert.notEqual(first.confirmationId, second.confirmationId);
  assert.equal(await f.c.confirmRealContactDemo(first.confirmationId), 'cancelled');
  assert.deepEqual(f.opened, []);
  assert.equal(await f.c.confirmRealContactDemo(second.confirmationId), 'requested');
  assert.deepEqual(f.opened, [`tel:${profile.emergency_phone}`]);
});

for (const channel of ['button', 'typed'] as const) test(`${channel}: scoped manual consent still requires final demo confirmation`, async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const f = fixture([], profile.emergency_phone, false, true); const seen = new Set<string>();
  const result = await simulate(t, f, true, () => {
    const check = f.last().check;
    if (!check || seen.has(check.captureId)) return;
    seen.add(check.captureId);
    const scope = { episodeId: check.episode.id, question: check.question, captureId: check.captureId };
    const accepted = channel === 'button' ? f.c.answer(check.question === 'wellness' ? 'not_ok' : 'call_yes', scope)
      : f.c.answerText(check.question === 'wellness' ? 'no' : 'yes', scope);
    assert.equal(accepted, true);
  });
  assert.equal(result?.contactCall, 'accepted_offer'); assert.deepEqual(f.opened, []);
  assert.equal(await f.c.confirmRealContactDemo(f.last().pendingDemoContact!.confirmationId), 'requested');
  assert.deepEqual(f.opened, [`tel:${profile.emergency_phone}`]);
});

for (const mode of ['accepted', 'ordinary', 'refusal', 'ambiguous', 'partial', 'direct_request'] as const)
  test(`system-confirmed automatic demo handoff: ${mode}`, async t => {
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
    const answers = mode === 'direct_request' ? ['call my mom'] : mode === 'refusal' ? ['no','no'] : mode === 'ambiguous' ? ['no','maybe','maybe'] : ['no','yes'];
    const f = fixture(answers, profile.emergency_phone, mode === 'partial', false, true);
    await simulate(t, f, mode !== 'ordinary');
    assert.deepEqual(f.opened, mode === 'accepted' ? [`tel:${profile.emergency_phone}`] : []);
    assert.equal(f.last().pendingDemoContact ?? null, null);
    assert.deepEqual(f.saved, []); assert.deepEqual(f.learned, []);
    if (mode === 'accepted') {
      assert.equal(f.last().last?.handoff, 'opened');
      assert.equal(await f.c.confirmRealContactDemo('already-consumed'), 'cancelled');
    }
  });
for (const interruption of ['background', 'cancel', 'driver', 'contact', 'expiry'] as const)
  test(`automatic demo boundary rechecks ${interruption} before consuming consent`, async t => {
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
    let f!: ReturnType<typeof fixture>;
    f = fixture(['no','yes'], profile.emergency_phone, false, false, true, () => {
      if (interruption === 'background') f.background();
      if (interruption === 'cancel') f.c.cancelCheck();
      if (interruption === 'driver') f.c.configure({ ...profile, id: 'other-driver' }, null);
      if (interruption === 'contact') f.c.configure({ ...profile, emergency_phone: '+12025550125', updated_at: 'next' }, null);
      if (interruption === 'expiry') t.mock.timers.tick(30001);
    });
    await simulate(t, f); assert.deepEqual(f.opened, []); assert.equal(f.last().pendingDemoContact ?? null, null);
  });

test('automatic enabled preference creates a new one-use permit for each run; consumed IDs cannot be reused', async t => {
  t.mock.timers.enable({ apis: ['setTimeout','Date'] });
  const f = fixture(['no','yes','no','yes'],profile.emergency_phone,false,false,true);
  await simulate(t,f); const first = f.states.find(s => s.pendingDemoContact)?.pendingDemoContact!;
  assert.ok(first); assert.equal(await f.c.confirmRealContactDemo(first.confirmationId),'cancelled');
  await simulate(t,f); assert.equal(f.opened.length,2);
  const ids = new Set(f.states.flatMap(s => s.pendingDemoContact ? [s.pendingDemoContact.confirmationId] : [])); assert.equal(ids.size,2);
  assert.deepEqual(f.saved,[]); assert.deepEqual(f.learned,[]);
});
