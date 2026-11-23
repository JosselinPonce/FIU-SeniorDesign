/**
 * Local offline database.
 *
 * Uses `expo-sqlite`, which is already declared in package.json and listed in
 * app.json's plugins array but not yet used by any code.
 *
 * The design is local-first on purpose: telemetry is written here the moment it
 * arrives over BLE, with no network involved, so a drive recorded in a parking
 * garage is never lost. `sync_status` is left at 'local' for a later step to
 * push rows to Supabase -- this module deliberately does no networking.
 */
import * as SQLite from 'expo-sqlite';

export const DB_NAME = 'smart_wheel.db';

/**
 * Bumped whenever the schema changes. Migrations run in order from whatever
 * version the device is on, so an existing install keeps its recorded drives
 * instead of being wiped.
 */
export const SCHEMA_VERSION = 7;

let dbPromise: Promise<SQLite.SQLiteDatabase> | null = null;

/** Opens (once) and migrates the database. Safe to call from anywhere. */
export function getDatabase(): Promise<SQLite.SQLiteDatabase> {
  if (!dbPromise) {
    dbPromise = openAndMigrate();
  }
  return dbPromise;
}

async function openAndMigrate(): Promise<SQLite.SQLiteDatabase> {
  const db = await SQLite.openDatabaseAsync(DB_NAME);

  // WAL keeps reads from blocking the notification write path.
  // Foreign keys are OFF by default in SQLite; without this the references
  // below would be decorative rather than enforced.
  await db.execAsync(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;

    CREATE TABLE IF NOT EXISTS driver_profiles (
      id           TEXT PRIMARY KEY NOT NULL,
      display_name TEXT NOT NULL,
      created_at   TEXT NOT NULL,
      updated_at   TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS drive_sessions (
      id          TEXT PRIMARY KEY NOT NULL,
      profile_id  TEXT NOT NULL,
      started_at  TEXT NOT NULL,
      ended_at    TEXT,
      status      TEXT NOT NULL,
      sync_status TEXT NOT NULL,
      FOREIGN KEY (profile_id) REFERENCES driver_profiles (id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS telemetry_events (
      id              TEXT PRIMARY KEY NOT NULL,
      session_id      TEXT NOT NULL,
      sequence_number INTEGER,
      event_type      TEXT NOT NULL,
      received_at     TEXT NOT NULL,
      raw_payload     TEXT,
      sync_status     TEXT NOT NULL,
      FOREIGN KEY (session_id) REFERENCES drive_sessions (id) ON DELETE CASCADE
    );

    -- Durable duplicate protection. BLE notifications can be replayed, and a
    -- reconnect mid-session can re-deliver. The in-memory guard in the hook is
    -- the fast path; this index is what makes de-duplication survive a restart.
    CREATE UNIQUE INDEX IF NOT EXISTS idx_telemetry_session_sequence
      ON telemetry_events (session_id, sequence_number)
      WHERE sequence_number IS NOT NULL;

    CREATE INDEX IF NOT EXISTS idx_telemetry_session
      ON telemetry_events (session_id);
    CREATE INDEX IF NOT EXISTS idx_sessions_profile
      ON drive_sessions (profile_id);
  `);

  await migrate(db);
  return db;
}

/**
 * Incremental migrations keyed on SQLite's own `user_version`.
 *
 * Additive only -- columns are added, never dropped or retyped -- so a phone
 * holding unsynced drives can upgrade without losing them.
 */
async function migrate(db: SQLite.SQLiteDatabase): Promise<void> {
  const row = await db.getFirstAsync<{ user_version: number }>(
    'PRAGMA user_version',
  );
  const current = row?.user_version ?? 0;

  if (current < 2) {
    // v2: driver demographics, and physiological values promoted out of
    // raw_payload into real columns so the dashboard can query them directly
    // rather than parsing JSON on every read.
    const addColumn = async (table: string, ddl: string) => {
      try {
        await db.execAsync(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
      } catch {
        // Column already present (a partially-applied migration); safe to skip.
      }
    };

    await addColumn('driver_profiles', 'custom_id TEXT');
    await addColumn('driver_profiles', 'weight_kg REAL');
    await addColumn('driver_profiles', 'age INTEGER');
    await addColumn('driver_profiles', 'height_cm REAL');
    await addColumn('driver_profiles', 'gender TEXT');

    await addColumn('drive_sessions', 'duration_seconds INTEGER');

    await addColumn('telemetry_events', 'bpm INTEGER');
    await addColumn('telemetry_events', 'spo2 INTEGER');
    await addColumn('telemetry_events', 'signal_quality INTEGER');
    await addColumn('telemetry_events', 'battery INTEGER');

    await db.execAsync(
      'CREATE INDEX IF NOT EXISTS idx_profiles_custom_id ' +
        'ON driver_profiles (custom_id)',
    );
  }

  if (current < 3) {
    // v3: protocol v3 metadata, the storage-mode choice, the folded session
    // archive, the alert log, and app settings.
    const addColumn = async (table: string, ddl: string) => {
      try {
        await db.execAsync(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
      } catch {
        // already present
      }
    };
    await addColumn('drive_sessions', "storage_mode TEXT NOT NULL DEFAULT 'vitals'");
    await addColumn('drive_sessions', 'sample_rate_hz INTEGER');
    await addColumn('telemetry_events', 'finger INTEGER');
    await addColumn('telemetry_events', 'quality INTEGER');

    await db.execAsync(`
      CREATE TABLE IF NOT EXISTS session_archives (
        session_id     TEXT PRIMARY KEY NOT NULL,
        format_version INTEGER NOT NULL,
        sample_rate_hz INTEGER NOT NULL,
        sample_count   INTEGER NOT NULL,
        frame_count    INTEGER NOT NULL,
        raw_bytes      INTEGER NOT NULL,
        packed_bytes   INTEGER NOT NULL,
        sha256         TEXT NOT NULL,
        data           BLOB NOT NULL,
        created_at     TEXT NOT NULL,
        sync_status    TEXT NOT NULL DEFAULT 'local',
        FOREIGN KEY (session_id) REFERENCES drive_sessions (id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS drive_alerts (
        id           TEXT PRIMARY KEY NOT NULL,
        session_id   TEXT NOT NULL,
        kind         TEXT NOT NULL,
        value        REAL,
        threshold    REAL,
        started_at   TEXT NOT NULL,
        prompted_at  TEXT,
        response     TEXT,
        responded_at TEXT,
        escalated    INTEGER NOT NULL DEFAULT 0,
        sync_status  TEXT NOT NULL DEFAULT 'local',
        FOREIGN KEY (session_id) REFERENCES drive_sessions (id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_alerts_session ON drive_alerts (session_id);

      CREATE TABLE IF NOT EXISTS app_settings (
        key   TEXT PRIMARY KEY NOT NULL,
        value TEXT NOT NULL
      );
    `);
  }

  if (current < 4) {
    // v4: profile fields the flag engine uses (conditions, medications), the
    // voice-check language, an emergency contact, and richer alert records.
    const addColumn = async (table: string, ddl: string) => {
      try {
        await db.execAsync(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
      } catch {
        // already present
      }
    };
    await addColumn('driver_profiles', "conditions TEXT NOT NULL DEFAULT '[]'");
    await addColumn('driver_profiles', "medications TEXT NOT NULL DEFAULT '[]'");
    await addColumn('driver_profiles', "language TEXT NOT NULL DEFAULT 'en'");
    await addColumn('driver_profiles', 'emergency_name TEXT');
    await addColumn('driver_profiles', 'emergency_phone TEXT');
    await addColumn('drive_alerts', 'level TEXT');
    await addColumn('drive_alerts', 'channel TEXT');
    await addColumn('drive_alerts', 'answer_confidence REAL');
  }

  if (current < 5) {
    // v5: per-second signal-quality labels computed on the phone from the
    // 100 Hz waveform (lib/analysis/signal.ts), and per-driver calibration.
    const addColumn = async (table: string, ddl: string) => {
      try {
        await db.execAsync(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
      } catch {
        // already present
      }
    };
    await addColumn('telemetry_events', 'hr_beats REAL');
    await addColumn('telemetry_events', 'sqi_good INTEGER');
    await addColumn('telemetry_events', 'template_r REAL');
    await addColumn('telemetry_events', 'perfusion REAL');
    await addColumn('telemetry_events', 'skewness REAL');
    await addColumn('driver_profiles', 'cal_hr REAL');
    await addColumn('driver_profiles', 'cal_spo2 REAL');
    await addColumn('driver_profiles', 'cal_at TEXT');
  }

  if (current < 6) {
    // v6: adaptation history -- a snapshot each time a driver's thresholds change.
    await db.execAsync(`
      CREATE TABLE IF NOT EXISTS threshold_history (
        id          TEXT PRIMARY KEY NOT NULL,
        profile_id  TEXT NOT NULL,
        at          TEXT NOT NULL,
        reason      TEXT NOT NULL,
        drives      INTEGER NOT NULL,
        learned     REAL NOT NULL,
        mean        REAL NOT NULL,
        sd          REAL NOT NULL,
        high_warn   INTEGER NOT NULL,
        low_warn    INTEGER NOT NULL,
        spo2_warn   INTEGER NOT NULL,
        sync_status TEXT NOT NULL DEFAULT 'local',
        FOREIGN KEY (profile_id) REFERENCES driver_profiles (id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_history_profile ON threshold_history (profile_id, at);
    `);
  }

  if (current < 7) {
    await db.execAsync(`
      CREATE TABLE IF NOT EXISTS drive_demo_events (
        id TEXT PRIMARY KEY NOT NULL,
        episode_id TEXT NOT NULL UNIQUE,
        session_id TEXT NOT NULL REFERENCES drive_sessions (id) ON DELETE CASCADE,
        profile_id TEXT NOT NULL REFERENCES driver_profiles (id) ON DELETE CASCADE,
        source TEXT NOT NULL DEFAULT 'hardware_biometric_simulation' CHECK (source = 'hardware_biometric_simulation'),
        scenario TEXT NOT NULL CHECK (scenario IN ('high_hr', 'low_spo2')),
        mode TEXT NOT NULL CHECK (mode IN ('automatic', 'manual')),
        confirmed_at TEXT NOT NULL,
        measured_at TEXT NOT NULL,
        actual_value REAL NOT NULL,
        simulated_value REAL NOT NULL,
        applied_offset REAL NOT NULL CHECK (applied_offset >= 0),
        warning_threshold REAL NOT NULL,
        threshold_source TEXT NOT NULL CHECK (threshold_source IN ('profile_estimate', 'baseline_informed', 'standard')),
        acknowledgment_adjusted INTEGER NOT NULL CHECK (acknowledgment_adjusted IN (0, 1)),
        confirmation_level TEXT NOT NULL CHECK (confirmation_level IN ('warning', 'critical')),
        slots INTEGER NOT NULL CHECK (slots = 5),
        accepted_slots INTEGER NOT NULL CHECK (accepted_slots BETWEEN 4 AND slots),
        abnormal_slots INTEGER NOT NULL CHECK (abnormal_slots <= accepted_slots AND abnormal_slots * 5 >= accepted_slots * 4),
        sensi_outcome TEXT CHECK (sensi_outcome IN ('ok', 'not_ok', 'no_response')),
        sync_status TEXT NOT NULL DEFAULT 'pending' CHECK (sync_status = 'pending')
      );
      CREATE INDEX IF NOT EXISTS idx_demo_events_session ON drive_demo_events (session_id, confirmed_at);
    `);
  }

  await db.execAsync(`PRAGMA user_version = ${SCHEMA_VERSION}`);
}

/** Development helper: row counts for the debug panel. */
export async function tableCounts(): Promise<Record<string, number>> {
  const db = await getDatabase();
  const counts: Record<string, number> = {};
  for (const table of ['driver_profiles', 'drive_sessions', 'telemetry_events', 'session_archives', 'drive_alerts']) {
    const row = await db.getFirstAsync<{ c: number }>(
      `SELECT COUNT(*) AS c FROM ${table}`,
    );
    counts[table] = row?.c ?? 0;
  }
  return counts;
}

/** Development helper: wipes local data without touching the schema. */
export async function resetDatabase(): Promise<void> {
  const db = await getDatabase();
  await db.execAsync(`
    DELETE FROM telemetry_events;
    DELETE FROM drive_sessions;
    DELETE FROM driver_profiles;
  `);
}
