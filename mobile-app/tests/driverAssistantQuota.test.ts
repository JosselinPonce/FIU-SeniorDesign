import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { URL as NodeURL } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
const userA = '11111111-1111-4111-8111-111111111111';
const userB = '22222222-2222-4222-8222-222222222222';
const lease = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const wrongLease = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const fingerprint = 'a'.repeat(64);
const id = (n: number) => `33333333-3333-4333-8333-${String(n).padStart(12, '0')}`;

test('Connected quotas and service-only RPCs execute on PostgreSQL', { timeout: 30000 }, async t => {
  const db = await PGlite.create();
  try {
    await db.exec(`create role anon; create role authenticated; create role service_role;
      create schema auth; create table auth.users(id uuid primary key);
      insert into auth.users values ('${userA}'), ('${userB}');
      create table public.telemetry_events(id integer primary key);
      alter table public.telemetry_events enable row level security;
      create policy existing_telemetry on public.telemetry_events for all to public using(true) with check(true);`);
    const before = (await db.query("select * from pg_policies where tablename='telemetry_events'")).rows;
    await db.exec(readFileSync(new NodeURL('../supabase/migrations/202610100001_driver_assistant.sql', import.meta.url), 'utf8'));
    assert.deepEqual((await db.query("select * from pg_policies where tablename='telemetry_events'")).rows, before);
    const reserve = async (user = userA, n = 1, hash = fingerprint) =>
      (await db.query<{ r: { code: string } }>('select public.driver_assistant_reserve($1,$2,$3,$4) r', [user, id(n), hash, lease])).rows[0].r.code;
    const dispatch = async (user = userA, n = 1, key = lease) =>
      (await db.query<{ r: boolean }>('select public.driver_assistant_dispatch($1,$2,$3) r', [user, id(n), key])).rows[0].r;
    const complete = async (user = userA, n = 1, key = lease, success = true) =>
      (await db.query<{ r: boolean }>('select public.driver_assistant_complete($1,$2,$3,$4,100,10) r', [user, id(n), key, success])).rows[0].r;
    const reset = async () => {
      await db.exec(`truncate driver_assistant_private.requests, driver_assistant_private.demo_users;
        update driver_assistant_private.control set enabled=true, daily_requests=100, minute_requests=30,
          concurrent_requests=4, lifetime_token_limit=2000000, lifetime_reserved_tokens=0;
        insert into driver_assistant_private.demo_users(user_id, enabled, expires_at)
          values ('${userA}', true, now()+interval '1 day'), ('${userB}', true, now()+interval '1 day');`);
    };
    const spent = async () => (await db.query<{ n: number }>('select lifetime_reserved_tokens::integer n from driver_assistant_private.control')).rows[0].n;
    await t.test('ships disabled with an empty allowlist', async () => {
      assert.equal(await reserve(), 'disabled');
      assert.equal((await db.query('select * from driver_assistant_private.demo_users')).rows.length, 0);
      await db.exec('update driver_assistant_private.control set enabled=true');
      assert.equal(await reserve(), 'not_allowed');
    });
    await t.test('public/authenticated roles cannot read/write private tables or call RPCs', async () => {
      for (const role of ['anon', 'authenticated']) {
        await db.exec(`set role ${role}`);
        try {
          await assert.rejects(reserve(), /permission denied/);
          await assert.rejects(dispatch(), /permission denied/);
          await assert.rejects(complete(), /permission denied/);
          await assert.rejects(db.query('select * from driver_assistant_private.demo_users'), /permission denied/);
          await assert.rejects(db.query('update driver_assistant_private.control set enabled=true'), /permission denied/);
          await assert.rejects(db.query(`insert into driver_assistant_private.demo_users(user_id, expires_at) values ('${userA}', now())`), /permission denied/);
        } finally { await db.exec('reset role'); }
      }
      assert.equal((await db.query("select * from pg_policies where schemaname='driver_assistant_private'")).rows.length, 0);
    });
    await t.test('service role can use RPCs without direct private table access', async () => {
      await reset(); await db.exec('set role service_role');
      try {
        assert.equal(await reserve(), 'reserved'); assert.equal(await dispatch(), true); assert.equal(await complete(), true);
        await assert.rejects(db.query('select * from driver_assistant_private.requests'), /permission denied/);
      } finally { await db.exec('reset role'); }
    });
    await t.test('duplicate/conflicting IDs never charge twice or dispatch twice', async () => {
      await reset();
      assert.equal(await reserve(), 'reserved'); assert.equal(await reserve(), 'duplicate');
      assert.equal(await reserve(userA, 1, 'b'.repeat(64)), 'conflict');
      assert.equal(await dispatch(userA, 1, wrongLease), false);
      assert.equal(await dispatch(), true); assert.equal(await dispatch(), false);
      assert.equal(await complete(userA, 1, wrongLease), false); assert.equal(await complete(), true);
      assert.equal(await reserve(), 'duplicate'); assert.equal(await spent(), 20000);
    });
    await t.test('per-user and global concurrency persist across admissions', async () => {
      await reset();
      assert.deepEqual(await Promise.all([reserve(userA, 1), reserve(userA, 2)]), ['reserved', 'busy']);
      await db.exec('update driver_assistant_private.control set concurrent_requests=1');
      assert.equal(await reserve(userB, 3), 'busy');
      assert.equal(await complete(userA, 1, lease, false), true);
      assert.equal(await reserve(userB, 3), 'reserved');
    });
    await t.test('user daily/minute limits include failed calls', async () => {
      for (const setting of ['daily_requests=1', 'minute_requests=1']) {
        await reset(); await db.exec(`update driver_assistant_private.demo_users set ${setting}`);
        assert.equal(await reserve(), 'reserved'); await complete(userA, 1, lease, false);
        assert.equal(await reserve(userA, 2), 'quota'); assert.equal(await reserve(userB, 3), 'reserved');
      }
    });
    await t.test('global daily/minute/lifetime limits apply across users', async () => {
      for (const setting of ['daily_requests=1', 'minute_requests=1', 'lifetime_token_limit=20000']) {
        await reset(); await db.exec(`update driver_assistant_private.control set ${setting}`);
        assert.equal(await reserve(), 'reserved'); await complete(userA, 1, lease, false);
        assert.equal(await reserve(userB, 2), 'quota'); assert.equal(await spent(), 20000);
      }
    });
    await t.test('expired allowlist, revoked user and kill switch fail closed before dispatch', async () => {
      await reset();
      await db.exec(`update driver_assistant_private.demo_users set expires_at=now()-interval '1 second' where user_id='${userA}'`);
      assert.equal(await reserve(), 'not_allowed');
      await reset(); assert.equal(await reserve(), 'reserved');
      await db.exec(`update driver_assistant_private.demo_users set enabled=false where user_id='${userA}'`);
      assert.equal(await dispatch(), false);
      await reset(); assert.equal(await reserve(), 'reserved');
      await db.exec('update driver_assistant_private.control set enabled=false');
      assert.equal(await dispatch(), false); assert.equal(await reserve(userB, 2), 'disabled');
    });
    await t.test('expired/crashed leases free concurrency without refunds or duplicate replay', async () => {
      await reset(); assert.equal(await reserve(), 'reserved');
      await db.exec("update driver_assistant_private.requests set expires_at=now()-interval '1 second'");
      assert.equal(await dispatch(), false); assert.equal(await complete(), false);
      assert.equal(await reserve(), 'duplicate'); assert.equal(await reserve(userA, 2), 'reserved');
      assert.equal(await spent(), 40000);
    });
    await t.test('UTC day rollover retains lifetime accounting and duplicate tombstones', async () => {
      await reset(); await db.exec('update driver_assistant_private.demo_users set daily_requests=1');
      assert.equal(await reserve(), 'reserved'); await complete(userA, 1, lease, false);
      await db.exec("update driver_assistant_private.requests set created_at=(date_trunc('day', now() at time zone 'UTC') at time zone 'UTC')-interval '2 minutes'");
      assert.equal(await reserve(userA, 2), 'reserved'); assert.equal(await reserve(userA, 1), 'duplicate');
      assert.equal(await spent(), 40000);
    });
  } finally { await db.close(); }
});
