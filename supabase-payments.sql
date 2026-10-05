-- =====================================================================
--  ТЕМП · кнопка «Оплатить» у менеджера: способ оплаты и сумма + аналитика оплат и менеджеров
--  Запускать ПОСЛЕ основного скрипта и supabase-staff.sql.
--  Supabase → SQL Editor → новая вкладка (New query) → вставить ЦЕЛИКОМ → Run.
--  Можно запускать повторно. Заказы не меняются.
-- =====================================================================

-- ---------- 1. Как и сколько оплатили ----------
alter table public.orders add column if not exists payment_method text;   -- 'cash' наличные · 'card' карта
alter table public.orders add column if not exists paid_amount    numeric(12, 2);
alter table public.orders add column if not exists paid_at        timestamptz;
alter table public.orders add column if not exists paid_by        text;     -- ФИО сотрудника, принявшего оплату
alter table public.orders add column if not exists paid_by_id     bigint;
alter table public.orders add column if not exists accepted_by    text;     -- ФИО сотрудника, принявшего заявку
alter table public.orders add column if not exists accepted_by_id bigint;
alter table public.orders add column if not exists accepted_at    timestamptz;
alter table public.orders drop constraint if exists orders_payment_method_check;
alter table public.orders add constraint orders_payment_method_check
  check (payment_method is null or payment_method in ('cash', 'card'));

-- ---------- 2. Кто оформил заявку: сотрудник, который её принял и отправил реквизиты ----------
create or replace function public.orders_set_accepted_by()
returns trigger language plpgsql security definer set search_path = '' as $$
declare me public.staff_accounts := public.staff_current();
begin
  if old.status = 'new' and new.status = 'awaiting_payment' then
    new.accepted_at := now();
    new.accepted_by := me.full_name;
    new.accepted_by_id := me.id;
  end if;
  return new;
end $$;
drop trigger if exists orders_set_accepted_by on public.orders;
create trigger orders_set_accepted_by before update of status on public.orders
  for each row execute function public.orders_set_accepted_by();

-- ---------- 3. «Оплатить»: только сотрудник, только заказ, который ждёт оплаты ----------
create or replace function public.order_mark_paid(p_id bigint, p_method text, p_amount numeric)
returns public.orders language plpgsql volatile security definer set search_path = '' as $$
declare me public.staff_accounts := public.staff_current(); o public.orders;
begin
  if me.id is null then raise exception 'staff:forbidden' using errcode = '42501'; end if;
  if p_method is null or p_method not in ('cash', 'card') then raise exception 'staff:bad_method' using errcode = '22023'; end if;
  if p_amount is null or p_amount <= 0 or p_amount > 100000000 then raise exception 'staff:bad_amount' using errcode = '22023'; end if;
  update public.orders set status = 'paid', payment_method = p_method, paid_amount = round(p_amount, 2),
    paid_at = now(), paid_by = me.full_name, paid_by_id = me.id
  where id = p_id and status = 'awaiting_payment'
  returning * into o;
  if o.id is null then raise exception 'staff:conflict' using errcode = '40001'; end if;
  return o;
end $$;

-- ---------- 4. Аналитика (только директор): суммы по способам и по менеджерам за период ----------
-- Менеджер заявки — кто её принял (для старых заказов — кто отметил оплату).
-- «Заявок» — сколько он принял за период, «продажи» — сколько оплачено за период по его заявкам.
-- Дни считаются по московскому времени. p_from / p_to — даты включительно; null — без границы.
create or replace function public.payments_stats(p_from date, p_to date)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare r jsonb;
begin
  if public.app_role() <> 'admin' then raise exception 'staff:forbidden' using errcode = '42501'; end if;
  select jsonb_build_object(
    'cash_sum',   coalesce(sum(paid_amount) filter (where payment_method = 'cash'), 0),
    'cash_count', count(*) filter (where payment_method = 'cash'),
    'card_sum',   coalesce(sum(paid_amount) filter (where payment_method = 'card'), 0),
    'card_count', count(*) filter (where payment_method = 'card'),
    'days', coalesce((select jsonb_agg(d order by d->>'day' desc) from (
      select jsonb_build_object('day', (paid_at at time zone 'Europe/Moscow')::date,
        'cash', coalesce(sum(paid_amount) filter (where payment_method = 'cash'), 0),
        'card', coalesce(sum(paid_amount) filter (where payment_method = 'card'), 0),
        'count', count(*)) d
      from public.orders
      where paid_at is not null
        and (p_from is null or (paid_at at time zone 'Europe/Moscow')::date >= p_from)
        and (p_to   is null or (paid_at at time zone 'Europe/Moscow')::date <= p_to)
      group by (paid_at at time zone 'Europe/Moscow')::date) x), '[]'::jsonb),
    'managers', coalesce((select jsonb_agg(m order by (m->>'sales')::numeric desc, (m->>'orders')::int desc) from (
      select jsonb_build_object('name', manager,
        'orders', count(*) filter (where accepted_in),
        'paid', count(*) filter (where paid_in),
        'sales', coalesce(sum(paid_amount) filter (where paid_in), 0)) m
      from (
        select coalesce(accepted_by, paid_by) as manager, paid_amount,
          accepted_at is not null
            and (p_from is null or (accepted_at at time zone 'Europe/Moscow')::date >= p_from)
            and (p_to   is null or (accepted_at at time zone 'Europe/Moscow')::date <= p_to) as accepted_in,
          paid_at is not null
            and (p_from is null or (paid_at at time zone 'Europe/Moscow')::date >= p_from)
            and (p_to   is null or (paid_at at time zone 'Europe/Moscow')::date <= p_to) as paid_in
        from public.orders where coalesce(accepted_by, paid_by) is not null) o
      where accepted_in or paid_in
      group by manager) y), '[]'::jsonb))
  into r
  from public.orders
  where paid_at is not null
    and (p_from is null or (paid_at at time zone 'Europe/Moscow')::date >= p_from)
    and (p_to   is null or (paid_at at time zone 'Europe/Moscow')::date <= p_to);
  return r;
end $$;

-- ---------- 5. Заявки за период для «Аналитики» (только директор) ----------
-- Оформленная заявка — принятая сотрудником (для старых заказов — оплаченная через «Оплатить»).
-- Дата заявки — когда её приняли; менеджер — кто принял. Дни по московскому времени, границы включительно.
create or replace function public.analytics_orders(p_from date, p_to date)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare r jsonb;
begin
  if public.app_role() <> 'admin' then raise exception 'staff:forbidden' using errcode = '42501'; end if;
  select coalesce(jsonb_agg(jsonb_build_object(
      'id', id, 'at', coalesce(accepted_at, paid_at), 'status', status, 'total', total,
      'customer', customer_name, 'manager', coalesce(accepted_by, paid_by),
      'method', payment_method, 'paid', paid_amount, 'paid_at', paid_at)
    order by coalesce(accepted_at, paid_at) desc), '[]'::jsonb)
  into r
  from (select * from public.orders
    where coalesce(accepted_by, paid_by) is not null
      and (p_from is null or (coalesce(accepted_at, paid_at) at time zone 'Europe/Moscow')::date >= p_from)
      and (p_to   is null or (coalesce(accepted_at, paid_at) at time zone 'Europe/Moscow')::date <= p_to)
    order by coalesce(accepted_at, paid_at) desc limit 2000) o;
  return r;
end $$;

revoke execute on function public.order_mark_paid(bigint, text, numeric), public.payments_stats(date, date), public.analytics_orders(date, date) from public;
grant execute on function public.order_mark_paid(bigint, text, numeric), public.payments_stats(date, date), public.analytics_orders(date, date) to anon, authenticated;

-- ---------- 5. Список заказов у персонала видит новые столбцы оплаты ----------
-- Представления из supabase-archive.sql запомнили столбцы заказов на момент создания — пересоздаём их.
do $$ begin
  if to_regclass('public.order_archive') is not null then
    drop view if exists public.orders_active, public.orders_archived;
    create view public.orders_active with (security_invoker = true) as
      select o.* from public.orders o
      where not exists (select 1 from public.order_archive a where a.order_id = o.id);
    create view public.orders_archived with (security_invoker = true) as
      select o.*, a.archived_at from public.orders o
      join public.order_archive a on a.order_id = o.id;
    revoke all on public.orders_active, public.orders_archived from anon, authenticated;
    grant select on public.orders_active, public.orders_archived to anon, authenticated;
  end if;
end $$;

notify pgrst, 'reload schema';

-- ---------- Проверка: должно быть «true» ----------
select exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'orders' and column_name = 'payment_method')
   and exists (select 1 from pg_proc where proname = 'analytics_orders')
   and exists (select 1 from pg_trigger where tgname = 'orders_set_accepted_by') as "оплаты и аналитика настроены";
