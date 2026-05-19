create table if not exists public.conversions (
  id uuid primary key default gen_random_uuid(),
  html text not null,
  elementor_json jsonb not null,
  status text not null default 'pending' check (status in ('pending', 'paid')),
  payment_id text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.conversions
add column if not exists html text,
add column if not exists original_html text,
add column if not exists elementor_json jsonb,
add column if not exists status text default 'pending',
add column if not exists payment_id text,
add column if not exists created_at timestamptz default now(),
add column if not exists updated_at timestamptz default now();

update public.conversions
set
  html = coalesce(html, original_html, ''),
  original_html = coalesce(original_html, html, ''),
  elementor_json = coalesce(elementor_json, '{"version":"0.4","title":"Elementor Page","type":"page","content":[]}'::jsonb),
  status = coalesce(status, 'pending'),
  created_at = coalesce(created_at, now()),
  updated_at = coalesce(updated_at, now());

alter table public.conversions
alter column html set not null,
alter column elementor_json set not null,
alter column status set not null,
alter column created_at set not null,
alter column updated_at set not null;

alter table public.conversions
alter column original_html drop not null;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'conversions_status_check'
      and conrelid = 'public.conversions'::regclass
  ) then
    alter table public.conversions
    add constraint conversions_status_check check (status in ('pending', 'paid'));
  end if;
end $$;

create index if not exists conversions_status_idx on public.conversions(status);
create index if not exists conversions_payment_id_idx on public.conversions(payment_id);

create or replace function public.set_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

drop trigger if exists conversions_set_updated_at on public.conversions;

create trigger conversions_set_updated_at
before update on public.conversions
for each row
execute function public.set_updated_at();

alter table public.conversions enable row level security;

drop policy if exists "Service role can manage conversions" on public.conversions;

create policy "Service role can manage conversions"
on public.conversions
for all
using (auth.role() = 'service_role')
with check (auth.role() = 'service_role');
