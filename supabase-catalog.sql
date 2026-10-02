-- =====================================================================
--  ТЕМП · каталог в базе: товары, цены, скидки, остатки, порядок карточек и фото — без ключей GitHub
--  Запускать ПОСЛЕ supabase-staff.sql (нужен вход сотрудников по логину и паролю).
--  Supabase → SQL Editor → новая вкладка (New query) → вставить ЦЕЛИКОМ → Run.
--  Можно запускать повторно: каталог и фото не удаляются.
--  Первое сохранение в «Товарах» само перенесёт текущий каталог из репозитория (catalog/catalog.json).
-- =====================================================================

-- ---------- 1. Каталог: одна запись с данными и номером версии ----------
create table if not exists public.catalog_state (
  id         int primary key default 1 check (id = 1),
  data       jsonb not null default '{}'::jsonb,
  version    int not null default 0,
  updated_at timestamptz not null default now()
);
insert into public.catalog_state (id) values (1) on conflict (id) do nothing;

revoke all on public.catalog_state from anon, authenticated;
grant select on public.catalog_state to anon, authenticated;     -- каталог видят все покупатели
alter table public.catalog_state enable row level security;
drop policy if exists catalog_state_read on public.catalog_state;
create policy catalog_state_read on public.catalog_state for select to anon, authenticated using (true);

-- Сохранение — только сотрудник (вход по логину и паролю). p_version защищает от одновременной правки двумя людьми.
create or replace function public.catalog_save(p_data jsonb, p_version int)
returns int language plpgsql volatile security definer set search_path = '' as $$
declare next_version int;
begin
  if not public.is_staff() then raise exception 'catalog:forbidden' using errcode = '42501'; end if;
  if jsonb_typeof(p_data) <> 'object' or octet_length(p_data::text) > 1000000 then
    raise exception 'catalog:bad_data' using errcode = '22023';
  end if;
  update public.catalog_state set data = p_data, version = version + 1, updated_at = now()
  where id = 1 and version = p_version
  returning version into next_version;
  if next_version is null then raise exception 'catalog:conflict' using errcode = '40001'; end if;
  return next_version;
end $$;
revoke execute on function public.catalog_save(jsonb, int) from public;
grant execute on function public.catalog_save(jsonb, int) to anon, authenticated;

-- ---------- 2. Фото товаров: публичная папка в Supabase Storage ----------
-- Смотреть фото может кто угодно (по ссылке), загружать и удалять — только сотрудник.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('products', 'products', true, 5242880, array['image/jpeg', 'image/png', 'image/webp'])
on conflict (id) do update set public = true, file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists products_staff_select on storage.objects;
drop policy if exists products_staff_insert on storage.objects;
drop policy if exists products_staff_delete on storage.objects;
create policy products_staff_select on storage.objects for select to anon, authenticated
  using (bucket_id = 'products' and public.is_staff());
create policy products_staff_insert on storage.objects for insert to anon, authenticated
  with check (bucket_id = 'products' and public.is_staff());
create policy products_staff_delete on storage.objects for delete to anon, authenticated
  using (bucket_id = 'products' and public.is_staff());

notify pgrst, 'reload schema';

-- ---------- Проверка: должно быть «true» ----------
select exists (select 1 from public.catalog_state where id = 1)         as "каталог в базе есть",
       exists (select 1 from storage.buckets where id = 'products')      as "папка для фото есть";
