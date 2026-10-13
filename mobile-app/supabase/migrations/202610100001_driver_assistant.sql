-- Stage 4A only. Does not touch telemetry, profiles, monitoring, or their policies.
begin;
create schema if not exists driver_assistant_private;
revoke all on schema driver_assistant_private from public, anon, authenticated, service_role;

create table driver_assistant_private.control (
  singleton boolean primary key default true check (singleton),
  enabled boolean not null default false,
  daily_requests integer not null default 100 check (daily_requests between 1 and 10000),
  minute_requests integer not null default 30 check (minute_requests between 1 and 1000),
  concurrent_requests integer not null default 4 check (concurrent_requests between 1 and 20),
  lifetime_token_limit bigint not null default 2000000 check (lifetime_token_limit >= 0),
  lifetime_reserved_tokens bigint not null default 0 check (lifetime_reserved_tokens >= 0)
);
insert into driver_assistant_private.control(singleton) values (true);
create table driver_assistant_private.demo_users (
  user_id uuid primary key references auth.users(id) on delete cascade,
  enabled boolean not null default false,
  expires_at timestamptz not null,
  daily_requests integer not null default 30 check (daily_requests between 1 and 1000),
  minute_requests integer not null default 6 check (minute_requests between 1 and 100),
  concurrent_requests integer not null default 1 check (concurrent_requests between 1 and 4)
);
create table driver_assistant_private.requests (
  user_id uuid not null references auth.users(id) on delete cascade,
  request_id uuid not null,
  fingerprint text not null check (fingerprint ~ '^[0-9a-f]{64}$'),
  lease_id uuid not null,
  state text not null check (state in ('reserved', 'running', 'completed', 'failed')),
  created_at timestamptz not null,
  expires_at timestamptz not null,
  completed_at timestamptz,
  reserved_tokens integer not null default 20000 check (reserved_tokens = 20000),
  input_tokens integer not null default 0 check (input_tokens between 0 and 20000),
  output_tokens integer not null default 0 check (output_tokens between 0 and 20000),
  primary key (user_id, request_id)
);
create index driver_assistant_requests_created on driver_assistant_private.requests(created_at);
create index driver_assistant_requests_user_created on driver_assistant_private.requests(user_id, created_at);
create index driver_assistant_requests_active on driver_assistant_private.requests(expires_at) where state in ('reserved', 'running');
alter table driver_assistant_private.control enable row level security;
alter table driver_assistant_private.demo_users enable row level security;
alter table driver_assistant_private.requests enable row level security;
-- No user-facing policies, grants or default public access.
revoke all on all tables in schema driver_assistant_private from public, anon, authenticated, service_role;
alter default privileges in schema driver_assistant_private revoke all on tables from public, anon, authenticated, service_role;

create function public.driver_assistant_reserve(p_user uuid, p_request uuid, p_fingerprint text, p_lease uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  c driver_assistant_private.control%rowtype;
  u driver_assistant_private.demo_users%rowtype;
  old driver_assistant_private.requests%rowtype;
  stamp timestamptz;
  day_start timestamptz;
  global_day bigint; global_minute bigint; global_active bigint;
  user_day bigint; user_minute bigint; user_active bigint;
begin
  if p_user is null or p_request is null or p_lease is null or p_fingerprint is null
    or p_fingerprint !~ '^[0-9a-f]{64}$' then raise exception 'Invalid reservation'; end if;
  -- Serialize ALL admission decisions on one row across users and Edge instances.
  select * into c from driver_assistant_private.control where singleton for update;
  stamp := clock_timestamp();
  day_start := date_trunc('day', stamp at time zone 'UTC') at time zone 'UTC';
  if not found or not c.enabled then return jsonb_build_object('code', 'disabled'); end if;
  select * into u from driver_assistant_private.demo_users where user_id = p_user for share;
  if not found or not u.enabled or u.expires_at <= stamp then return jsonb_build_object('code', 'not_allowed'); end if;
  select * into old from driver_assistant_private.requests where user_id = p_user and request_id = p_request;
  if found then
    return jsonb_build_object('code', case when old.fingerprint = p_fingerprint then 'duplicate' else 'conflict' end);
  end if;
  select count(*) filter (where created_at >= day_start),
    count(*) filter (where created_at >= stamp - interval '1 minute'),
    count(*) filter (where state in ('reserved','running') and expires_at > stamp),
    count(*) filter (where user_id = p_user and created_at >= day_start),
    count(*) filter (where user_id = p_user and created_at >= stamp - interval '1 minute'),
    count(*) filter (where user_id = p_user and state in ('reserved','running') and expires_at > stamp)
    into global_day, global_minute, global_active, user_day, user_minute, user_active
    from driver_assistant_private.requests
    where created_at >= least(day_start, stamp - interval '1 minute') or (state in ('reserved','running') and expires_at > stamp);
  if global_day >= c.daily_requests or user_day >= u.daily_requests
    or global_minute >= c.minute_requests or user_minute >= u.minute_requests
    or c.lifetime_reserved_tokens + 20000 > c.lifetime_token_limit then
    return jsonb_build_object('code', 'quota');
  end if;
  if global_active >= c.concurrent_requests or user_active >= u.concurrent_requests then
    return jsonb_build_object('code', 'busy');
  end if;
  insert into driver_assistant_private.requests(user_id, request_id, fingerprint, lease_id, state, created_at, expires_at)
    values(p_user, p_request, p_fingerprint, p_lease, 'reserved', stamp, stamp + interval '120 seconds');
  update driver_assistant_private.control set lifetime_reserved_tokens = lifetime_reserved_tokens + 20000 where singleton;
  return jsonb_build_object('code', 'reserved');
end $$;

create function public.driver_assistant_dispatch(p_user uuid, p_request uuid, p_lease uuid)
returns boolean language plpgsql security definer set search_path = '' as $$
declare active boolean;
begin
  select enabled into active from driver_assistant_private.control where singleton for update;
  if active is distinct from true then return false; end if;
  perform 1 from driver_assistant_private.demo_users where user_id = p_user and enabled and expires_at > clock_timestamp() for share;
  if not found then return false; end if;
  -- A lease may dispatch exactly once. Expired/replaced/completed leases cannot run.
  update driver_assistant_private.requests set state = 'running'
    where user_id = p_user and request_id = p_request and lease_id = p_lease
      and state = 'reserved' and expires_at > clock_timestamp();
  return found;
end $$;

create function public.driver_assistant_complete(p_user uuid, p_request uuid, p_lease uuid,
  p_success boolean, p_input_tokens integer, p_output_tokens integer)
returns boolean language plpgsql security definer set search_path = '' as $$
begin
  update driver_assistant_private.requests
    set state = case when p_success then 'completed' else 'failed' end,
      completed_at = clock_timestamp(), input_tokens = p_input_tokens, output_tokens = p_output_tokens
    where user_id = p_user and request_id = p_request and lease_id = p_lease
      and state in ('reserved','running') and expires_at > clock_timestamp()
      and (not p_success or state = 'running');
  -- No refunds: failures, disconnects and uncertain provider outcomes consume quota.
  return found;
end $$;

revoke all on function public.driver_assistant_reserve(uuid, uuid, text, uuid) from public, anon, authenticated;
revoke all on function public.driver_assistant_dispatch(uuid, uuid, uuid) from public, anon, authenticated;
revoke all on function public.driver_assistant_complete(uuid, uuid, uuid, boolean, integer, integer) from public, anon, authenticated;
grant execute on function public.driver_assistant_reserve(uuid, uuid, text, uuid) to service_role;
grant execute on function public.driver_assistant_dispatch(uuid, uuid, uuid) to service_role;
grant execute on function public.driver_assistant_complete(uuid, uuid, uuid, boolean, integer, integer) to service_role;
commit;
