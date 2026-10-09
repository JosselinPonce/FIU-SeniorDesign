import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import type { NewProfileInput } from '../lib/db/repositories';
import { validateProfile, updateProfileRecord, cloudProfile, retryProfiles, type ProfileDatabase } from '../lib/db/profileEditing.ts';

const input = { display_name: '  Samantha  ', custom_id: 'SUBJ-001', age: 30, gender: 'female' as const,
  height_cm: 165, weight_kg: 65, conditions: ['asthma'], medications: ['beta_agonist'], language: 'es' as const,
  emergency_name: 'Mom', emergency_phone: '+1 (305) 555-0123' };

function fixture() {
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE driver_profiles (id TEXT PRIMARY KEY, custom_id TEXT, display_name TEXT, age INTEGER,
    gender TEXT, height_cm REAL, weight_kg REAL, conditions TEXT, medications TEXT, language TEXT,
    emergency_name TEXT, emergency_phone TEXT, created_at TEXT, updated_at TEXT, cal_hr REAL, cal_spo2 REAL, cal_at TEXT);
    CREATE TABLE drive_sessions (id TEXT PRIMARY KEY, profile_id TEXT, status TEXT);
    CREATE TABLE telemetry_events (id TEXT PRIMARY KEY, session_id TEXT, bpm REAL);
    CREATE TABLE threshold_history (id TEXT PRIMARY KEY, profile_id TEXT, high_warn REAL);
    CREATE TABLE app_settings (key TEXT PRIMARY KEY, value TEXT);
    INSERT INTO driver_profiles VALUES ('p1',NULL,'Before',30,'male',180,80,'[]','[]','en','Old','3055551111','2025-01-01','2025-01-02',2,-1,'2025-01-03');
    INSERT INTO driver_profiles SELECT 'p2',custom_id,'Other',age,gender,height_cm,weight_kg,conditions,medications,language,emergency_name,emergency_phone,created_at,updated_at,cal_hr,cal_spo2,cal_at FROM driver_profiles;
    INSERT INTO drive_sessions VALUES ('s1','p1','completed');
    INSERT INTO telemetry_events VALUES ('e1','s1',75);
    INSERT INTO threshold_history VALUES ('t1','p1',110);
    INSERT INTO app_settings VALUES ('ack:p1','{"high":115,"low":null}');`);
  const adapter: ProfileDatabase = {
    getFirstAsync: async (sql, args) => (db.prepare(sql).get(...args) ?? null) as any,
    runAsync: async (sql, args) => { const r = db.prepare(sql).run(...args); return { changes: Number(r.changes) }; },
  };
  return { db, adapter, save: async (raw: NewProfileInput = input, revision = '2025-01-02') => {
    db.exec('BEGIN');
    try { const p = await updateProfileRecord(adapter, 'p1', raw, revision); db.exec('COMMIT'); return p; }
    catch (e) { db.exec('ROLLBACK'); throw e; }
  } };
}

test('creation and editing share validation, optional contact and normalized phone', () => {
  assert.equal(validateProfile(input).emergency_phone, '+13055550123');
  assert.equal(validateProfile(input).display_name, 'Samantha');
  assert.equal(validateProfile({ display_name: 'No contact', emergency_phone: ' ' }).emergency_phone, null);
  for (const changes of [{ display_name: ' ' }, { age: 0 }, { age: 130 }, { age: 30.5 }, { age: NaN },
    { height_cm: -1 }, { height_cm: Infinity }, { weight_kg: 0 }, { weight_kg: 1000 },
    { emergency_phone: '911' }, { emergency_phone: 'abc3055550123' }, { emergency_phone: '3055550123 ext 2' }])
    assert.throws(() => validateProfile({ ...input, ...changes }));
});

test('full edit updates only existing UUID and preserves sessions, learned source data, calibration and acknowledgments', async () => {
  const f = fixture();
  try {
    const before = ['drive_sessions','telemetry_events','threshold_history'].map(t => f.db.prepare(`SELECT * FROM ${t}`).all());
    const other = f.db.prepare("SELECT * FROM driver_profiles WHERE id='p2'").get();
    const saved = await f.save();
    assert.equal(saved.id, 'p1'); assert.equal(saved.display_name, 'Samantha'); assert.equal(saved.emergency_phone, '+13055550123');
    assert.equal(saved.conditions, '["asthma"]'); assert.equal(saved.medications, '["beta_agonist"]'); assert.equal(saved.language, 'es');
    assert.equal(saved.age, 30); assert.equal(saved.gender, 'female'); assert.equal(saved.height_cm, 165); assert.equal(saved.weight_kg, 65);
    assert.equal(saved.cal_hr, 2); assert.equal(saved.cal_spo2, -1); assert.equal(saved.cal_at, '2025-01-03'); assert.equal(saved.created_at, '2025-01-01');
    assert.deepEqual(f.db.prepare("SELECT * FROM driver_profiles WHERE id='p2'").get(), other);
    assert.equal(f.db.prepare('SELECT count(*) AS n FROM driver_profiles').get()?.n, 2);
    assert.deepEqual(['drive_sessions','telemetry_events','threshold_history'].map(t => f.db.prepare(`SELECT * FROM ${t}`).all()), before);
    assert.equal(f.db.prepare("SELECT value FROM app_settings WHERE key='ack:p1'").get()?.value, '{"high":115,"low":null}');
    assert.equal(f.db.prepare("SELECT value FROM app_settings WHERE key='profile_sync:p1'").get()?.value, saved.updated_at);
  } finally { f.db.close(); }
});

test('active drive, stale revision, invalid input and removed profile cannot save or queue an edit', async () => {
  const f = fixture();
  try {
    f.db.exec("INSERT INTO drive_sessions VALUES ('active','p1','active')");
    await assert.rejects(f.save(), /End and save/);
    f.db.exec("DELETE FROM drive_sessions WHERE id='active'");
    await assert.rejects(f.save(input, 'stale'), /profile changed/);
    await assert.rejects(f.save({ ...input, age: 130 }), /Age/);
    assert.equal(f.db.prepare("SELECT display_name FROM driver_profiles WHERE id='p1'").get()?.display_name, 'Before');
    assert.equal(f.db.prepare("SELECT count(*) AS n FROM app_settings WHERE key LIKE 'profile_sync:%'").get()?.n, 0);
    f.db.exec("DELETE FROM driver_profiles WHERE id='p1'");
    await assert.rejects(f.save(), /no longer exists/);
  } finally { f.db.close(); }
});

test('failed cloud upload stays queued; retry excludes contacts and does not clear a concurrent newer edit', async () => {
  const f = fixture();
  try {
    const saved = await f.save();
    const pending = async () => [{ profile: saved, revision: saved.updated_at }];
    const acknowledge = async (id: string, revision: string) => { f.db.prepare('DELETE FROM app_settings WHERE key = ? AND value = ?').run(`profile_sync:${id}`, revision); };
    assert.deepEqual(await retryProfiles({ pending, acknowledge, upload: async () => 'offline' }), { profiles: 0, errors: ['offline'] });
    assert.ok(f.db.prepare("SELECT * FROM app_settings WHERE key='profile_sync:p1'").get());
    const payload = cloudProfile(saved);
    assert.equal('emergency_phone' in payload, false); assert.equal('emergency_name' in payload, false);
    const result = await retryProfiles({ pending, acknowledge, upload: async p => {
      assert.deepEqual(p, payload);
      f.db.prepare("UPDATE app_settings SET value='newer' WHERE key='profile_sync:p1'").run();
      return null;
    } });
    assert.equal(result.profiles, 1);
    assert.equal(f.db.prepare("SELECT value FROM app_settings WHERE key='profile_sync:p1'").get()?.value, 'newer');
  } finally { f.db.close(); }
});

test('selected refresh publishes the saved full record only after cancellation and context load', async () => {
  const { saveSelectedProfile } = await import('../lib/db/profileEditing.ts');
  const f = fixture();
  try {
    const original = await f.adapter.getFirstAsync<any>("SELECT * FROM driver_profiles WHERE id = ?", ['p1']);
    const events: string[] = [];
    let published: any;
    const context = { baseline: 'preserved', ack: 'preserved' };
    await saveSelectedProfile(original, input, {
      isCurrent: () => true, cancel: async () => { events.push('cancel'); },
      save: async (id, data, revision) => { assert.equal(id, original.id); assert.equal(revision, original.updated_at); events.push('save'); return f.save(data, revision); },
      load: async saved => { assert.equal(saved.emergency_phone, '+13055550123'); events.push('load'); return context; },
      publish: (saved, loaded) => { assert.equal(loaded, context); events.push('publish'); published = saved; },
    });
    assert.deepEqual(events, ['cancel','save','load','publish']);
    assert.equal(published.id, original.id); assert.equal(published.cal_hr, original.cal_hr);
  } finally { f.db.close(); }
});

test('active-drive gate and selection changes prevent writes or stale selected-state refresh', async () => {
  const { saveSelectedProfile } = await import('../lib/db/profileEditing.ts');
  for (const stage of ['before','cancel','load']) {
    const f = fixture();
    try {
      const original = await f.adapter.getFirstAsync<any>('SELECT * FROM driver_profiles WHERE id = ?', ['p1']);
      let current = stage !== 'before', writes = 0, publications = 0;
      await assert.rejects(saveSelectedProfile(original, input, {
        isCurrent: () => current,
        cancel: async () => { if (stage === 'cancel') current = false; },
        save: async (_id, data, revision) => { writes++; return f.save(data, revision); },
        load: async () => { current = false; return {}; },
        publish: () => { publications++; },
      }), /selected driver changed/);
      assert.equal(publications, 0); assert.equal(writes, stage === 'load' ? 1 : 0);
    } finally { f.db.close(); }
  }
});

test('editor prepopulates every saved registration field and keeps optional blanks', async () => {
  const { profileFormValues } = await import('../lib/db/profileEditing.ts');
  const f = fixture();
  try {
    const p = await f.save();
    assert.deepEqual(profileFormValues(p), {
      form: { custom_id: 'SUBJ-001', display_name: 'Samantha', age: '30', weight_kg: '65', height_cm: '165',
        emergency_name: 'Mom', emergency_phone: '+13055550123' },
      gender: 'female', conditions: ['asthma'], medications: ['beta_agonist'], language: 'es',
    });
    const optional = profileFormValues({ ...p, age: null, weight_kg: null, height_cm: null, emergency_phone: null });
    assert.equal(optional.form.age, ''); assert.equal(optional.form.weight_kg, '');
    assert.equal(optional.form.height_cm, ''); assert.equal(optional.form.emergency_phone, '');
  } finally { f.db.close(); }
});

test('editing in US and metric units persists metric values under the same UUID and keeps history', async () => {
  const units = await import('../lib/db/profileMeasurements.ts');
  const f = fixture();
  try {
    let s = units.measurementsFromMetric(180, 80);
    // Opening an imperial editor and toggling units must not alter the original metrics.
    s = units.switchHeightUnit(s, 'cm'); s = units.switchWeightUnit(s, 'kg');
    s = units.switchHeightUnit(s, 'ft/in'); s = units.switchWeightUnit(s, 'lbs');
    const unchanged = await f.save({ ...input, ...units.metricMeasurements(s) });
    assert.equal(unchanged.height_cm, 180); assert.equal(unchanged.weight_kg, 80);
    s = units.selectHeight(s, 5, 10); s = units.enterWeight(s, '150.5');
    const imperial = await f.save({ ...input, ...units.metricMeasurements(s) }, unchanged.updated_at);
    assert.ok(Math.abs(imperial.height_cm! - 177.8) < 1e-10);
    assert.ok(Math.abs(imperial.weight_kg! - 68.265651685) < 1e-10);
    s = units.switchHeightUnit(s, 'cm'); s = units.enterHeightCm(s, '175.25');
    s = units.switchWeightUnit(s, 'kg'); s = units.enterWeight(s, '72.125');
    const metric = await f.save({ ...input, ...units.metricMeasurements(s) }, imperial.updated_at);
    assert.equal(metric.height_cm, 175.25); assert.equal(metric.weight_kg, 72.125); assert.equal(metric.id, 'p1');
    assert.equal(metric.cal_hr, 2); assert.equal(f.db.prepare('SELECT count(*) AS n FROM driver_profiles').get()?.n, 2);
    assert.equal(f.db.prepare('SELECT bpm FROM telemetry_events').get()?.bpm, 75);
    assert.equal(f.db.prepare('SELECT high_warn FROM threshold_history').get()?.high_warn, 110);
    assert.equal(f.db.prepare('SELECT status FROM drive_sessions').get()?.status, 'completed');
  } finally { f.db.close(); }
});
