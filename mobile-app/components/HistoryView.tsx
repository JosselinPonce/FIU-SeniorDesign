import { useTheme } from '../lib/theme/ThemeProvider';
import { presentationColors, type ThemeTokens } from '../lib/theme/tokens';
/**
 * Past drives on this phone: realistic low/high (percentiles), alerts, and --
 * for full-waveform drives -- "Unfold waveform", which opens the folded
 * archive after checking its SHA-256.
 */
import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Alert, Pressable, RefreshControl, ScrollView, StyleSheet, Text, View } from 'react-native';

import * as repo from '../lib/db/repositories';
import { deleteDriveEverywhere } from '../lib/db/deletion';
import type { DriveAlertRow, RobustSessionStats, SessionSummary } from '../lib/db/repositories';
import { archiveInfo, unfoldSession, type ArchiveInfo } from '../lib/archive/archiveStore';
import type { Archive } from '../lib/archive/codec';
import { Btn, Card, Pill, Row, SectionTitle, fmtBytes, fmtDuration, fmtNum } from './ui';
import { Waveform } from './charts';

const KIND: Record<string, string> = {
  bpm_high: 'high heart rate',
  bpm_low: 'low heart rate',
  spo2_low: 'low oxygen',
  no_contact: 'no hand on sensor',
  irregular_rhythm: 'irregular pulse pattern',
  hr_trend: 'heart rate higher than usual this week',
};
const OUTCOME: Record<string, string> = {
  ok: 'said OK',
  not_ok: 'not OK · escalated (sim.)',
  no_response: 'no answer · escalated (sim.)',
  recovered: 'recovered on its own',
  unconfirmed: 'not confirmed (signal)',
};

const when = (iso: string) =>
  new Date(iso).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });

function Detail(props: { session: SessionSummary; onBack: () => void }) {
  const { colors: C, tokens } = useTheme();
  const st = makeStyles(tokens);
  const [stats, setStats] = useState<RobustSessionStats | null>(null);
  const [alerts, setAlerts] = useState<DriveAlertRow[]>([]);
  const [info, setInfo] = useState<ArchiveInfo | null>(null);
  const [archive, setArchive] = useState<Archive | null>(null);
  const [unfolding, setUnfolding] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const s = props.session;

  useEffect(() => {
    void (async () => {
      setStats(await repo.robustSessionStats(s.id));
      setAlerts(await repo.alertsForSession(s.id));
      setInfo(await archiveInfo(s.id));
    })();
  }, [s.id]);

  async function unfold() {
    setUnfolding(true);
    setError(null);
    try {
      setArchive(await unfoldSession(s.id));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setUnfolding(false);
    }
  }

  const duration = s.duration_seconds ?? (s.ended_at ? (Date.parse(s.ended_at) - Date.parse(s.started_at)) / 1000 : null);
  // A 10-second window from the middle of the drive for the preview.
  const rate = archive?.meta.sampleRateHz || 100;
  const mid = archive ? Math.max(0, Math.floor(archive.ir.length / 2) - rate * 5) : 0;

  return (
    <ScrollView contentContainerStyle={st.container}>
      <Pressable onPress={props.onBack} accessibilityRole="button">
        <Text style={st.back}>‹ All drives</Text>
      </Pressable>
      <Text style={st.title}>{s.driver_name}</Text>
      <Text style={st.sub}>
        {when(s.started_at)} · {duration !== null ? fmtDuration(duration * 1000) : 'in progress'}
      </Text>

      <Card>
        <SectionTitle>Heart rate</SectionTitle>
        {!stats ? (
          <ActivityIndicator />
        ) : stats.bpm.count === 0 ? (
          <Text style={st.sub}>No usable heart-rate readings in this drive.</Text>
        ) : (
          <>
            <View style={st.big3}>
              <Big label="Realistic low" value={fmtNum(stats.bpm.p05)} color={C.heart} />
              <Big label="Typical" value={fmtNum(stats.bpm.median)} color={C.ink} />
              <Big label="Realistic high" value={fmtNum(stats.bpm.p95)} color={C.heart} />
            </View>
            <Text style={st.note}>
              Realistic low/high are the 5th/95th percentiles, so a single noisy second can't define them. Absolute min–max:{' '}
              {fmtNum(stats.bpm.min)}–{fmtNum(stats.bpm.max)} · average {fmtNum(stats.bpm.mean, 1)} BPM.
            </Text>
          </>
        )}
        <SectionTitle>Oxygen (SpO₂)</SectionTitle>
        {stats && stats.spo2.count > 0 ? (
          <View style={st.big3}>
            <Big label="Realistic low" value={`${fmtNum(stats.spo2.p05)}%`} color={C.oxygen} />
            <Big label="Typical" value={`${fmtNum(stats.spo2.median)}%`} color={C.ink} />
            <Big label="Realistic high" value={`${fmtNum(stats.spo2.p95)}%`} color={C.oxygen} />
          </View>
        ) : (
          <Text style={st.sub}>—</Text>
        )}
        {stats ? (
          <Row label="Seconds with a usable reading" value={`${fmtNum(stats.usablePct)}% of ${stats.frames}`} />
        ) : null}
      </Card>

      {alerts.length ? (
        <Card>
          <SectionTitle>Alerts</SectionTitle>
          {alerts.map((a) => (
            <Row
              key={a.id}
              label={`${new Date(a.started_at).toLocaleTimeString()} · ${KIND[a.kind] ?? a.kind}${
                a.kind === 'no_contact' || a.kind === 'irregular_rhythm' ? '' : ` ${fmtNum(a.value)}`
              }${a.level && a.level !== 'notice' ? ` (${a.level})` : ''}`}
              value={OUTCOME[a.response ?? ''] ?? (a.level === 'notice' ? 'noted' : 'open')}
              tone={a.escalated ? 'bad' : a.response === 'ok' || a.response === 'recovered' ? 'good' : 'neutral'}
            />
          ))}
          <Text style={st.note}>
            Notices are only logged. A warning is watched for 15 s (8 s if critical); only if it holds does the phone ask out loud.
          </Text>
        </Card>
      ) : null}

      <Card>
        <SectionTitle>Full waveform</SectionTitle>
        {!info ? (
          <Text style={st.sub}>Not recorded — this drive saved vitals only.</Text>
        ) : (
          <>
            <Row label="Samples" value={`${info.sample_count.toLocaleString()} @ ${info.sample_rate_hz} Hz`} />
            <Row
              label="Folded size"
              value={`${fmtBytes(info.packed_bytes)} (×${(info.raw_bytes / info.packed_bytes).toFixed(1)} smaller)`}
            />
            <Row label="Cloud backup" value={info.sync_status === 'synced' ? 'yes' : 'pending'} tone={info.sync_status === 'synced' ? 'good' : 'warn'} />
            {!archive ? (
              <Btn title="Unfold waveform" kind="ghost" busy={unfolding} onPress={unfold} />
            ) : (
              <>
                <Pill tone="good">Checksum verified · lossless</Pill>
                <Text style={st.sub}>Infrared, 10 s from the middle of the drive</Text>
                <Waveform values={archive.ir.slice(mid, mid + rate * 10)} color={C.oxygen} />
                <Text style={st.sub}>Red, same window</Text>
                <Waveform values={archive.red.slice(mid, mid + rate * 10)} color={C.heart} />
              </>
            )}
            {error ? <Text style={{ color: C.bad }}>{error}</Text> : null}
          </>
        )}
      </Card>

      {s.status !== 'active' ? (
        <Btn
          title="Delete this drive"
          kind="danger"
          onPress={() =>
            Alert.alert('Delete this drive?', 'Removes its readings, alerts and waveform on this phone and on the dashboard. It cannot be undone.', [
              { text: 'Cancel', style: 'cancel' },
              {
                text: 'Delete everywhere',
                style: 'destructive',
                onPress: async () => {
                  const where = await deleteDriveEverywhere(s.id);
                  props.onBack();
                  if (where === 'queued') Alert.alert('Deleted on this phone', 'The dashboard copy will be deleted the next time the phone is online.');
                },
              },
            ])
          }
        />
      ) : null}
    </ScrollView>
  );
}

function Big(props: { label: string; value: string; color: string }) {
  const { colors: C, tokens } = useTheme();
  const st = makeStyles(tokens);
  return (
    <View style={{ flex: 1, alignItems: 'center' }}>
      <Text style={[st.bigValue, { color: props.color }]}>{props.value}</Text>
      <Text style={st.bigLabel}>{props.label}</Text>
    </View>
  );
}

export function HistoryView(props: { refreshKey: string }) {
  const { colors: C, tokens } = useTheme();
  const st = makeStyles(tokens);
  const [sessions, setSessions] = useState<SessionSummary[] | null>(null);
  const [open, setOpen] = useState<SessionSummary | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => setSessions(await repo.listSessions(100)), []);
  useEffect(() => {
    void load();
  }, [load, props.refreshKey]);

  if (open)
    return (
      <Detail
        session={open}
        onBack={() => {
          setOpen(null);
          void load();
        }}
      />
    );
  return (
    <ScrollView
      contentContainerStyle={st.container}
      refreshControl={
        <RefreshControl
          refreshing={refreshing}
          onRefresh={async () => {
            setRefreshing(true);
            await load();
            setRefreshing(false);
          }}
        />
      }
    >
      {!sessions ? <ActivityIndicator /> : null}
      {sessions?.length === 0 ? <Text style={st.sub}>No drives yet. Start one from the Drive tab.</Text> : null}
      {sessions?.map((s) => (
        <Pressable key={s.id} onPress={() => setOpen(s)} accessibilityRole="button">
          <Card style={st.item}>
            <View style={{ flex: 1 }}>
              <Text style={st.itemTitle}>{s.driver_name}</Text>
              <Text style={st.sub}>
                {when(s.started_at)} · {s.duration_seconds !== null ? fmtDuration(s.duration_seconds * 1000) : s.status}
              </Text>
            </View>
            <View style={{ alignItems: 'flex-end', gap: 4 }}>
              <Pill tone={s.status === 'active' ? 'good' : s.sync_status === 'synced' ? 'brand' : 'neutral'}>
                {s.status === 'active' ? 'recording' : s.sync_status === 'synced' ? 'in cloud' : 'on phone'}
              </Pill>
              <Text style={st.sub}>{s.event_count} s of data{s.storage_mode === 'full' ? ' · waveform' : ''}</Text>
            </View>
          </Card>
        </Pressable>
      ))}
    </ScrollView>
  );
}

const makeStyles = (tokens: ThemeTokens) => {
  const C = presentationColors(tokens);
  return StyleSheet.create({
    container: { padding: 16, gap: 12, paddingBottom: 40 },
    back: { color: C.brand, fontSize: 16, fontWeight: '700' },
    title: { fontSize: 26, fontWeight: '800', color: C.ink },
    sub: { fontSize: 13, color: C.sub },
    note: { fontSize: 12, color: C.sub, lineHeight: 17 },
    big3: { flexDirection: 'row' },
    bigValue: { fontSize: 30, fontWeight: '800', fontVariant: ['tabular-nums'] },
    bigLabel: { fontSize: 12, color: C.sub },
    item: { flexDirection: 'row', alignItems: 'center', gap: 10 },
    itemTitle: { fontSize: 17, fontWeight: '700', color: C.ink },
  });
};
