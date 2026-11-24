import * as driverProgress from '../lib/onboarding/driverProgress.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { URL as NodeURL } from 'node:url';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { createRequire } from 'node:module';
import ts from 'typescript';
import * as baseline from '../lib/analysis/baseline.ts';
import * as stats from '../lib/analysis/stats.ts';
import { light, dark, presentationColors } from '../lib/theme/tokens.ts';
import { liveBaselineHeartRate } from '../lib/ui/dashboard.ts';
import { recordedVitalPoints } from '../lib/ui/recordedVitals.ts';

const require = createRequire(import.meta.url);
function load(path: string, deps: Record<string, unknown>, expose = '') {
  const source = readFileSync(new NodeURL(`../${path}`, import.meta.url), 'utf8');
  const compiled = ts.transpileModule(source + expose, { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX,
  } }).outputText;
  deps = { '../buildProfile': { STANDALONE_DEMO: false }, '../lib/buildProfile': { STANDALONE_DEMO: false }, './telemetryPolicy': { telemetryAllowed: async () => true }, ...deps };
  const exports: any = {};
  new Function('require', 'exports', compiled)((name: string) => {
    assert.ok(name in deps, name);
    return deps[name];
  }, exports);
  return exports;
}

test('phone SQLite baseline counts unique qualifying finished-drive telemetry and survives reopening', async t => {
  const folder = mkdtempSync(join(tmpdir(), 'drivesense-analytics-'));
  const path = join(folder, 'readings.db');
  let db = new DatabaseSync(path);
  t.after(() => { db.close(); rmSync(folder, { recursive: true, force: true }); });
  db.exec(`
    CREATE TABLE drive_sessions (id TEXT PRIMARY KEY, profile_id TEXT, status TEXT);
    CREATE TABLE telemetry_events (
      id TEXT PRIMARY KEY, session_id TEXT, sequence_number INTEGER, event_type TEXT,
      bpm REAL, spo2 REAL, signal_quality REAL, battery REAL, received_at TEXT, raw_payload TEXT,
      sync_status TEXT, finger INTEGER, quality REAL, hr_beats REAL, sqi_good INTEGER,
      template_r REAL, perfusion REAL, skewness REAL
    );
    CREATE UNIQUE INDEX idx_telemetry_session_sequence
      ON telemetry_events (session_id, sequence_number) WHERE sequence_number IS NOT NULL;
    CREATE TABLE drive_alerts (session_id TEXT, started_at TEXT, responded_at TEXT, prompted_at TEXT, response TEXT, escalated INTEGER);
    INSERT INTO drive_sessions VALUES ('recording', 'alice', 'active'), ('other', 'bob', 'completed'), ('interrupted', 'alice', 'interrupted');
  `);
  let id = 0;
  const storage = { getAllAsync: async (sql: string, args: SQLInputValue[]) => db.prepare(sql).all(...args),
    runAsync: async (sql: string, args: SQLInputValue[]) => db.prepare(sql).run(...args) };
  const repo = load('lib/db/repositories.ts', {
    '../onboarding/driverProgress': driverProgress,
    './database': { getDatabase: async () => storage },
    './profileEditing': {}, '../util/json': {}, '../analysis/baseline': baseline, '../analysis/stats': stats,
    '../ble/protocol': { uuidv4: () => `reading-${++id}` },
  });
  const start = Date.now() - 8 * 3600_000;
  const frame = (seq: number, usable = true) => ({ seq, usable, finger: usable, heartRate: 72, spo2: 97, version: 3, quality: 80 });
  const store = (sessionId: string, seq: number, usable = true, good?: boolean) =>
    repo.storeFrame(sessionId, frame(seq, usable), new Date(start + seq * 1000), false, good === undefined ? null : { good });

  for (let i = 0; i < 59; i++) await store('recording', i);
  assert.equal(await store('recording', 0), 'duplicate');
  await store('recording', 60, false);
  await store('recording', 61, true, false);
  await store('interrupted', 0);
  await store('other', 0);
  assert.equal((await repo.driverBaseline('alice')).readings, 0);
  db.exec("UPDATE drive_sessions SET status = 'completed' WHERE id = 'recording'");
  assert.equal((await repo.driverBaseline('alice')).readings, 59);
  assert.equal((await repo.driverBaseline('alice')).established, false);
  assert.equal((await repo.driverBaseline('bob')).readings, 1);

  await store('recording', 62);
  db.close();
  db = new DatabaseSync(path);
  const learned = await repo.driverBaseline('alice');
  assert.equal(learned.readings, baseline.BASELINE_MIN_READINGS);
  assert.equal(learned.established, true);
  assert.equal(learned.bpmMedian, 72);
  assert.equal(learned.spo2Median, 97);
  assert.equal(await store('recording', 62), 'duplicate');

  const window = await repo.recordedVitals('alice', 'recording', start + 59_000, start + 63_000);
  const points = recordedVitalPoints(window, start + 59_000, 4);
  assert.deepEqual(points.heart.map(point => point.v), [null, null, 72, 72]);
  assert.deepEqual(points.oxygen.map(point => point.v), [null, null, 97, 97]);
  assert.deepEqual((await repo.recordedVitals('alice', 'missing', start, start + 60_000)), []);
});

function baselineView(theme: typeof light, fontScale = 1) {
  let result: unknown;
  let deps: unknown[] = [];
  let cleanup: (() => void) | undefined;
  let onAppState: ((state: string) => void) | undefined;
  const pending: { driver: string; finish: (value: baseline.Baseline) => void; fail: () => void }[] = [];
  const ui = load('components/PersonalizedBaseline.tsx', {
    react: {
      useState: () => [result, (value: unknown) => { result = typeof value === 'function' ? value(result) : value; }],
      useEffect: (effect: () => () => void, values: unknown[]) => {
        if (values.some((v, i) => deps[i] !== v) || values.length !== deps.length) {
          cleanup?.();
          deps = values;
          cleanup = effect();
        }
      },
    },
    'react/jsx-runtime': require('react/jsx-runtime'),
    'react-native': { View: 'View', StyleSheet: { hairlineWidth: 1 }, useWindowDimensions: () => ({ width: 390, fontScale }), AppState: { addEventListener: (_: string, listener: typeof onAppState) => {
      onAppState = listener;
      return { remove() { onAppState = undefined; } };
    } } },
    '../lib/analysis/baseline': baseline, '../lib/i18n/native': { LocalizedText: 'Text' },
    '../lib/theme/ThemeProvider': { useTheme: () => ({ tokens: theme }) },
    '../lib/db/repositories': { driverBaseline: (driver: string) => new Promise<baseline.Baseline>((resolve, reject) => {
      pending.push({ driver, finish: resolve, fail: reject });
    }) },
    './SettingsGroup': { SettingsGroup: 'SettingsGroup' },
    './ui': { fmtNum: (v: number) => String(v), Pill: 'Pill', SectionTitle: 'Heading' },
  });
  const nodes = (node: any): any[] => !node || typeof node !== 'object' ? [] : Array.isArray(node)
    ? node.flatMap(nodes) : [node, ...nodes(node.props.children)];
  return {
    pending,
    activate: () => onAppState?.('active'),
    render: (driverId?: string, savedDriveRevision = 0, liveBpm: number | null = null, recording = true) =>
      nodes(ui.PersonalizedBaseline({ driverId, savedDriveRevision, liveBpm, recording })),
  };
}

for (const theme of [light, dark]) test(`baseline progress uses saved readings and respects driver changes in ${theme === light ? 'light' : 'dark'} theme`, async () => {
  const view = baselineView(theme);
  const status = (nodes: any[]) => nodes.find(n => n.type === 'Pill').props.children;
  const progress = (nodes: any[]) => nodes.find(n => n.props?.accessibilityRole === 'progressbar');
  assert.equal(status(view.render()), 'Unavailable');
  assert.equal(status(view.render('alice')), 'Loading…');
  view.pending.at(-1)!.finish(baseline.computeBaseline([], [], 0));
  await Promise.resolve();
  assert.equal(status(view.render('alice')), 'Not started');
  assert.equal(progress(view.render('alice')).props.accessibilityValue.now, 0);

  assert.equal(status(view.render('alice', 1)), 'Loading…');
  view.pending.at(-1)!.finish(baseline.computeBaseline(Array(36).fill(70), [], 1));
  await Promise.resolve();
  const learning = view.render('alice', 1);
  assert.equal(status(learning), 'Collecting readings');
  assert.equal(learning.some(node => node.props?.children === 'Usual heart-rate range'), false);
  assert.equal(progress(learning).props.children.props.style.width, '60%');
  assert.equal(progress(learning).props.children.props.style.backgroundColor, theme.connected);

  view.activate();
  const earlierDriver = view.pending.at(-1)!;
  assert.equal(status(view.render('bob')), 'Loading…');
  earlierDriver.finish(baseline.computeBaseline(Array(62).fill(70), [], 1));
  await Promise.resolve();
  assert.equal(status(view.render('bob')), 'Loading…');
  view.pending.at(-1)!.finish(baseline.computeBaseline(Array(62).fill(84), [], 1));
  await Promise.resolve();
  const established = view.render('bob');
  assert.equal(status(established), 'Ready');
  assert.equal(established.find(node => node.type === 'Heading').props.children, 'Your Personalized Baseline');
  assert.ok(established.some(node => node.props?.children === 'Typical SpO₂ (estimate)'));
  assert.ok(established.some(node => node.props?.children === 'Unavailable'));
  assert.ok(established.some(node => node.props?.children === '62'));
  assert.ok(established.some(node => node.props?.children === '100% complete'));
  assert.equal(progress(view.render('bob')).props.accessibilityValue.now, baseline.BASELINE_MIN_READINGS);

  view.activate();
  view.pending.at(-1)!.fail();
  await Promise.resolve();
  assert.equal(status(view.render('bob')), 'Could not load');
  assert.equal(progress(view.render('bob')), undefined);
});

test('live comparison requires an active drive and a current, reliable heart-rate reading', () => {
  const input = { bpm: 82, lastRx: new Date(10_000), connected: true, active: true, reliable: true, now: 12_999 };
  assert.equal(liveBaselineHeartRate(input), 82);
  for (const override of [
    { now: 13_000 }, { now: 9_999 }, { bpm: null }, { bpm: NaN }, { lastRx: null },
    { connected: false }, { active: false }, { reliable: false },
  ]) assert.equal(liveBaselineHeartRate({ ...input, ...override }), null);
});

test('ready baseline compares live heart rate only while its own snapshot is current', async () => {
  const ui = baselineView(dark, 1.6);
  ui.render('alice');
  ui.pending[0]!.finish(baseline.computeBaseline(Array(80).fill(80), [98], 2));
  await Promise.resolve();
  const has = (nodes: any[], text: string) => nodes.some(node => node.props?.children === text);
  assert.ok(has(ui.render('alice', 0, 80), 'Within your usual range'));
  assert.ok(has(ui.render('alice', 0, 81), 'Above your usual range'));
  assert.ok(has(ui.render('alice', 0, 79), 'Below your usual range'));
  assert.ok(has(ui.render('alice'), '98%'));
  assert.equal(ui.render('alice').filter(node => node.props?.style?.flexBasis === '100%').length, 4);
  assert.equal(has(ui.render('alice', 0, null), 'Within your usual range'), false);
  assert.equal(has(ui.render('alice', 0, 80, false), 'Within your usual range'), false);
  ui.activate();
  assert.equal(has(ui.render('alice', 0, 80), 'Within your usual range'), false);
  assert.equal(has(ui.render('bob', 0, 80), 'Within your usual range'), false);
});

test('v6 migration through v8 preserves genuine drive data and stores demo events separately and idempotently', async t => {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  const storage = {
    getFirstAsync: async (sql: string, args: SQLInputValue[] = []) => db.prepare(sql).get(...args),
    getAllAsync: async (sql: string, args: SQLInputValue[] = []) => db.prepare(sql).all(...args),
    runAsync: async (sql: string, args: SQLInputValue[] = []) => db.prepare(sql).run(...args),
    execAsync: async (sql: string) => db.exec(sql),
  };
  const open = () => load('lib/db/database.ts', { 'expo-sqlite': { openDatabaseAsync: async () => storage } }).getDatabase();
  await open();
  // Restore the v6 table set, then populate an existing drive before upgrading.
  db.exec("DROP TABLE ask_sensi_chats; DROP TABLE drive_demo_events; PRAGMA user_version = 6;");
  const stamp = new Date(Date.now() - 3600_000).toISOString();
  db.prepare('INSERT INTO driver_profiles (id, display_name, created_at, updated_at) VALUES (?, ?, ?, ?)').run('p1', 'Driver', stamp, stamp);
  db.prepare(`INSERT INTO drive_sessions (id, profile_id, started_at, status, sync_status) VALUES (?, ?, ?, 'completed', 'local')`).run('s1', 'p1', stamp);
  db.prepare(`INSERT INTO telemetry_events (id, session_id, event_type, received_at, raw_payload, sync_status, bpm, spo2, sqi_good)
    VALUES ('real', 's1', 'reading', ?, '{}', 'local', 78, 98, 1)`).run(stamp);
  await open();
  assert.equal(db.prepare('PRAGMA user_version').get()?.user_version, 8);
  const repo = load('lib/db/repositories.ts', {
    '../onboarding/driverProgress': driverProgress,
    './database': { getDatabase: async () => storage },
    './profileEditing': {}, '../util/json': {}, '../analysis/baseline': baseline, '../analysis/stats': stats, '../ble/protocol': {},
  });
  const before = await repo.driverBaseline('p1');
  const event = {
    id: 'demo-id', episode_id: 'episode', session_id: 's1', profile_id: 'p1', scenario: 'high_hr', mode: 'automatic',
    confirmed_at: stamp, measured_at: stamp, actual_value: 78, simulated_value: 114, applied_offset: 36,
    warning_threshold: 111, threshold_source: 'profile_estimate', acknowledgment_adjusted: 0,
    confirmation_level: 'warning', slots: 5, accepted_slots: 4, abnormal_slots: 4,
  };
  await repo.saveDriveDemoEvent({ ...event, profile_id: 'wrong-driver' });
  assert.deepEqual(await repo.demoEventsForSession('s1', 'p1'), []);
  await repo.saveDriveDemoEvent(event);
  await repo.saveDriveDemoEvent({ ...event, id: 'duplicate' });
  await repo.saveDriveDemoOutcome(event, 'not_ok');
  await repo.saveDriveDemoOutcome(event, 'ok');
  await open();
  const [row] = await repo.demoEventsForSession('s1', 'p1');
  assert.deepEqual({ ...row }, { ...event, source: 'hardware_biometric_simulation', sensi_outcome: 'not_ok', sync_status: 'pending' });
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM drive_demo_events').get()?.n, 1);
  assert.deepEqual(await repo.demoEventsForSession('s1', 'wrong-driver'), []);
  assert.deepEqual(await repo.alertsForSession('p1', 's1'), []);
  assert.ok(before.readings > 0);
  assert.deepEqual(await repo.driverBaseline('p1'), before);
  assert.deepEqual({ ...db.prepare('SELECT bpm, spo2 FROM telemetry_events').get() }, { bpm: 78, spo2: 98 });
  db.exec("DELETE FROM drive_sessions WHERE id = 's1'");
  assert.deepEqual(await repo.demoEventsForSession('s1', 'p1'), []);
});

test('History renders labeled demo values and local status in a card separate from genuine alerts', () => {
  let state = 0;
  const { Detail } = load('components/HistoryView.tsx', {
    './ScreenHeader': { ScreenHeader: 'ScreenHeader', ScreenHeading: 'ScreenHeading' },
    '../lib/i18n/native': { LocalizedText: 'Text' },
    '../lib/theme/ThemeProvider': { useTheme: () => ({ tokens: light, colors: presentationColors(light) }) },
    '../lib/theme/tokens': { presentationColors },
    react: { useEffect() {}, useState: (initial: unknown) => {
      const i = state++;
      return [i === 1 ? [{ id: 'genuine', kind: 'bpm_high', value: 180, started_at: '2026-11-22', response: 'ok' }]
        : i === 2 ? [{ id: 'demo', scenario: 'low_spo2', actual_value: 98, simulated_value: 90,
          warning_threshold: 93, confirmed_at: '2026-11-22', sensi_outcome: 'not_ok' }] : initial, () => {}];
    } },
    'react-native': { ActivityIndicator: 'ActivityIndicator', ScrollView: 'ScrollView', View: 'View', StyleSheet: { create: (v: unknown) => v } },
    'react/jsx-runtime': require('react/jsx-runtime'),
    '../lib/db/repositories': {}, '../lib/db/deletion': {}, '../lib/archive/archiveStore': {},
    './ui': { Btn: 'Btn', Card: 'Card', Row: 'Row', SectionTitle: 'SectionTitle', fmtNum: (v: number, d = 0) => v.toFixed(d) },
    './RecordedVitals': { RecordedVitals: 'RecordedVitals' }, './charts': {},
  }, '\nexport { Detail };');
  function nodes(node: any): any[] {
    if (Array.isArray(node)) return node.flatMap(nodes);
    return node?.props ? [node, ...nodes(node.props.children)] : [];
  }
  const cards = nodes(Detail({ session: { id: 's', driver_name: 'Driver', started_at: '2026-11-22', status: 'completed' } }))
    .filter(node => node.type === 'Card');
  const findCard = (title: string) => nodes(cards.find(card => nodes(card).some(node => node.props.children === title)));
  const demo = findCard('Simulated Safety Warning — Hardware Demo');
  assert.ok(demo.some(node => node.props.label === 'Actual SpO₂ (estimate)' && node.props.value === '98.0%'));
  assert.ok(demo.some(node => node.props.label === 'Simulated SpO₂' && node.props.value === '90.0%'));
  assert.ok(demo.some(node => node.props.value === 'Saved locally'));
  assert.ok(demo.some(node => node.props.value === 'Said not OK'));
  assert.ok(findCard('Alerts').some(node => String(node.props.label).includes('180')));
  assert.ok(!findCard('Alerts').some(node => node.props.value === '90.0%'));
});


test('Ask Sensi SQLite history survives reopening and enforces account, driver, and drive association', async t => {
  const folder = mkdtempSync(join(tmpdir(), 'drivesense-chats-'));
  const path = join(folder, 'chats.db');
  let db = new DatabaseSync(path);
  t.after(() => { db.close(); rmSync(folder, { recursive: true, force: true }); });
  const storage = {
    getFirstAsync: async (sql: string, args: SQLInputValue[] = []) => db.prepare(sql).get(...args),
    getAllAsync: async (sql: string, args: SQLInputValue[] = []) => db.prepare(sql).all(...args),
    runAsync: async (sql: string, args: SQLInputValue[] = []) => db.prepare(sql).run(...args),
    execAsync: async (sql: string) => db.exec(sql),
  };
  const reopen = async () => {
    const database = load('lib/db/database.ts', { 'expo-sqlite': { openDatabaseAsync: async () => storage } });
    await database.getDatabase();
    return load('lib/db/askSensiConversations.ts', { './database': database });
  };
  await reopen();
  db.exec(`
    DROP TABLE ask_sensi_chats;
    PRAGMA user_version = 7;
    INSERT INTO driver_profiles(id, display_name, created_at, updated_at) VALUES
      ('d1', 'Driver One', '2026-11-01', '2026-11-01'), ('d2', 'Driver Two', '2026-11-01', '2026-11-01');
    INSERT INTO drive_sessions(id, profile_id, started_at, status, sync_status) VALUES
      ('drive', 'd1', '2026-11-12', 'completed', 'local'), ('other-drive', 'd1', '2026-11-13', 'completed', 'local');
  `);
  let repo = await reopen();
  assert.equal(db.prepare('PRAGMA user_version').get()?.user_version, 8);
  assert.equal(db.prepare('SELECT count(*) AS n FROM drive_sessions').get()?.n, 2);
  const chat = { id: 'chat', driveId: 'drive', title: 'Drive summary', createdAt: '2026-11-20', updatedAt: '2026-11-21',
    turns: [{ id: 'turn', question: 'Explain this drive', answer: 'Recorded summary' }] };
  await repo.saveAskConversation('a1', 'd1', chat);
  await repo.saveAskConversation('a1', 'd1', { ...chat, id: 'new', driveId: 'other-drive', createdAt: '2026-11-22' });
  await assert.rejects(repo.saveAskConversation('a1', 'd1', { ...chat, driveId: 'other-drive' }));
  await repo.deleteAskConversation('a2', 'd1', chat.id);
  db.close();
  db = new DatabaseSync(path);
  repo = await reopen();
  assert.deepEqual(await repo.listAskConversations('a1', 'd2'), []);
  assert.deepEqual(await repo.listAskConversations('a2', 'd1'), []);
  const chats = await repo.listAskConversations('a1', 'd1');
  assert.deepEqual(chats.map((item: { id: string }) => item.id), ['new', 'chat']);
  assert.deepEqual(chats[1], { ...chat, driveStartedAt: '2026-11-12' });
  await repo.deleteAskConversation('a1', 'd1', 'new');
  assert.equal(db.prepare("SELECT count(*) AS n FROM drive_sessions WHERE id = 'other-drive'").get()?.n, 1);
  db.exec("DELETE FROM drive_sessions WHERE id = 'drive'");
  assert.deepEqual((await repo.listAskConversations('a1', 'd1'))[0], { ...chat, driveStartedAt: null });
  db.exec("DELETE FROM driver_profiles WHERE id = 'd1'");
  assert.deepEqual(await repo.listAskConversations('a1', 'd1'), []);
});
