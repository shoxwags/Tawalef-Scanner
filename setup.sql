-- ============================================================
--  سكانر مستودع التوالف — إعداد Supabase
--  انسخ الملف كله في Supabase > SQL Editor > New query واضغط Run. مرة واحدة بس.
--  ينفع يتشغل على بروجكت لوحده، أو على نفس بروجكت bin-finder (الأسماء مش بتتعارض).
-- ============================================================

-- 1. مكان خاص لملف الأصناف (مش عام: محدش يقدر يقراه من غير تسجيل دخول).
insert into storage.buckets (id, name, public, file_size_limit)
values ('tawalef-data', 'tawalef-data', false, 52428800)
on conflict (id) do nothing;

-- 2. المشرفين: هم بس اللي يقدروا يرفعوا شيت الأصناف.
--    (لو البروجكت ده فيه bin-finder، الجدول موجود بالفعل وهيتستخدم زي ما هو.)
create table if not exists public.app_admins (
  user_id uuid primary key references auth.users (id) on delete cascade,
  added_at timestamptz not null default now()
);
alter table public.app_admins enable row level security;
drop policy if exists "Users can see whether they are admin" on public.app_admins;
create policy "Users can see whether they are admin"
  on public.app_admins for select to authenticated
  using (user_id = auth.uid());

-- 3. الدفعات (كل "سيشن جديدة" = دفعة).
create table if not exists public.tw_sessions (
  id uuid primary key,
  batch_no bigint generated always as identity,
  started_at timestamptz not null default now(),
  closed_at timestamptz,
  device text,
  created_at timestamptz not null default now()
);
alter table public.tw_sessions enable row level security;

-- 4. الأصناف اللي اتسجلت في كل دفعة.
create table if not exists public.tw_items (
  id uuid primary key,
  session_id uuid not null references public.tw_sessions (id) on delete cascade,
  barcode text not null,
  item_no text,
  description text,
  warehouse text,
  supplier text,
  target_location text,
  qty integer not null check (qty > 0),
  first_scanned_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists tw_items_session_idx on public.tw_items (session_id);
alter table public.tw_items enable row level security;

-- أي حد داخل بالحساب المشترك يقدر يسجل ويعدل الدفعات.
drop policy if exists "Staff manage sessions" on public.tw_sessions;
create policy "Staff manage sessions" on public.tw_sessions
  for all to authenticated using (true) with check (true);
drop policy if exists "Staff manage items" on public.tw_items;
create policy "Staff manage items" on public.tw_items
  for all to authenticated using (true) with check (true);

-- 5. صلاحيات ملف الأصناف: الكل يقرا، المشرفين بس يرفعوا.
drop policy if exists "Tawalef staff can read product data" on storage.objects;
create policy "Tawalef staff can read product data"
  on storage.objects for select to authenticated
  using (bucket_id = 'tawalef-data');

drop policy if exists "Tawalef admins can upload product data" on storage.objects;
create policy "Tawalef admins can upload product data"
  on storage.objects for insert to authenticated
  with check (bucket_id = 'tawalef-data' and exists (select 1 from public.app_admins a where a.user_id = auth.uid()));

drop policy if exists "Tawalef admins can replace product data" on storage.objects;
create policy "Tawalef admins can replace product data"
  on storage.objects for update to authenticated
  using (bucket_id = 'tawalef-data' and exists (select 1 from public.app_admins a where a.user_id = auth.uid()))
  with check (bucket_id = 'tawalef-data' and exists (select 1 from public.app_admins a where a.user_id = auth.uid()));

drop policy if exists "Tawalef admins can delete product data" on storage.objects;
create policy "Tawalef admins can delete product data"
  on storage.objects for delete to authenticated
  using (bucket_id = 'tawalef-data' and exists (select 1 from public.app_admins a where a.user_id = auth.uid()));

-- 6. عرض جاهز لكل الأصناف مع رقم الدفعة (مفيد للتقارير من Supabase نفسه).
create or replace view public.tw_items_report with (security_invoker = true) as
select s.batch_no, s.started_at as batch_started_at, s.closed_at as batch_closed_at,
       i.barcode, i.item_no, i.description, i.warehouse, i.supplier, i.target_location, i.qty, i.first_scanned_at
from public.tw_items i join public.tw_sessions s on s.id = i.session_id;


-- ============================================================
--  بعد ما تعمل حسابك كمشرف (Authentication > Users > Add user)،
--  غير الإيميل تحت، وحدد السطور دي بس، واضغط Run.
-- ============================================================
-- insert into public.app_admins (user_id)
-- select id from auth.users where email = 'your.email@othaim.com'
-- on conflict do nothing;
