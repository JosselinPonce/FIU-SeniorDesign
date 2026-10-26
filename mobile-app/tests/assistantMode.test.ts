import { recognitionEvidence } from '../lib/voice/coreRecognition.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { URL as NodeURL } from 'node:url';
import { assistantModeSettings, ASSISTANT_MODE_KEY, ASSISTANT_MODES, snapshotAssistantLaunch, routeAssistantLaunch } from './retired-ai/lib/assistant/mode.ts';
import { SafetyController, type SafetyState } from '../lib/analysis/safetyController.ts';

function settings() {
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE app_settings (key TEXT PRIMARY KEY, value TEXT)');
  const store = {
    getSetting: async (key: string) => (db.prepare('SELECT value FROM app_settings WHERE key = ?').get(key)?.value as string | undefined) ?? null,
    setSetting: async (key: string, value: string) => {
      db.prepare('INSERT INTO app_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);
    },
  };
  return { db, store, modes: assistantModeSettings(store) };
}

test('existing installations default to Local AI and selections persist in app_settings', async () => {
  const f = settings();
  try {
    await f.store.setSetting('storage_mode', 'full');
    await f.store.setSetting('voice:en', 'preferred-voice');
    assert.equal(await f.modes.load(), 'local');
    for (const { key } of ASSISTANT_MODES) {
      await f.modes.save(key);
      assert.equal(await assistantModeSettings(f.store).load(), key === 'connected' ? 'local' : key);
      assert.equal(await f.store.getSetting(ASSISTANT_MODE_KEY), key);
    }
    assert.equal(await f.store.getSetting('storage_mode'), 'full');
    assert.equal(await f.store.getSetting('voice:en'), 'preferred-voice');
    await f.store.setSetting(ASSISTANT_MODE_KEY, 'unknown');
    assert.equal(await f.modes.load(), 'local');
    await assert.rejects(f.modes.save('unknown' as any), /Invalid Assistant Mode/);
  } finally { f.db.close(); }
});

test('storage failures are reported rather than silently selecting another mode', async () => {
  const modes = assistantModeSettings({
    getSetting: async () => { throw new Error('read failed'); },
    setSetting: async () => { throw new Error('write failed'); },
  });
  await assert.rejects(modes.load(), /read failed/);
  await assert.rejects(modes.save('core'), /write failed/);
});

test('Core routes to existing tools, Local routes to its assistant, Connected invokes nothing', () => {
  const calls: string[] = [];
  const routes = { coreTools: () => { calls.push('core-tools'); }, local: () => { calls.push('local'); } };
  for (const { key } of ASSISTANT_MODES) routeAssistantLaunch(snapshotAssistantLaunch(key), routes);
  assert.deepEqual(calls, ['core-tools', 'local']);
  assert.equal(snapshotAssistantLaunch('connected').destination, 'unavailable');
  assert.match(ASSISTANT_MODES.find(m => m.key === 'connected')!.title, /Legacy \/ inactive/);
});

test('an interaction snapshot remains Local after the stored mode changes and contains no consent', async () => {
  const f = settings();
  try {
    const interaction = snapshotAssistantLaunch(await f.modes.load());
    await f.modes.save('core');
    assert.equal(interaction.mode, 'local');
    assert.ok(Object.isFrozen(interaction));
    assert.deepEqual(Object.keys(interaction).sort(), ['destination', 'mode']);
    assert.equal(snapshotAssistantLaunch(await f.modes.load()).destination, 'core-tools');
    const calls: string[] = [];
    routeAssistantLaunch(interaction, { coreTools: () => { calls.push('core'); }, local: () => { calls.push('local'); } });
    assert.deepEqual(calls, ['local']);
  } finally { f.db.close(); }
});

test('mode-aware safety presentation never invokes a model or reads model output for safety decisions', () => {
  for (const path of ['lib/hooks/useDriveSession.ts', 'lib/analysis/safetyController.ts', 'lib/voice/voiceCheck.ts', 'lib/voice/speechIO.ts']) {
    const source = readFileSync(new NodeURL(`../${path}`, import.meta.url), 'utf8');
    assert.doesNotMatch(source, /phoneAssistantProvider|connectedAssistantProvider|\.generate\(|functions\.invoke\(|interpretConversation\(/, path);
  }
});

test('each persisted mode leaves real frame-triggered warning, incident and threshold behavior intact', { timeout: 5000 }, async () => {
  const f = settings();
  try {
    let reference: unknown;
    for (const { key } of ASSISTANT_MODES) {
      await f.modes.save(key);
      const saved: { response: string | null; session_id: string }[] = [];
      const acks: unknown[] = [];
      const spoken: string[] = [];
      const states: SafetyState[] = [];
      let resolve!: () => void;
      const done = new Promise<void>(r => { resolve = r; });
      const controller = new SafetyController({
        assistantMode: () => key,
        voiceIO: () => ({ speak: async text => { spoken.push(text); }, listen: async (_l, _m, _h, id) => recognitionEvidence(id, { status: 'success', transcript: "I'm fine", finalTranscript: "I'm fine", isFinal: true, finalResultReceived: true }), cancel: () => {} }),
        save: async row => { saved.push(row); }, saveAck: async (_, ack) => { acks.push(ack); },
        haptic: () => {}, newId: () => 'episode',
        onChange: state => { states.push(state); if (state.last) resolve(); },
      });
      controller.configure({ id: 'p1', custom_id: null, display_name: 'Luis Test', weight_kg: 80, age: 30,
        height_cm: 180, gender: 'male', created_at: '', updated_at: '', language: 'en' }, null);
      controller.startSession('session-1');
      for (let n = 0; n < 40 && !states.at(-1)?.check; n++) {
        controller.onFrame({ version: 3, rateHz: 0, quality: 90, seq: n, startMs: 0, endMs: 0,
          heartRate: 155, spo2: 98, flags: 15, samples: [], finger: true, usable: true, raw: new Uint8Array() },
        new Date(100000 + n * 1000), 0);
      }
      await done;
      assert.ok(states.some(s => s.tracking));
      assert.ok(states.some(s => s.check?.phase === 'listening'));
      assert.ok(saved.some(row => row.response === 'ok' && row.session_id === 'session-1'));
      const outcome = { spoken, acks, thresholds: states.at(-1)?.th, result: states.at(-1)?.last?.result };
      if (reference) assert.deepEqual(outcome, reference);
      else reference = outcome;
    }
  } finally { f.db.close(); }
});
