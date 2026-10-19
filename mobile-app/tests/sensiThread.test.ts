import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AssistantConversation, type AssistantDeps, type ConversationState } from '../modules/local-foundation-models/assistantConversation.ts';
import type { OfflineTranscription } from '../modules/local-foundation-models/index.ts';
import { AudioOwnership } from '../lib/voice/audioOwnership.ts';
import { nearThreadBottom, playbackLabel } from '../lib/assistant/threadPresentation.ts';
const capture = (text: string): OfflineTranscription => ({ status: 'success', transcript: text, finalTranscript: text,
  isFinal: true, finalResultReceived: true, locale: 'en-US', requiresOnDeviceRecognition: true, reason: 'complete', message: '',
  totalTimeMs: 10, recognitionTimeMs: 10, listeningTimeMs: 8, finalizationTimeMs: 2,
  firstPartialTimeMs: 1, endpointReason: 'audio_silence', silenceTargetMs: 1300, finalizationGraceMs: 2500 });
function fixture(patch: Partial<AssistantDeps> = {}) {
  const states: ConversationState[] = []; let calls = 0;
  const deps: AssistantDeps = { mode: 'connected', prepare: async () => {}, acquire: async () => () => {},
    speak: async () => {}, listen: async () => capture('I feel comfortable and alert today.'),
    interpret: async () => ({ status: 'success', processingTimeMs: 1, interpretation: { wellness: 'ok',
      requestsSavedEmergencyContact: false, explicitContactRequest: false, advisoryOnly: true, callAuthorized: false,
      suggestedReply: "That's great to hear! Stay focused and drive safely." } }),
    handoff: async () => { calls++; return 'opened'; }, cancel: async () => {}, onChange: s => states.push(s), ...patch };
  return { deps, states, last: () => states.at(-1)!, calls: () => calls };
}
const tick = () => new Promise<void>(r => setImmediate(r));
test('thread orders opening, accepted final and reply; playback snapshots remain immutable', async () => {
  const f = fixture(); await new AssistantConversation(f.deps).start();
  assert.deepEqual(f.last().messages?.map(m => [m.role, m.text]), [['assistant', 'How are you feeling?'],
    ['driver', 'I feel comfortable and alert today.'], ['assistant', "That's great to hear! Stay focused and drive safely."]]);
  assert.deepEqual(f.states.filter(s => s.messages?.length === 1).map(s => s.messages![0]!.playback).filter((v,i,a) => v !== a[i-1]), ['pending', 'playing', 'completed']);
  assert.equal(f.last().messages?.at(-1)?.playback, 'completed'); assert.equal(f.calls(), 0);
});
test('partial speech stays provisional; final replaces it without duplicate bubbles', async () => {
  const f = fixture({ listen: async (_id, progress) => { progress('listening', 'I feel'); return capture('I feel comfortable and alert today.'); } });
  await new AssistantConversation(f.deps).start();
  assert.equal(f.states.find(s => s.transcript === 'I feel')!.messages?.some(m => m.role === 'driver'), false);
  assert.equal(f.last().transcript, ''); assert.equal(f.last().messages?.filter(m => m.role === 'driver').length, 1);
});
test('unconfirmed words never become driver messages or consent', async () => {
  const f = fixture({ listen: async () => ({ ...capture('call Mom'), status: 'incomplete', isFinal: false }) });
  await new AssistantConversation(f.deps).start();
  assert.equal(f.last().phase, 'error'); assert.equal(f.last().messages?.some(m => m.role === 'driver'), false); assert.equal(f.calls(), 0);
});
test('generation failure retains accepted speech without inventing assistant playback', async () => {
  const f = fixture({ interpret: async () => { throw new Error('generation unavailable'); } });
  await new AssistantConversation(f.deps).start();
  assert.equal(f.last().phase, 'error'); assert.equal(f.last().messages?.length, 2); assert.equal(f.last().messages?.at(-1)?.role, 'driver');
});
test('Stop interrupts opening, prevents listening, and restart resets history', async () => {
  let finish!: () => void; let listening = 0;
  const f = fixture({ speak: () => new Promise<void>(r => { finish = r; }), cancel: async () => finish(),
    listen: async () => { listening++; return capture('stop'); } });
  const c = new AssistantConversation(f.deps); const run = c.start(); await tick(); await c.stop(); await run;
  assert.equal(f.last().messages?.[0]?.playback, 'interrupted'); assert.equal(listening, 0);
  f.deps.speak = async () => {}; await c.start(); assert.deepEqual(f.last().messages?.map(m => m.text), ['How are you feeling?', 'stop']);
});
test('failed playback never reports completion or begins capture', async () => {
  let listening = 0;
  const f = fixture({ speak: async () => { throw new Error('native interruption'); }, listen: async () => { listening++; return capture('stop'); } });
  await new AssistantConversation(f.deps).start(); assert.equal(f.last().messages?.[0]?.playback, 'failed'); assert.equal(listening, 0);
});
test('safety preemption waits for cleanup without late capture or calls', async () => {
  const audio = new AudioOwnership(); let finish!: () => void; let cancelling!: () => void; let listening = 0;
  const cancelled = new Promise<void>(r => { cancelling = r; });
  const f = fixture({ acquire: stop => audio.acquire('optional', stop), speak: () => new Promise<void>(r => { finish = r; }),
    cancel: async () => { cancelling(); }, listen: async () => { listening++; return capture('call Mom'); } });
  const c = new AssistantConversation(f.deps); const run = c.start(); await tick();
  let acquired = false; const pending = audio.acquire('safety', async () => {}).then(release => { acquired = true; return release; });
  await cancelled; assert.equal(acquired, false); finish(); const release = await pending; await run;
  assert.equal(f.last().messages?.[0]?.playback, 'interrupted'); assert.equal(listening, 0); assert.equal(f.calls(), 0); release();
});
test('phone handoff status is display-only, never falsely marked as spoken', async () => {
  const f = fixture({ listen: async () => capture('call my mom'), handoff: async () => 'opened' });
  await new AssistantConversation(f.deps).start(); assert.equal(f.last().messages?.at(-1)?.role, 'system'); assert.equal(f.last().messages?.at(-1)?.playback, undefined);
});
test('scroll follow respects review position and playback copy does not claim hearing', () => {
  assert.equal(nearThreadBottom(1000, 400, 600), true); assert.equal(nearThreadBottom(1000, 400, 519), false);
  assert.match(playbackLabel('failed')!, /unconfirmed/); assert.match(playbackLabel('interrupted')!, /incomplete/); assert.equal(playbackLabel(undefined), undefined);
});
