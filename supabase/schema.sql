-- ────────────────────────────────────────────────────────────────────────────
-- Auralis access-key gate — Supabase schema
-- Run in the Supabase SQL editor (or `supabase db push`). Idempotent.
-- ────────────────────────────────────────────────────────────────────────────

-- digest() lives in pgcrypto — must exist before validate_key runs.
create extension if not exists pgcrypto;

create table if not exists public.access_keys (
  id           uuid primary key default gen_random_uuid(),
  -- sha256 hex of the plaintext key. The plaintext (AUR-XXXX-XXXX-XXXX) is
  -- shown once by admin/keys.mjs and never stored.
  key_hash     text not null unique,
  label        text not null default '',
  status       text not null default 'active' check (status in ('active', 'revoked')),
  expires_at   timestamptz,
  max_devices  int  not null default 1 check (max_devices > 0),
  -- [{ "device_id": "...", "first_seen": ts, "last_seen": ts }]
  devices      jsonb not null default '[]'::jsonb,
  created_at   timestamptz not null default now(),
  last_seen_at timestamptz
);

create index if not exists access_keys_key_hash_idx on public.access_keys (key_hash);

-- ── Lock the table down ─────────────────────────────────────────────────────
-- No direct reads/writes for anyone — all access goes through the RPC below,
-- which runs as the function owner (SECURITY DEFINER).
alter table public.access_keys enable row level security;

drop policy if exists access_keys_deny_all on public.access_keys;
create policy access_keys_deny_all on public.access_keys
  for all to anon, authenticated
  using (false) with check (false);

revoke all on public.access_keys from anon, authenticated;

-- ── validate_key(p_key, p_device_id) ────────────────────────────────────────
-- Hashes the presented key, checks status/expiry, binds the calling device
-- (respecting max_devices), touches last_seen_at and returns one JSON row:
--   { "valid": bool, "reason": "ok"|"invalid"|"revoked"|"expired"|"device_limit",
--     "label": text, "expires_at": timestamptz, "devices": int, "max_devices": int }
create or replace function public.validate_key(p_key text, p_device_id text)
returns json
language plpgsql
security definer
set search_path = public
as $$
declare
  v_hash   text;
  v_row    public.access_keys%rowtype;
  v_devices jsonb;
  v_count  int;
begin
  if p_key is null or p_device_id is null or length(p_device_id) < 8 then
    return json_build_object('valid', false, 'reason', 'invalid');
  end if;

  -- Normalise: strip spaces/uppercase, then sha256.
  v_hash := encode(digest(upper(regexp_replace(p_key, '\s+', '', 'g')), 'sha256'), 'hex');

  select * into v_row from public.access_keys where key_hash = v_hash;
  if not found then
    return json_build_object('valid', false, 'reason', 'invalid');
  end if;

  if v_row.status <> 'active' then
    return json_build_object('valid', false, 'reason', 'revoked',
      'label', v_row.label, 'expires_at', v_row.expires_at);
  end if;

  if v_row.expires_at is not null and v_row.expires_at < now() then
    return json_build_object('valid', false, 'reason', 'expired',
      'label', v_row.label, 'expires_at', v_row.expires_at);
  end if;

  -- Device binding: known devices pass; new ones count against max_devices.
  v_devices := coalesce(v_row.devices, '[]'::jsonb);
  v_count := jsonb_array_length(v_devices);

  if not exists (
    select 1 from jsonb_array_elements(v_devices) d
    where d ->> 'device_id' = p_device_id
  ) then
    if v_count >= v_row.max_devices then
      return json_build_object('valid', false, 'reason', 'device_limit',
        'label', v_row.label, 'expires_at', v_row.expires_at,
        'devices', v_count, 'max_devices', v_row.max_devices);
    end if;
    v_devices := v_devices || jsonb_build_object(
      'device_id', p_device_id,
      'first_seen', now(),
      'last_seen', now()
    );
  else
    v_devices := (
      select jsonb_agg(
        case when d ->> 'device_id' = p_device_id
             then jsonb_set(d, '{last_seen}', to_jsonb(now()))
             else d end
      )
      from jsonb_array_elements(v_devices) d
    );
  end if;

  update public.access_keys
     set devices = v_devices, last_seen_at = now()
   where id = v_row.id;

  return json_build_object(
    'valid', true,
    'reason', 'ok',
    'label', v_row.label,
    'expires_at', v_row.expires_at,
    'devices', jsonb_array_length(v_devices),
    'max_devices', v_row.max_devices
  );
end;
$$;

-- Only the service role may call the RPC.
revoke all on function public.validate_key(text, text) from public, anon, authenticated;
grant execute on function public.validate_key(text, text) to service_role;
