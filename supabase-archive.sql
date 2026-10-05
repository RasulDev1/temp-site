-- =====================================================================
--  ТЕМП · очистка списка заказов у менеджера и директора (скрытые заказы)
--  Запускать ПОСЛЕ основного скрипта и supabase-chat.sql.
--  Supabase → SQL Editor → новая вкладка (New query) → вставить ЦЕЛИКОМ → Run.
--  Заказы НЕ удаляются: они только скрываются из списка персонала.
--  Покупатель свои заказы и переписку видит как раньше.
--  Можно запускать повторно. Запустите ещё раз после supabase-payments.sql, чтобы в списке заказов были видны оплаты.
-- =====================================================================

-- ---------- 1. Список скрытых заказов ----------
create table if not exists public.order_archive (
  order_id    bigint primary key references public.orders (id) on delete cascade,
  archived_at timestamptz not null default now()
);

revoke all on public.order_archive from anon, authenticated;
grant select, delete on public.order_archive to anon, authenticated;
grant insert (order_id) on public.order_archive to anon, authenticated;

do $$ declare p record; begin
  for p in select policyname from pg_policies where schemaname = 'public' and tablename = 'order_archive' loop
    execute format('drop policy %I on public.order_archive', p.policyname);
  end loop;
end $$;
alter table public.order_archive enable row level security;

-- скрывать и возвращать заказы могут только менеджер и директор
create policy order_archive_select on public.order_archive for select to anon, authenticated
  using ((select public.is_staff()));
create policy order_archive_insert on public.order_archive for insert to anon, authenticated
  with check ((select public.is_staff()));
create policy order_archive_delete on public.order_archive for delete to anon, authenticated
  using ((select public.is_staff()));

-- ---------- 2. Заказы в списке и скрытые (права те же, что у таблицы заказов) ----------
-- Представления пересоздаются: «select o.*» запоминает столбцы на момент создания, а новые столбцы заказов
-- (например, способ и сумма оплаты из supabase-payments.sql) без пересоздания в список не попадают.
drop view if exists public.orders_active, public.orders_archived;
create view public.orders_active with (security_invoker = true) as
  select o.* from public.orders o
  where not exists (select 1 from public.order_archive a where a.order_id = o.id);
create view public.orders_archived with (security_invoker = true) as
  select o.*, a.archived_at from public.orders o
  join public.order_archive a on a.order_id = o.id;
revoke all on public.orders_active, public.orders_archived from anon, authenticated;
grant select on public.orders_active, public.orders_archived to anon, authenticated;

-- ---------- 3. Покупатель написал в чат скрытого заказа — заказ возвращается в список ----------
create or replace function public.order_unarchive_on_message()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if not new.from_staff then
    delete from public.order_archive where order_id = new.order_id;
  end if;
  return null;
end $$;
drop trigger if exists order_unarchive_on_message on public.order_messages;
create trigger order_unarchive_on_message after insert on public.order_messages
  for each row execute function public.order_unarchive_on_message();

notify pgrst, 'reload schema';

-- ---------- Проверка: должно быть «true» ----------
select exists (select 1 from pg_tables where schemaname = 'public' and tablename = 'order_archive') as "скрытые заказы настроены",
       exists (select 1 from pg_views  where schemaname = 'public' and viewname  = 'orders_active')  as "список заказов настроен";
