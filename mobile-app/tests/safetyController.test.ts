import { test } from 'node:test';
import assert from 'node:assert/strict';

import { SafetyController, contactPhone, type SafetyState } from '../lib/analysis/safetyController.ts';
import type { VoiceIO } from '../lib/voice/voiceCheck.ts';

const profile = {
  id: 'p1', custom_id: null, display_name: 'Luis Test', weight_kg: 80, age: 30, height_cm: 180, gender: 'male' as const,
  created_at: '', updated_at: '', conditions: '[]', medications: '[]', language: 'en',
};

function controller(answer: string | null) {
  const saved: unknown[] = [];
  const acks: unknown[] = [];
  const states: SafetyState[] = [];
  const io: VoiceIO = { speak: async () => {}, listen: async () => answer, cancel: () => {} };
  const c = new SafetyController({
    voiceIO: () => io,
    save: async (r) => void saved.push(r),
    saveAck: async (_p, a) => void acks.push(a),
    haptic: () => {},
    onChange: (s) => void states.push(s),
    newId: () => Math.random().toString(36).slice(2),
  });
  c.configure(profile, null, { high: null, low: null });
  return { c, saved, acks, states };
}

test('demo: fabricated high heart rate → warning flag → emergency → voice check; nothing saved or learned', async () => {
  const { c, saved, acks, states } = controller("yeah i'm fine");
  const r = await c.simulate('high_critical');
  assert.equal(r?.outcome, 'ok');
  assert.ok(states.some((s) => s.tracking !== null), 'warning flag shown');
  assert.ok(states.some((s) => s.check?.phase === 'listening'), 'voice check listened');
  assert.deepEqual([saved.length, acks.length], [0, 0]);
  assert.equal(states[states.length - 1]!.demo, null);
});

test('demo: low oxygen with silence → no response', async () => {
  const { c } = controller(null);
  const r = await c.simulate('spo2');
  assert.equal(r?.outcome, 'no_response');
});


function callController(answers: (string | null)[], phone: string | null = '+1 (305) 555-0123', openFails = false) {
  const saved: { id: string; kind: string; response: string | null; session_id: string }[] = [];
  const dialed: string[] = [];
  const states: SafetyState[] = [];
  let onListen = () => {};
  let onSave = async () => {};
  let nextId = 0;
  let second = 0;
  const c = new SafetyController({
    voiceIO: () => ({ speak: async () => {}, listen: async () => { onListen(); return answers.shift() ?? null; }, cancel: () => {} }),
    save: async row => { saved.push(row); if (row.response) await onSave(); },
    saveAck: async () => {}, haptic: () => {},
    handoffContact: async number => {
      assert.equal(saved.at(-1)?.response, 'not_ok', 'incident saved before platform handoff');
      assert.equal(states.at(-1)?.check, null, 'dialogue closed before platform handoff');
      if (openFails) throw new Error('No phone handler');
      dialed.push(number);
    },
    onChange: state => { states.push(state); }, newId: () => `episode-${++nextId}`,
  });
  c.configure({ ...profile, emergency_phone: phone, emergency_name: 'Mom' }, null);
  c.startSession('session-1');
  const trigger = (spo2 = 98) => {
    for (let n = 0; n < 30 && !states.at(-1)?.check; n++, second++) {
      c.onFrame({ version: 3, rateHz: 0, quality: 90, seq: second, startMs: 0, endMs: 0,
        heartRate: 155, spo2, flags: 15, samples: [], finger: true, usable: true, raw: new Uint8Array() },
        new Date(100000 + second * 1000), 0);
    }
    assert.ok(states.at(-1)?.check, 'real engine triggered dialogue');
  };
  const settle = async () => { for (let n = 0; n < 10; n++) await new Promise<void>(r => setImmediate(r)); };
  return { c, saved, dialed, states, trigger, settle,
    onListen: (fn: () => void) => { onListen = fn; }, onSave: (fn: () => Promise<void>) => { onSave = fn; } };
}

test('real explicit request and accepted offer hand off once after incident resolution', async () => {
  for (const answers of [['call my mom'], ['not okay', 'please do']]) {
    const f = callController(answers);
    f.trigger(); await f.settle();
    assert.deepEqual(f.dialed, ['+13055550123']);
    assert.equal(f.states.at(-1)?.last?.handoff, 'opened');
    assert.equal(f.states.at(-1)?.last?.episode.stage, 'resolved');
  }
});

test('declined, negated, 911 and unanswered requests do not dial', async () => {
  for (const answers of [['not okay', 'no thanks'], ["don't call my mom", 'no thanks'], ['call 911', 'call 911', null], ['not okay', null, null]]) {
    const f = callController(answers);
    f.trigger(); await f.settle();
    assert.deepEqual(f.dialed, []);
  }
});

test('rehearsal never opens the phone interface', async () => {
  const f = callController(['call my mom']);
  assert.equal((await f.c.rehearse()).contactCall, 'explicit_request');
  assert.deepEqual(f.dialed, []);
  assert.deepEqual(f.saved, []);
});

test('demo with explicit consent never opens the phone interface', async () => {
  const f = callController(['call my mom']);
  assert.equal((await f.c.simulate('high_critical'))?.contactCall, 'explicit_request');
  assert.deepEqual(f.dialed, []);
  assert.deepEqual(f.saved, []);
});

test('phone opening failure is visible and the incident stays recorded', async () => {
  const f = callController(['call my mom'], '3055550123', true);
  f.trigger(); await f.settle();
  assert.equal(f.states.at(-1)?.last?.handoff, 'open_failed');
  assert.equal(f.saved.at(-1)?.response, 'not_ok');
});

test('profile or session changes during dialogue cancel the handoff', async () => {
  for (const change of ['profile', 'end', 'new-session']) {
    const f = callController(['call my mom']);
    f.onListen(() => {
      if (change === 'profile') f.c.configure({ ...profile, id: 'other', emergency_phone: '2125550123' }, null);
      else if (change === 'end') f.c.endSession();
      else f.c.startSession('session-2');
    });
    f.trigger(); await f.settle();
    assert.deepEqual(f.dialed, [], change);
  }
});

test('profile change while persistence is pending also cancels handoff', async () => {
  const f = callController(['call my mom']);
  f.onSave(async () => { f.c.configure({ ...profile, id: 'other', emergency_phone: '2125550123' }, null); });
  f.trigger(); await f.settle();
  assert.deepEqual(f.dialed, []);
  assert.equal(f.saved.at(-1)?.session_id, 'session-1');
});

test('incident uses its captured contact, not a later same-profile contact update', async () => {
  const f = callController(['call my mom']);
  f.onSave(async () => { f.c.configure({ ...profile, emergency_phone: '2125550123' }, null); });
  f.trigger(); await f.settle();
  assert.deepEqual(f.dialed, ['+13055550123']);
});

test('missing and invalid contacts surface a result without opening the dialer', async () => {
  for (const phone of [null, '', '911', '+911', '112', '999', 'abc3055550123', '3055550123 ext 2']) {
    const f = callController(['call my mom'], phone);
    f.trigger(); await f.settle();
    assert.deepEqual(f.dialed, []);
    assert.equal(f.states.at(-1)?.last?.handoff, phone ? 'invalid_phone' : 'missing_contact');
    assert.equal(contactPhone(phone).phone, null);
  }
});

test('911 at either dialogue stage permanently prevents automatic handoff despite later yes', async () => {
  for (const answers of [['call 911', 'yes'], ['not okay', 'call 911', 'yes']]) {
    const f = callController(answers);
    f.trigger(); await f.settle();
    f.c.answer('call_yes'); // even a late affirmative button cannot revive this conversation
    await f.settle();
    assert.deepEqual(f.dialed, []);
    assert.equal(f.states.at(-1)?.last?.result.contactCall, 'emergency_services');
    assert.equal(f.saved.at(-1)?.response, 'not_ok');
    assert.deepEqual(answers, ['yes'], 'excluded branch ends without consuming later consent');
  }
});

test('rollover and unmount-equivalent teardown revoke consent while incident save is pending', async () => {
  for (const rollover of [true, false]) {
    const f = callController(['call my mom']);
    let finishSave!: () => void;
    f.onSave(() => new Promise<void>(resolve => { finishSave = resolve; }));
    f.trigger(); await f.settle();
    assert.ok(finishSave, 'dialogue has finished and incident persistence is pending');
    f.c.endSession(); // same immediate invalidation used by rollover and hook cleanup
    if (rollover) f.c.startSession('replacement-session');
    const statesAfterTeardown = f.states.length;
    finishSave(); await f.settle();
    assert.deepEqual(f.dialed, []);
    assert.equal(f.states.length, statesAfterTeardown, 'no old UI update after teardown');
    assert.equal(f.saved.at(-1)?.session_id, 'session-1');
  }
});

test('cancelling an active call offer preserves NOT OK on the original incident only', async () => {
  for (const change of ['profile', 'rollover', 'unmount']) {
    const f = callController(['not okay', 'yes']);
    let listens = 0;
    let statesAfterChange = 0;
    f.onListen(() => {
      if (++listens !== 2) return;
      if (change === 'profile') f.c.configure({ ...profile, id: 'other', emergency_phone: '2125550123' }, null);
      else {
        f.c.endSession();
        if (change === 'rollover') f.c.startSession('replacement-session');
      }
      statesAfterChange = f.states.length;
    });
    f.trigger();
    const episodeId = f.states.at(-1)?.check?.episode.id;
    await f.settle();
    assert.equal(listens, 2);
    assert.deepEqual(f.dialed, []);
    const resolved = f.saved.filter(row => row.response !== null);
    assert.equal(resolved.length, 1);
    assert.deepEqual([resolved[0]!.id, resolved[0]!.session_id, resolved[0]!.response], [episodeId, 'session-1', 'not_ok']);
    assert.equal(f.states.length, statesAfterChange, 'cancelled result must not enter new session UI');
  }
});

test('simultaneous HR and oxygen episodes have separate, correctly owned dialogues', async () => {
  const f = callController(['call my mom', 'yes I am okay']);
  f.trigger(85);
  const first = f.states.at(-1)!.check!.episode;
  assert.equal(first.kind, 'bpm_high');
  await f.settle();
  assert.equal(f.states.at(-1)?.last?.episode.id, first.id);
  assert.equal(f.saved.find(row => row.id === first.id && row.response !== null)?.response, 'not_ok');
  assert.deepEqual(f.dialed, ['+13055550123']);
  f.trigger(85); // queued oxygen track gets its own check after HR resolves
  const secondEpisode = f.states.at(-1)!.check!.episode;
  assert.equal(secondEpisode.kind, 'spo2_low');
  assert.notEqual(secondEpisode.id, first.id);
  await f.settle();
  assert.equal(f.saved.find(row => row.id === secondEpisode.id && row.response !== null)?.response, 'ok');
  assert.deepEqual(f.dialed, ['+13055550123'], 'one incident answer must not authorize two handoffs');
});
