import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { URL as NodeURL } from 'node:url';
import ts from 'typescript';
import { createAskSensiClient } from '../lib/assistant/askSensiClient.ts';

function load(path: string, dependencies: Record<string, unknown>) {
  const source = readFileSync(new NodeURL('../lib/db/' + path, import.meta.url), 'utf8');
  const { outputText } = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } });
  const exports: Record<string, any> = {};
  new Function('require', 'exports', outputText)((name: string) => {
    assert.ok(name in dependencies, `Unexpected dependency: ${name}`);
    return dependencies[name];
  }, exports);
  return exports;
}

const profile = { STANDALONE_DEMO: true, TELEMETRY_HOLD_KEY: 'hold' };
const forbidden = () => { throw Error('Telemetry work must not run'); };

test('standalone rejects every shared transport operation while Ask Sensi authenticates separately', async () => {
  const telemetry = load('telemetryPolicy.ts', { '../buildProfile': profile, './database': { getDatabase: forbidden } });
  const transport = telemetry.guardTelemetryFetch(forbidden);
  for (const [method, path] of [
    ['GET', '/rest/v1/drive_sessions'], ['POST', '/rest/v1/driver_profiles'],
    ['PATCH', '/rest/v1/telemetry_events'], ['DELETE', '/rest/v1/drive_sessions'],
    ['GET', '/storage/v1/object/session-archives/example.ppga'],
    ['POST', '/storage/v1/object/session-archives/example.ppga'],
    ['DELETE', '/storage/v1/object/session-archives'],
  ]) {
    await assert.rejects(transport('https://demo.invalid' + path, { method }), /synchronization is disabled/);
  }
  assert.equal(await telemetry.resumeTelemetry(), false);

  let requests = 0;
  const ask = createAskSensiClient({ url: 'https://demo.invalid/', publicKey: 'publishable-fixture',
    fetcher: async (url, init) => {
      requests++;
      assert.equal(url, 'https://demo.invalid/functions/v1/ask-sensi');
      assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer synthetic-auth-token');
      assert.equal(JSON.parse(String(init?.body)).context, null);
      return Response.json({ version: 1, kind: 'ask_sensi', status: 'ok', code: 'advisory',
        advisoryOnly: true, callAuthorized: false, message: 'DriveSense uses a steering-wheel sensor.' });
    },
  });
  const authority = { credential: { userId: 'demo-account', revision: 1, token: 'synthetic-auth-token' }, enabled: true, active: true, sharingApproved: false };
  const general = { version: 1, kind: 'ask_sensi', requestId: '11111111-1111-4111-8111-111111111111',
    topic: 'help', question: 'How does DriveSense work?', context: null } as const;
  assert.deepEqual(await ask(general, () => ({ ...authority, credential: null }), new AbortController().signal), { ok: false, error: 'auth' });
  assert.equal((await ask(general, () => authority, new AbortController().signal)).ok, true);
  assert.equal(requests, 1);
});

test('ordinary builds keep the demo sync hold until explicit resumption', async () => {
  let hold: string | null = 'true';
  const db = { getFirstAsync: async () => hold ? { value: hold } : null, runAsync: async () => { hold = null; } };
  const telemetry = load('telemetryPolicy.ts', { '../buildProfile': { ...profile, STANDALONE_DEMO: false }, './database': { getDatabase: async () => db } });
  assert.equal(await telemetry.telemetryMode(), 'held');
  assert.equal(await telemetry.telemetryAllowed(), false);
  assert.equal(await telemetry.resumeTelemetry(), true);
  assert.equal(await telemetry.telemetryAllowed(), true);
});

test('demo profile, live, catch-up and queued deletion services stop before cloud work', async () => {
  const gate = { telemetryAllowed: async () => false };
  const database = { getDatabase: forbidden };
  const supabase = { supabase: { from: forbidden, storage: { from: forbidden } } };
  const serializer = { serializeCloudWrite: (callback: () => unknown) => callback() };
  const dependencies = {
    '../buildProfile': profile, './telemetryPolicy': gate, '../supabase': supabase, './database': database,
    './cloudWrites': serializer, './profileEditing': {}, './repositories': {},
  };
  const live = load('liveSync.ts', { ...dependencies, '../archive/archiveStore': { archiveBytes: forbidden } });
  const uploader = new live.LiveUploader(forbidden, forbidden);
  uploader.follow('synthetic-drive');
  uploader.nudge();
  await uploader.finish('synthetic-drive');
  uploader.stop();
  assert.equal(uploader.status.lastError, null);
  assert.equal(uploader.status.bytesSent, 0);
  const { syncProfiles } = load('profileSync.ts', dependencies);
  assert.deepEqual(await syncProfiles(), { profiles: 0, errors: [] });
  const deletion = load('deletion.ts', { ...dependencies, '../onboarding/driverProgress': {}, './liveSync': live,
    './repositories': { getSetting: forbidden, setSetting: forbidden } });
  assert.equal(await deletion.processPendingDeletes(), 0);
  const { syncToSupabase } = load('sync.ts', { ...dependencies, './liveSync': live,
    './profileSync': { syncProfiles: forbidden }, './deletion': { processPendingDeletes: forbidden } });
  assert.deepEqual(await syncToSupabase(), { profiles: 0, sessions: 0, events: 0, errors: [] });
});

test('local drive deletion leaves existing cloud deletion entries and other sync statuses untouched', async () => {
  const existingQueue = JSON.stringify([{ table: 'drive_sessions', id: 'already-queued', files: ['already-queued.ppga'] }]);
  const settings = new Map([['pending_deletes', existingQueue]]);
  const drives = new Map([['remove-locally', 'synced'], ['keep-synced', 'synced'], ['keep-local', 'local']]);
  const tx = {
    getFirstAsync: async () => ({ status: 'ended', storage_mode: 'full' }),
    runAsync: async (sql: string, [id]: string[]) => {
      assert.doesNotMatch(sql, /app_settings|sync_status/);
      if (sql.startsWith('DELETE FROM drive_sessions')) drives.delete(id);
    },
  };
  const database = { getDatabase: async () => ({ withExclusiveTransactionAsync: async (callback: (db: typeof tx) => Promise<void>) => callback(tx) }) };
  const deletion = load('deletion.ts', {
    '../buildProfile': profile, './telemetryPolicy': { telemetryAllowed: async () => false },
    '../supabase': { supabase: { from: forbidden, storage: { from: forbidden } } },
    './database': database, './profileEditing': {}, '../onboarding/driverProgress': {}, './liveSync': {},
    './cloudWrites': { serializeCloudWrite: (callback: () => unknown) => callback() },
    './repositories': { getSetting: (key: string) => settings.get(key), setSetting: forbidden },
  });
  assert.equal(await deletion.deleteDriveEverywhere('remove-locally', 'synthetic-driver'), 'local');
  assert.equal(await deletion.processPendingDeletes(), 0);
  assert.equal(await deletion.pendingDeleteCount(), 1);
  assert.deepEqual([...drives], [['keep-synced', 'synced'], ['keep-local', 'local']]);
  assert.equal(settings.get('pending_deletes'), existingQueue);
});
