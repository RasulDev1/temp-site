-- =====================================================================
--  ТЕМП · кнопка «Оплатить» у менеджера: способ оплаты и сумма + аналитика оплат
--  Запускать ПОСЛЕ основного скрипта и supabase-staff.sql.
--  Supabase → SQL Editor → новая вкладка (New query) → вставить ЦЕЛИКОМ → Run.
--  Можно запускать повторно. Заказы не меняются.
-- =====================================================================

-- ---------- 1. Как и сколько оплатили ----------
alter table public.orders add column if not exists payment_method text;   -- 'cash' наличные · 'card' карта
alter table public.orders add column if not exists paid_amount    numeric(12, 2);
alter table public.orders add column if not exists paid_at        timestamptz;
alter table public.orders add column if not exists paid_by        text;     -- ФИО сотрудника, принявшего оплату
alter table public.orders drop constraint if exists orders_payment_method_check;
alter table public.orders add constraint orders_payment_method_check
  check (payment_method is null or payment_method in ('cash', 'card'));

-- ---------- 2. «Оплатить»: только сотрудник, только заказ, который ждёт оплаты ----------
create or replace function public.order_mark_paid(p_id bigint, p_method text, p_amount numeric)
returns public.orders language plpgsql volatile security definer set search_path = '' as $$
declare me public.staff_accounts := public.staff_current(); o public.orders;
begin
  if me.id is null then raise exception 'staff:forbidden' using errcode = '42501'; end if;
  if p_method is null or p_method not in ('cash', 'card') then raise exception 'staff:bad_method' using errcode = '22023'; end if;
  if p_amount is null or p_amount <= 0 or p_amount > 100000000 then raise exception 'staff:bad_amount' using errcode = '22023'; end if;
  update public.orders set status = 'paid', payment_method = p_method, paid_amount = round(p_amount, 2),
    paid_at = now(), paid_by = me.full_name
  where id = p_id and status = 'awaiting_payment'
  returning * into o;
  if o.id is null then raise exception 'staff:conflict' using errcode = '40001'; end if;
  return o;
end $$;

-- ---------- 3. Аналитика оплат (только директор): суммы по способам за период ----------
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
      group by (paid_at at time zone 'Europe/Moscow')::date) x), '[]'::jsonb))
  into r
  from public.orders
  where paid_at is not null
    and (p_from is null or (paid_at at time zone 'Europe/Moscow')::date >= p_from)
    and (p_to   is null or (paid_at at time zone 'Europe/Moscow')::date <= p_to);
  return r;
end $$;

revoke execute on function public.order_mark_paid(bigint, text, numeric), public.payments_stats(date, date) from public;
grant execute on function public.order_mark_paid(bigint, text, numeric), public.payments_stats(date, date) to anon, authenticated;

notify pgrst, 'reload schema';

-- ---------- Проверка: должно быть «true» ----------
select exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'orders' and column_name = 'payment_method')
   and exists (select 1 from pg_proc where proname = 'payments_stats') as "оплаты и аналитика настроены";
