/**
 * Folding a finished full-waveform session into its archive, and unfolding it
 * again ("write the poem, fold the paper, open it only when you need it").
 *
 * While a 'full' session records, every frame's raw bytes sit in
 * telemetry_events.raw_payload (~630 B each as base64, ~2.3 MB/hour). At the
 * end they are folded (lib/archive/codec.ts) into one small PPGA file:
 *   1. decode every stored frame, in sequence order
 *   2. fold (lossless) and compute SHA-256 of the file
 *   3. UNFOLD it again and compare sample-for-sample with the input -- the
 *      raw rows are only released after the archive is proven to reproduce
 *      them exactly
 *   4. store the archive and clear raw_payload in one transaction
 * The per-second vitals rows stay; only the bulky raw copy is replaced.
 *
 * Backups (3-2-1: three copies, two media, one off-site -- CISA/US-CERT
 * "Data Backup Options", 2012): the archive on the phone, the same file in
 * Supabase Storage (off-site, uploaded by liveSync), and the Pi's CSV log of
 * processed values on its SD card. Integrity is checked with the stored
 * SHA-256 every time an archive is unfolded, on the phone or the website.
 */
import { deflateSync, inflateSync } from 'fflate';
import { sha256 } from '@noble/hashes/sha2.js';

import { getDatabase } from '../db/database';
import { base64ToBytes, decodeFrame } from '../ble/protocol';
import { foldArchive, unfoldArchive, unfoldedSize, type Archive, type ArchiveFrame } from './codec';

export const Z = { deflate: (d: Uint8Array) => deflateSync(d, { level: 9 }), inflate: (d: Uint8Array) => inflateSync(d) };

export type ArchiveInfo = {
  session_id: string;
  format_version: number;
  sample_rate_hz: number;
  sample_count: number;
  frame_count: number;
  raw_bytes: number;
  packed_bytes: number;
  sha256: string;
  created_at: string;
  sync_status: string;
};

export const toHex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');

/**
 * Folds a finished session's raw frames. Returns null if the session has no
 * raw frames (vitals-only mode, or already folded).
 */
export async function foldSession(sessionId: string, createdBy: string): Promise<ArchiveInfo | null> {
  const db = await getDatabase();
  const session = await db.getFirstAsync<{ profile_id: string; started_at: string; ended_at: string | null; driver: string }>(
    `SELECT s.profile_id, s.started_at, s.ended_at, p.display_name AS driver
     FROM drive_sessions s JOIN driver_profiles p ON p.id = s.profile_id WHERE s.id = ?`,
    [sessionId],
  );
  if (!session) return null;
  const rows = await db.getAllAsync<{ raw_payload: string; received_at: string }>(
    `SELECT raw_payload, received_at FROM telemetry_events
     WHERE session_id = ? AND raw_payload IS NOT NULL ORDER BY sequence_number`,
    [sessionId],
  );
  if (!rows.length) return null;

  const frames: ArchiveFrame[] = [];
  const red: number[] = [];
  const ir: number[] = [];
  let rate = 0;
  for (const r of rows) {
    let f;
    try {
      f = decodeFrame(base64ToBytes(r.raw_payload));
    } catch {
      continue; // was CRC-checked on arrival; a stored row that no longer decodes is skipped, not fatal
    }
    rate ||= f.rateHz;
    frames.push({
      seq: f.seq,
      espT0Ms: f.startMs,
      receivedAtMs: Date.parse(r.received_at),
      sampleCount: f.samples.length,
      heartRate: f.heartRate,
      spo2: f.spo2,
      flags: f.flags,
      quality: f.quality,
    });
    for (const s of f.samples) {
      red.push(s.red);
      ir.push(s.ir);
    }
  }
  const meta = {
    sessionId,
    profileId: session.profile_id,
    startedAt: session.started_at,
    endedAt: session.ended_at,
    sampleRateHz: rate,
    createdBy,
    driver: session.driver,
  };
  const file = foldArchive(meta, frames, red, ir, Z);

  // Prove the fold before letting go of anything.
  const back = unfoldArchive(file, Z);
  if (back.red.length !== red.length || back.red.some((v, i) => v !== red[i] || back.ir[i] !== ir[i])) {
    throw new Error('archive verification failed; raw data kept');
  }

  const info: ArchiveInfo = {
    session_id: sessionId,
    format_version: 1,
    sample_rate_hz: rate,
    sample_count: red.length,
    frame_count: frames.length,
    raw_bytes: unfoldedSize(red.length),
    packed_bytes: file.length,
    sha256: toHex(sha256(file)),
    created_at: new Date().toISOString(),
    sync_status: 'local',
  };
  await db.withTransactionAsync(async () => {
    await db.runAsync(
      `INSERT OR REPLACE INTO session_archives
         (session_id, format_version, sample_rate_hz, sample_count, frame_count, raw_bytes,
          packed_bytes, sha256, data, created_at, sync_status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'local')`,
      [info.session_id, info.format_version, info.sample_rate_hz, info.sample_count, info.frame_count,
       info.raw_bytes, info.packed_bytes, info.sha256, file, info.created_at],
    );
    await db.runAsync('UPDATE telemetry_events SET raw_payload = NULL WHERE session_id = ?', [sessionId]);
  });
  return info;
}

export async function archiveInfo(sessionId: string, profileId?: string): Promise<ArchiveInfo | null> {
  const db = await getDatabase();
  return db.getFirstAsync<ArchiveInfo>(
    `SELECT session_id, format_version, sample_rate_hz, sample_count, frame_count, raw_bytes,
            packed_bytes, sha256, created_at, sync_status
     FROM session_archives WHERE session_id = ? AND (? IS NULL OR session_id IN (SELECT id FROM drive_sessions WHERE profile_id = ?))`,
    [sessionId, profileId ?? null, profileId ?? null],
  );
}

export async function archiveBytes(sessionId: string, profileId?: string): Promise<Uint8Array | null> {
  const db = await getDatabase();
  const row = await db.getFirstAsync<{ data: Uint8Array }>('SELECT data FROM session_archives WHERE session_id = ? AND (? IS NULL OR session_id IN (SELECT id FROM drive_sessions WHERE profile_id = ?))', [
    sessionId, profileId ?? null, profileId ?? null,
  ]);
  return row?.data ?? null;
}

/** Unfolds a stored archive after checking its SHA-256. */
export async function unfoldSession(sessionId: string, profileId: string): Promise<Archive> {
  const info = await archiveInfo(sessionId, profileId);
  const bytes = await archiveBytes(sessionId, profileId);
  if (!info || !bytes) throw new Error('no archive for this session');
  if (toHex(sha256(bytes)) !== info.sha256) throw new Error('archive checksum mismatch');
  return unfoldArchive(bytes, Z);
}
