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
  const said: string[] = [];
  let onState = (_state: SafetyState) => {};
  let onListen = () => {};
  let onSave = async () => {};
  let nextId = 0;
  let second = 0;
  const c = new SafetyController({
    voiceIO: () => ({ speak: async text => { said.push(text); }, listen: async () => { onListen(); return answers.shift() ?? null; }, cancel: () => {} }),
    save: async row => { saved.push(row); if (row.response) await onSave(); },
    saveAck: async () => {}, haptic: () => {},
    handoffContact: async number => {
      if (states.at(-1)?.last?.episode.id !== 'rehearsal')
        assert.equal(saved.at(-1)?.response, 'not_ok', 'incident saved before platform handoff');
      assert.equal(states.at(-1)?.check, null, 'dialogue closed before platform handoff');
      if (openFails) throw new Error('No phone handler');
      dialed.push(number);
    },
    onChange: state => { states.push(state); onState(state); }, newId: () => `episode-${++nextId}`,
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
  return { c, saved, dialed, states, trigger, settle, said,
    onState: (fn: (state: SafetyState) => void) => { onState = fn; },
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

test('Try the voice check opens the saved contact for direct requests and accepted offers without a drive', async () => {
  for (const direct of [true, false]) {
    const f = callController(direct ? ["No, I'm feeling dizzy, please call my mom"] : ['not okay', 'yes']);
    f.c.endSession();
    assert.equal((await f.c.rehearse()).contactCall, direct ? 'explicit_request' : 'accepted_offer');
    assert.deepEqual(f.dialed, ['+13055550123']);
    assert.equal(f.states.at(-1)?.last?.handoff, 'opened');
    assert.equal(f.said.filter(text => text.includes('Would you like')).length, direct ? 0 : 1);
    assert.deepEqual(f.saved, []);
  }
});

test('rehearsal preserves cancellation, profile and session protections at either question', async () => {
  for (const offered of [false, true]) for (const change of ['cancel', 'profile', 'end', 'start']) {
    const f = callController(offered ? ['not okay', 'yes'] : ['call my mom']);
    f.c.endSession();
    let listens = 0;
    f.onListen(() => {
      if (++listens !== (offered ? 2 : 1)) return;
      if (change === 'cancel') f.c.cancelCheck();
      if (change === 'profile') f.c.configure({ ...profile, id: 'other', emergency_phone: '2125550123' }, null);
      if (change === 'end') f.c.endSession();
      if (change === 'start') f.c.startSession('new-session');
    });
    await f.c.rehearse();
    assert.deepEqual(f.dialed, [], change);
    assert.deepEqual(f.saved, []);
  }
});

test('rehearsal rechecks cancellation immediately before platform handoff', async () => {
  const f = callController(['call my mom']);
  f.c.endSession();
  f.onState(state => {
    if (state.last?.episode.id === 'rehearsal' && !state.last.handoff) {
      f.onState(() => {});
      f.c.cancelCheck();
    }
  });
  await f.c.rehearse();
  assert.deepEqual(f.dialed, []);
});

test('rehearsal retains refusal, silence, 911 and contact validation protections', async () => {
  for (const answers of [['call 911', 'yes'], ['not okay', 'call 911', 'yes'], ['not okay', 'no'], ['not okay', null, null]]) {
    const f = callController(answers);
    f.c.endSession();
    await f.c.rehearse();
    f.c.answer('call_yes');
    assert.deepEqual(f.dialed, []);
    assert.deepEqual(f.saved, []);
  }
  for (const phone of [null, '911', 'invalid']) {
    const f = callController(['call my mom'], phone);
    await f.c.rehearse();
    assert.deepEqual(f.dialed, []);
    assert.equal(f.states.at(-1)?.last?.handoff, phone ? 'invalid_phone' : 'missing_contact');
  }
});

test('rehearsal reports native handoff failure without recording an incident', async () => {
  const f = callController(['call my mom'], '3055550123', true);
  f.c.endSession();
  await f.c.rehearse();
  assert.equal(f.states.at(-1)?.last?.handoff, 'open_failed');
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

function assistantFixture(phone: string | null = '+1 (305) 555-0123', fail = false) {
  const dialed: string[] = [], saved: unknown[] = [];
  const c = new SafetyController({ voiceIO: () => ({ speak: async () => {}, listen: async () => null, cancel: () => {} }),
    handoffContact: async phone => { if (fail) throw new Error('Unavailable'); dialed.push(phone); },
    save: async row => { saved.push(row); }, saveAck: async () => {}, haptic: () => {}, onChange: () => {}, newId: () => 'unused' });
  c.configure({ ...profile, emergency_phone: phone }, null);
  return { c, dialed, saved };
}
test('assistant reuses direct and offered consent without recording or learning an incident', async () => {
  for (const [text, offered] of [["No, I'm feeling dizzy, please call Mom", false], ['yes please', true]] as const) {
    const f = assistantFixture();
    assert.equal(await f.c.assistantContact(text, offered, () => true), 'opened');
    assert.deepEqual(f.dialed, ['+13055550123']); assert.equal(f.saved.length, 0);
  }
});
test('assistant refuses ambiguous, negated, out-of-context and emergency-service consent', async () => {
  for (const [text, offered] of [['yes', false], ['maybe call Mom', true], ['do not call Mom', true], ['call 911', true], ['no thanks', true]] as const) {
    const f = assistantFixture();
    assert.equal(await f.c.assistantContact(text, offered, () => true), 'not_authorized'); assert.equal(f.dialed.length, 0);
  }
});
test('assistant validates contacts and visibly reports handoff failure', async () => {
  for (const [phone, expected] of [[null, 'missing_contact'], ['911', 'invalid_phone'], ['abc', 'invalid_phone']] as const) {
    const f = assistantFixture(phone);
    assert.equal(await f.c.assistantContact('call Mom', false, () => true), expected); assert.equal(f.dialed.length, 0);
  }
  assert.equal(await assistantFixture('+13055550123', true).c.assistantContact('call Mom', false, () => true), 'open_failed');
});
test('assistant cancellation and profile changes at the final ownership check revoke handoff', async () => {
  const f = assistantFixture();
  assert.equal(await f.c.assistantContact('call Mom', false, () => false), 'cancelled');
  let checks = 0;
  assert.equal(await f.c.assistantContact('call Mom', false, () => {
    if (++checks === 2) f.c.configure({ ...profile, id: 'different', emergency_phone: '+12125550123' }, null);
    return true;
  }), 'cancelled');
  assert.equal(f.dialed.length, 0);
});

test('conversation ownership is captured before async work and revoked by session/profile changes', async () => {
  for (const change of ['cancel', 'profile', 'session', 'end']) {
    const f = assistantFixture(); const owner = f.c.assistantOwnership(); assert.equal(owner(), true);
    if (change === 'cancel') f.c.cancelCheck();
    if (change === 'profile') f.c.configure({ ...profile, id: 'other' }, null);
    if (change === 'session') f.c.startSession('new');
    if (change === 'end') f.c.endSession();
    assert.equal(owner(), false);
    assert.equal(await f.c.assistantContact('call Mom', false, owner), 'cancelled'); assert.equal(f.dialed.length, 0);
  }
});

test('same-UUID profile edit revokes old assistant consent and refreshes its validated contact', async () => {
  const f = assistantFixture();
  const oldOwner = f.c.assistantOwnership();
  const ack = { high: 115, low: null };
  f.c.refreshProfile({ ...profile, display_name: 'Updated Driver', updated_at: '2026-10-08', emergency_phone: '+12125550123' }, null, ack);
  assert.equal(oldOwner(), false);
  assert.equal(await f.c.assistantContact('yes please', true, oldOwner), 'cancelled');
  assert.deepEqual(f.dialed, []);
  assert.equal(await f.c.assistantContact('call my mom', false, f.c.assistantOwnership()), 'opened');
  assert.deepEqual(f.dialed, ['+12125550123']);
  assert.deepEqual(f.saved, []);
});

test('existing safety workflow uses edited contact and revokes an in-flight old contact check', async () => {
  const f = callController(['call my mom']);
  f.c.endSession();
  f.c.refreshProfile({ ...profile, emergency_phone: '+12125550123' }, null, { high: null, low: null });
  await f.c.rehearse();
  assert.deepEqual(f.dialed, ['+12125550123']);
  const stale = callController(['call my mom']);
  stale.c.endSession();
  stale.onState(state => {
    if (state.check?.phase === 'speaking') {
      stale.onState(() => {});
      stale.c.refreshProfile({ ...profile, emergency_phone: '+12125550123' }, null, { high: null, low: null });
    }
  });
  await stale.c.rehearse();
  assert.deepEqual(stale.dialed, []);
});

test('profile refresh applies existing health calculations and keeps prior acknowledgments', () => {
  const f = callController([]);
  f.c.endSession();
  const ack = { high: 115, low: 48 };
  f.c.refreshProfile({ ...profile, age: 68, conditions: '["copd","arrhythmia"]', emergency_phone: null }, null, ack);
  const state = f.states.at(-1)!;
  assert.deepEqual(state.ack, ack);
  assert.equal(state.prior?.knownArrhythmia, true);
  assert.notEqual(state.prior?.spo2Baseline, null);
  assert.ok(state.prior?.explain.some(x => x.includes('age 68')));
});

test('SafetyController independently validates the newly supported direct request variants', async () => {
  for (const text of ['Can you call my mum?', "I'm a little dizzy, can you call my mom for me please?"]) {
    const f = assistantFixture();
    assert.equal(await f.c.assistantContact(text, false, f.c.assistantOwnership()), 'opened');
    assert.deepEqual(f.dialed, ['+13055550123']);
  }
  for (const text of ['Do not call my mum', 'Maybe call my mum', 'If I feel dizzy call my mum', '"Call my mum"', 'Call my mum or 911']) {
    const f = assistantFixture();
    assert.equal(await f.c.assistantContact(text, false, f.c.assistantOwnership()), 'not_authorized');
    assert.deepEqual(f.dialed, []);
  }
});

test('assistant contact availability exposes only validated status, not the phone number', () => {
  assert.equal(assistantFixture().c.assistantContactAvailability(), 'available');
  assert.equal(assistantFixture(null).c.assistantContactAvailability(), 'missing_contact');
  assert.equal(assistantFixture('911').c.assistantContactAvailability(), 'invalid_phone');
});
