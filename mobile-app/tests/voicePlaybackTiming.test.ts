import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { URL as NodeURL } from 'node:url';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { AudioOwnership } from '../lib/voice/audioOwnership.ts';

const source = (path: string) => readFileSync(new NodeURL(path, import.meta.url), 'utf8');

test('duplicate safety cleanup cannot deactivate a later optional speech owner', async () => {
  const text = source('../lib/voice/speechIO.ts');
  const fn = text.slice(text.indexOf('export function releaseAudio()'), text.indexOf('export function phoneVoiceIO()'));
  const audio = new AudioOwnership(); const release = await audio.acquire('safety', async () => {});
  let first!: () => void, second!: () => void, deactivations = 0, waits = 0;
  const pending = [new Promise<void>(r => { first = r; }), new Promise<void>(r => { second = r; })];
  const harness = new Function('waitForSpeechIdle', 'Platform', 'ExpoSpeechRecognitionModule', 'responsivenessProbe', 'initialRelease', `
    let releaseSafetyAudio = initialRelease;
    let safetyReleasePending = Promise.resolve();
    let cleanupFailed = false;
    let safetyOwner = {};
    ${fn.replace('export function', 'function')}
    return { releaseAudio, pending: () => safetyReleasePending };
  `)(() => pending[waits++], { OS: 'ios' }, { setAudioSessionActiveIOS() { deactivations++; } }, () => () => {}, release);
  harness.releaseAudio(); harness.releaseAudio();
  first(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(deactivations, 1); assert.equal(audio.available, true);
  const releaseOptional = await audio.acquire('optional', async () => {});
  second(); await harness.pending();
  assert.equal(deactivations, 1, 'stale cleanup must not touch the new audio session');
  assert.equal(audio.available, false); releaseOptional();
});

test('native completion requires start, didFinish identity and idle; never treats cancellation as success', { skip: process.platform !== 'darwin' }, () => {
  const swift = source('../modules/local-foundation-models/ios/LocalSpeechPlayback.swift');
  const state = swift.split('// BEGIN PLAYBACK COMPLETION STATE:')[1]?.split('// END PLAYBACK COMPLETION STATE')[0];
  assert.ok(state);
  const definition = state.slice(state.indexOf('struct LocalPlaybackCompletion'));
  const directory = mkdtempSync(join(tmpdir(), 'sensi-playback-timing-'));
  try {
    const script = join(directory, 'completion.swift');
    writeFileSync(script, `${definition}
      var state = LocalPlaybackCompletion()
      assert(!state.permitsSuccess(isSpeaking: false, isPaused: false))
      state.started()
      assert(!state.permitsSuccess(isSpeaking: true, isPaused: false))
      assert(!state.permitsSuccess(isSpeaking: false, isPaused: true))
      assert(state.permitsSuccess(isSpeaking: false, isPaused: false))
      print("passed")
    `);
    assert.match(execFileSync('xcrun', ['swift', '-module-cache-path', join(directory, 'cache'), script], { encoding: 'utf8' }), /passed/);
  } finally { rmSync(directory, { recursive: true, force: true }); }
  const finish = swift.split('didFinish utterance:')[1]?.split('didCancel utterance:')[0];
  assert.match(finish ?? '', /current.utterance === utterance/);
  assert.match(finish ?? '', /completion.permitsSuccess/);
  assert.match(finish ?? '', /playback_completion_unconfirmed/);
  const cancellation = swift.split('didCancel utterance:')[1]?.split('private func finish')[0];
  assert.match(cancellation ?? '', /current.stopCode \?\? "cancelled"/);
  assert.match(swift, /operation = nil\s+current.continuation.resume/);
  const recognizer = source('../modules/local-foundation-models/ios/OfflineSpeechDiagnostic.swift');
  assert.match(recognizer, /guard !LocalSpeechPlayback.shared.isBusy/);
});
