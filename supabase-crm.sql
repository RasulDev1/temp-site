-- =====================================================================
--  VEXA · CRM: история заказа, возвраты, закупочные цены и прибыль, списание остатков, откуда пришёл клиент
--  Запускать ПОСЛЕ supabase-staff.sql, supabase-catalog.sql, supabase-payments.sql и supabase-customers.sql.
--  Supabase → SQL Editor → новая вкладка (New query) → вставить ЦЕЛИКОМ → Run.
--  Можно запускать повторно. Заказы, каталог и клиенты не удаляются.
-- =====================================================================

-- ---------- 1. Новые статусы: «Возврат запрошен» и «Возврат» ----------
alter table public.orders drop constraint if exists orders_status_check;
alter table public.orders add constraint orders_status_check
  check (status in ('new', 'awaiting_payment', 'paid', 'delivered', 'cancelled', 'return_requested', 'return_approved', 'returned'));

alter table public.orders add column if not exists delivered_at          timestamptz;
alter table public.orders add column if not exists delivered_by          text;
alter table public.orders add column if not exists return_request_reason text;        -- что написал покупатель
alter table public.orders add column if not exists return_requested_at   timestamptz;
alter table public.orders add column if not exists return_declined       text;        -- почему менеджер отказал в возврате
alter table public.orders add column if not exists return_reason         text;        -- причина возврата, пишет менеджер
alter table public.orders add column if not exists return_amount         numeric(12, 2); -- сколько вернём (решение менеджера)
alter table public.orders add column if not exists return_method         text;           -- как вернём: cash · card
alter table public.orders add column if not exists return_approved_at    timestamptz;    -- возврат одобрен, ждём вещь
alter table public.orders add column if not exists return_approved_by    text;
alter table public.orders add column if not exists returned_at           timestamptz;    -- возврат вручён: вещь у магазина, деньги отданы
alter table public.orders add column if not exists returned_by           text;
alter table public.orders add column if not exists refund_amount         numeric(12, 2);
alter table public.orders add column if not exists refund_method         text;
alter table public.orders add column if not exists restocked             boolean not null default false;
alter table public.orders add column if not exists cost_total            numeric(12, 2); -- себестоимость на момент оплаты
alter table public.orders add column if not exists stock_reserved        boolean not null default false;
alter table public.orders drop constraint if exists orders_refund_method_check;
alter table public.orders add constraint orders_refund_method_check
  check (refund_method is null or refund_method in ('cash', 'card'));

-- ---------- 2. Закупочные цены (видят только сотрудники) ----------
create table if not exists public.product_costs (
  product_id bigint primary key,
  cost       numeric(12, 2) not null check (cost >= 0),
  updated_by text,
  updated_at timestamptz not null default now()
);
revoke all on public.product_costs from anon, authenticated;
alter table public.product_costs enable row level security;

-- Себестоимость позиций заказа по закупочным ценам; null — ни у одного товара цена не указана
create or replace function public.order_items_cost(p_items jsonb)
returns numeric language sql stable security definer set search_path = '' as $$
  select sum(c.cost * greatest(coalesce((i ->> 'qty')::int, 1), 0))
  from jsonb_array_elements(case when jsonb_typeof(p_items) = 'array' then p_items else '[]'::jsonb end) i
  join public.product_costs c on c.product_id::text = i ->> 'id'
$$;
revoke execute on function public.order_items_cost(jsonb) from public, anon, authenticated;

create or replace function public.product_costs_get()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
begin
  if not public.is_staff() then raise exception 'staff:forbidden' using errcode = '42501'; end if;
  return coalesce((select jsonb_object_agg(product_id::text, cost) from public.product_costs), '{}'::jsonb);
end $$;

create or replace function public.product_cost_set(p_id bigint, p_cost numeric)
returns void language plpgsql volatile security definer set search_path = '' as $$
declare me public.staff_accounts := public.staff_current();
begin
  if me.id is null then raise exception 'staff:forbidden' using errcode = '42501'; end if;
  if p_cost is null or p_cost <= 0 then delete from public.product_costs where product_id = p_id; return; end if;
  if p_cost > 100000000 then raise exception 'staff:bad_amount' using errcode = '22023'; end if;
  insert into public.product_costs (product_id, cost, updated_by, updated_at) values (p_id, round(p_cost, 2), me.full_name, now())
  on conflict (product_id) do update set cost = excluded.cost, updated_by = excluded.updated_by, updated_at = now();
end $$;

-- ---------- 3. Остатки: списываются при заказе, возвращаются при отказе и возврате ----------
-- Только у товаров, где включён «Учёт количества» (остатки по цвету и размеру в «Товарах»).
create or replace function public.stock_apply(p_items jsonb, p_sign int)
returns void language plpgsql volatile security definer set search_path = '' as $$
declare cat jsonb; i jsonb; path text[]; cur int; changed boolean := false;
begin
  select data into cat from public.catalog_state where id = 1 for update;
  if cat is null or jsonb_typeof(p_items) <> 'array' then return; end if;
  for i in select * from jsonb_array_elements(p_items) loop
    path := array['stock', i ->> 'id', 'qty', (i ->> 'color') || '|' || (i ->> 'size')];
    continue when i ->> 'id' is null or cat #> path is null;
    cur := coalesce((cat #>> path)::int, 0);
    cat := jsonb_set(cat, path, to_jsonb(greatest(0, cur + p_sign * greatest(coalesce((i ->> 'qty')::int, 1), 0))));
    changed := true;
  end loop;
  if changed then
    update public.catalog_state set data = cat, version = version + 1, updated_at = now() where id = 1;
  end if;
end $$;
revoke execute on function public.stock_apply(jsonb, int) from public, anon, authenticated;

create or replace function public.orders_stock_on_insert()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  perform public.stock_apply(new.items, -1);
  new.stock_reserved := true;
  return new;
end $$;
drop trigger if exists orders_stock_on_insert on public.orders;
create trigger orders_stock_on_insert before insert on public.orders
  for each row execute function public.orders_stock_on_insert();

-- Перед сменой статуса: вручение, себестоимость при оплате, возврат товара на склад
create or replace function public.orders_crm_before_status()
returns trigger language plpgsql security definer set search_path = '' as $$
declare me public.staff_accounts := public.staff_current();
begin
  if new.status = old.status then return new; end if;
  if new.status = 'delivered' and old.status = 'paid' then
    new.delivered_at := coalesce(new.delivered_at, now());
    new.delivered_by := coalesce(new.delivered_by, me.full_name);
  end if;
  if new.status = 'paid' and new.cost_total is null then new.cost_total := public.order_items_cost(new.items); end if;
  -- отказ: зарезервированный товар возвращается на склад
  if new.status = 'cancelled' and old.stock_reserved then
    perform public.stock_apply(new.items, 1);
    new.stock_reserved := false;
  end if;
  -- возврат: товар на склад, если менеджер отметил «Вернуть на склад»
  if new.status = 'returned' and new.restocked then
    perform public.stock_apply(new.items, 1);
    new.stock_reserved := false;
  end if;
  return new;
end $$;
drop trigger if exists orders_crm_before_status on public.orders;
create trigger orders_crm_before_status before update of status on public.orders
  for each row execute function public.orders_crm_before_status();

-- ---------- 4. История заказа: кто и когда что сделал ----------
create table if not exists public.order_events (
  id       bigint generated always as identity primary key,
  order_id bigint not null references public.orders (id) on delete cascade,
  at       timestamptz not null default now(),
  actor    text,
  body     text not null
);
create index if not exists order_events_order_idx on public.order_events (order_id, at, id);
revoke all on public.order_events from anon, authenticated;
alter table public.order_events enable row level security;

-- Кто действует: сотрудник по входу, покупатель по подписи Telegram, иначе — система
create or replace function public.event_actor(p_owner bigint)
returns text language plpgsql stable security definer set search_path = '' as $$
declare name text; tg bigint;
begin
  select full_name into name from public.staff_current();
  if name is not null then return name; end if;
  begin tg := public.tg_id(); exception when others then tg := null; end;
  return case when tg is not null and tg = p_owner then 'Покупатель' else null end;
end $$;
revoke execute on function public.event_actor(bigint) from public, anon, authenticated;

create or replace function public.rub(p numeric)
returns text language sql immutable set search_path = '' as $$
  select case when coalesce(p, 0) = round(coalesce(p, 0))
    then replace(trim(to_char(coalesce(p, 0), '999G999G999G990')), ',', ' ')
    else replace(replace(trim(to_char(p, '999G999G999G990D00')), ',', ' '), '.', ',') end || ' ₽'
$$;

create or replace function public.orders_log_events()
returns trigger language plpgsql security definer set search_path = '' as $$
declare actor text := public.event_actor(new.user_id); body text;
  st jsonb := '{"new":"Новый","awaiting_payment":"Ждёт оплаты","paid":"Оплачен","delivered":"Вручён","cancelled":"Отказ","return_requested":"Возврат запрошен","return_approved":"Возврат одобрен","returned":"Возврат вручён"}';
  way jsonb := '{"cash":"наличными","card":"картой"}';
begin
  if tg_op = 'INSERT' then
    insert into public.order_events (order_id, actor, body) values (new.id, coalesce(actor, 'Покупатель'),
      'Заказ оформлен на ' || public.rub(new.total));
    return null;
  end if;
  if new.status is distinct from old.status then
    body := case
      when new.status = 'awaiting_payment' and old.status = 'new' then 'Принят, покупателю отправлены реквизиты для оплаты'
      when new.status = 'cancelled' then 'Отказ' || coalesce(': «' || nullif(trim(new.manager_note), '') || '»', '')
      when new.status = 'paid' then 'Оплачен' || coalesce(' ' || (way ->> new.payment_method), '') || coalesce(': ' || public.rub(new.paid_amount), '')
      when new.status = 'delivered' and old.status in ('return_requested', 'return_approved') then 'В возврате отказано' || coalesce(': «' || nullif(trim(new.return_declined), '') || '»', '')
      when new.status = 'delivered' then 'Вручён покупателю'
      when new.status = 'return_requested' then 'Покупатель запросил возврат' || coalesce(': «' || nullif(trim(new.return_request_reason), '') || '»', '')
      when new.status = 'return_approved' then 'Возврат одобрен' || coalesce(': «' || nullif(trim(new.return_reason), '') || '»', '')
        || '. Вернём ' || public.rub(new.return_amount) || coalesce(' ' || (way ->> new.return_method), '') || ', ждём вещь'
      when new.status = 'returned' then 'Возврат вручён' || coalesce(': «' || nullif(trim(new.return_reason), '') || '»', '')
        || '. Вернули ' || public.rub(new.refund_amount) || coalesce(' ' || (way ->> new.refund_method), '')
        || case when new.restocked then ', товар вернулся на склад' else ', товар не возвращается на склад' end
      else 'Статус: ' || coalesce(st ->> old.status, old.status) || ' → ' || coalesce(st ->> new.status, new.status) end;
    insert into public.order_events (order_id, actor, body) values (new.id, actor, body);
  elsif new.paid_amount is distinct from old.paid_amount or new.payment_method is distinct from old.payment_method then
    insert into public.order_events (order_id, actor, body) values (new.id, actor,
      'Оплата изменена: ' || public.rub(new.paid_amount) || coalesce(' ' || (way ->> new.payment_method), ''));
  end if;
  return null;
end $$;
drop trigger if exists orders_log_events on public.orders;
create trigger orders_log_events after insert or update on public.orders
  for each row execute function public.orders_log_events();

-- Скрыть заказ из списка и вернуть его (если настроено supabase-archive.sql)
do $$ begin
  if to_regclass('public.order_archive') is not null then
    create or replace function public.order_archive_log()
    returns trigger language plpgsql security definer set search_path = '' as $f$
    declare v_id bigint := case when tg_op = 'DELETE' then old.order_id else new.order_id end;
    begin
      insert into public.order_events (order_id, actor, body)
      select v_id, public.event_actor(null), case when tg_op = 'DELETE' then 'Возвращён в список заказов' else 'Скрыт из списка заказов' end
      where exists (select 1 from public.orders o where o.id = v_id);
      return null;
    end $f$;
    drop trigger if exists order_archive_log on public.order_archive;
    create trigger order_archive_log after insert or delete on public.order_archive
      for each row execute function public.order_archive_log();
  end if;
end $$;

-- Прошлые заказы: восстанавливаем историю из того, что уже записано (оформлен, принят, оплачен)
insert into public.order_events (order_id, at, actor, body)
select o.id, e.at, e.actor, e.body from public.orders o
cross join lateral (values
  (o.created_at, 'Покупатель', 'Заказ оформлен на ' || public.rub(o.total)),
  (o.accepted_at, o.accepted_by, 'Принят, покупателю отправлены реквизиты для оплаты'),
  (o.paid_at, o.paid_by, 'Оплачен' || coalesce(' ' || ('{"cash":"наличными","card":"картой"}'::jsonb ->> o.payment_method), '')
    || coalesce(': ' || public.rub(o.paid_amount), ''))) e(at, actor, body)
where e.at is not null and not exists (select 1 from public.order_events x where x.order_id = o.id);

create or replace function public.order_history(p_id bigint)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
begin
  if not public.is_staff() then raise exception 'staff:forbidden' using errcode = '42501'; end if;
  return coalesce((select jsonb_agg(jsonb_build_object('at', at, 'actor', actor, 'body', body) order by at, id)
    from public.order_events where order_id = p_id), '[]'::jsonb);
end $$;

-- ---------- 5. Возвраты ----------
-- Правила (как в интернет-магазинах одежды, по закону о защите прав потребителей):
-- товар надлежащего качества — 14 дней после получения; брак — до 6 месяцев.
create or replace function public.order_return_request(p_id bigint, p_reason text)
returns void language plpgsql volatile security definer set search_path = '' as $$
declare me bigint; o public.orders; since timestamptz; defect boolean := coalesce(p_reason, '') ilike 'Брак%';
begin
  begin me := public.tg_id(); exception when others then me := null; end;
  select * into o from public.orders where id = p_id for update;
  if me is null or o.id is null or o.user_id is distinct from me then raise exception 'staff:forbidden' using errcode = '42501'; end if;
  if length(trim(coalesce(p_reason, ''))) < 3 then raise exception 'staff:empty' using errcode = '22023'; end if;
  if o.status <> 'delivered' then raise exception 'staff:conflict' using errcode = '40001'; end if;
  if o.return_declined is not null then raise exception 'staff:return_declined' using errcode = '42501'; end if;
  since := coalesce(o.delivered_at, o.paid_at, o.created_at);
  if now() > since + (case when defect then interval '180 days' else interval '15 days' end) then
    raise exception 'staff:return_expired' using errcode = '42501';
  end if;
  update public.orders set status = 'return_requested', return_request_reason = left(trim(p_reason), 1000),
    return_requested_at = now() where id = p_id;
end $$;

create or replace function public.order_return(p_id bigint, p_reason text, p_amount numeric, p_method text, p_restock boolean)
returns void language plpgsql volatile security definer set search_path = '' as $$
declare me public.staff_accounts := public.staff_current(); o public.orders;
begin
  if me.id is null then raise exception 'staff:forbidden' using errcode = '42501'; end if;
  if length(trim(coalesce(p_reason, ''))) < 3 then raise exception 'staff:empty' using errcode = '22023'; end if;
  if p_method is null or p_method not in ('cash', 'card') then raise exception 'staff:bad_method' using errcode = '22023'; end if;
  select * into o from public.orders where id = p_id for update;
  if o.id is null or o.status not in ('paid', 'delivered', 'return_requested') then raise exception 'staff:conflict' using errcode = '40001'; end if;
  if p_amount is null or p_amount < 0 or p_amount > greatest(coalesce(o.paid_amount, o.total), 0) then
    raise exception 'staff:bad_amount' using errcode = '22023';
  end if;
  update public.orders set status = 'returned', return_reason = left(trim(p_reason), 1000), returned_at = now(),
    returned_by = me.full_name, refund_amount = round(p_amount, 2), refund_method = p_method, restocked = coalesce(p_restock, false)
  where id = p_id;
end $$;

-- Шаг 1. Возврат одобрен: менеджер решил вернуть деньги (сколько и как), покупатель привозит или отправляет вещь
create or replace function public.order_return_approve(p_id bigint, p_reason text, p_amount numeric, p_method text)
returns void language plpgsql volatile security definer set search_path = '' as $$
declare me public.staff_accounts := public.staff_current(); o public.orders;
begin
  if me.id is null then raise exception 'staff:forbidden' using errcode = '42501'; end if;
  if length(trim(coalesce(p_reason, ''))) < 3 then raise exception 'staff:empty' using errcode = '22023'; end if;
  if p_method is null or p_method not in ('cash', 'card') then raise exception 'staff:bad_method' using errcode = '22023'; end if;
  select * into o from public.orders where id = p_id for update;
  if o.id is null or o.status not in ('paid', 'delivered', 'return_requested', 'return_approved') then raise exception 'staff:conflict' using errcode = '40001'; end if;
  if p_amount is null or p_amount < 0 or p_amount > greatest(coalesce(o.paid_amount, o.total), 0) then
    raise exception 'staff:bad_amount' using errcode = '22023';
  end if;
  update public.orders set status = 'return_approved', return_reason = left(trim(p_reason), 1000), return_amount = round(p_amount, 2),
    return_method = p_method, return_approved_at = now(), return_approved_by = me.full_name
  where id = p_id;
end $$;

-- Шаг 2. Возврат вручён: вещь у магазина, деньги отданы покупателю; p_restock — вещь снова можно продавать
create or replace function public.order_return_done(p_id bigint, p_restock boolean)
returns void language plpgsql volatile security definer set search_path = '' as $$
declare me public.staff_accounts := public.staff_current(); o public.orders;
begin
  if me.id is null then raise exception 'staff:forbidden' using errcode = '42501'; end if;
  select * into o from public.orders where id = p_id for update;
  if o.id is null or o.status <> 'return_approved' then raise exception 'staff:conflict' using errcode = '40001'; end if;
  update public.orders set status = 'returned', returned_at = now(), returned_by = me.full_name,
    refund_amount = o.return_amount, refund_method = o.return_method, restocked = coalesce(p_restock, false)
  where id = p_id;
end $$;

create or replace function public.order_return_decline(p_id bigint, p_message text)
returns void language plpgsql volatile security definer set search_path = '' as $$
declare me public.staff_accounts := public.staff_current();
begin
  if me.id is null then raise exception 'staff:forbidden' using errcode = '42501'; end if;
  if length(trim(coalesce(p_message, ''))) < 3 then raise exception 'staff:empty' using errcode = '22023'; end if;
  update public.orders set status = 'delivered', return_declined = left(trim(p_message), 1000), return_amount = null, return_method = null,
    return_approved_at = null, return_approved_by = null where id = p_id and status in ('return_requested', 'return_approved');
  if not found then raise exception 'staff:conflict' using errcode = '40001'; end if;
end $$;

-- Пока решается возврат, покупатель и менеджер переписываются в чате заказа
create or replace function public.order_messages_before_insert()
returns trigger language plpgsql security definer set search_path = '' as $$
declare me bigint := public.tg_id(); staff boolean := public.is_staff(); o public.orders;
begin
  select * into o from public.orders where id = new.order_id;
  if o.id is null or (me is null and not staff) then raise exception 'chat:denied' using errcode = '42501'; end if;
  if o.status not in ('awaiting_payment', 'paid', 'return_requested', 'return_approved') then raise exception 'chat:closed' using errcode = '42501'; end if;
  if not staff and (select count(*) from public.order_messages
      where user_id = me and created_at > now() - interval '10 minutes') >= 30 then
    raise exception 'chat:too_many' using errcode = '42501';
  end if;
  if new.file_data is not null and (select count(*) from public.order_messages
      where order_id = new.order_id and file_data is not null) >= 20 then
    raise exception 'chat:too_many_files' using errcode = '42501';
  end if;
  new.user_id    := me;
  new.from_staff := staff and (me is null or o.user_id <> me);
  new.file_size  := case when new.file_data is null then null else length(new.file_data) * 3 / 4 end;
  if new.file_data is null then new.file_name := null; new.file_type := null; end if;
  new.created_at := now();
  return new;
end $$;

-- Покупателю в Telegram: возврат одобрен, вручён или в нём отказано
create or replace function public.orders_returns_to_bot()
returns trigger language plpgsql security definer set search_path = '' as $$
declare token text; txt text; local_date timestamp;
  months text[] := array['января', 'февраля', 'марта', 'апреля', 'мая', 'июня',
                         'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];
begin
  if new.user_id is null or new.status = old.status then return null; end if;
  if not (new.status in ('return_approved', 'returned') or (new.status = 'delivered' and old.status in ('return_requested', 'return_approved'))) then return null; end if;
  if to_regclass('vault.decrypted_secrets') is null then return null; end if;
  execute 'select decrypted_secret from vault.decrypted_secrets where name = ''telegram_bot_token'' limit 1' into token;
  if token is null or token = 'ВСТАВЬТЕ_ТОКЕН_БОТА' then return null; end if;
  local_date := new.created_at at time zone 'Europe/Moscow';
  txt := '💬 Менеджер VEXA · заказ от ' || extract(day from local_date)::int || ' ' || months[extract(month from local_date)::int] || E'\n\n'
    || case when new.status = 'return_approved'
         then 'Возврат одобрен. Привезите или отправьте вещь с бирками, и мы вернём ' || public.rub(new.return_amount)
           || case new.return_method when 'cash' then ' наличными' when 'card' then ' на карту' else '' end || '.'
       when new.status = 'returned'
         then 'Возврат вручён: вещь получили, вернули вам ' || public.rub(new.refund_amount)
           || case new.refund_method when 'cash' then ' наличными' when 'card' then ' на карту' else '' end || '.'
         else 'По заказу отказано в возврате: ' || coalesce(new.return_declined, '') end;
  begin
    perform net.http_post(
      url := 'https://api.telegram.org/bot' || token || '/sendMessage',
      body := jsonb_build_object('chat_id', new.user_id, 'text', left(txt, 4000)),
      headers := '{"Content-Type": "application/json"}'::jsonb);
  exception when others then null;
  end;
  return null;
end $$;
drop trigger if exists orders_returns_to_bot on public.orders;
create trigger orders_returns_to_bot after update of status on public.orders
  for each row execute function public.orders_returns_to_bot();

-- ---------- 6. Откуда пришёл клиент ----------
create table if not exists public.customer_sources (
  user_id    bigint primary key,
  source     text not null check (length(source) between 1 and 80),
  updated_by text,
  updated_at timestamptz not null default now()
);
revoke all on public.customer_sources from anon, authenticated;
alter table public.customer_sources enable row level security;

-- Покупатель отвечает при первом заказе; ответ не перезаписывается
create or replace function public.customer_source_answer(p_source text)
returns void language plpgsql volatile security definer set search_path = '' as $$
declare me bigint;
begin
  begin me := public.tg_id(); exception when others then me := null; end;
  if me is null or length(trim(coalesce(p_source, ''))) = 0 then return; end if;
  insert into public.customer_sources (user_id, source) values (me, left(trim(p_source), 80)) on conflict (user_id) do nothing;
end $$;

-- Сотрудник может указать или поправить источник в карточке клиента
create or replace function public.customer_source_set(p_user_id bigint, p_source text)
returns void language plpgsql volatile security definer set search_path = '' as $$
declare me public.staff_accounts := public.staff_current();
begin
  if me.id is null then raise exception 'staff:forbidden' using errcode = '42501'; end if;
  if length(trim(coalesce(p_source, ''))) = 0 then delete from public.customer_sources where user_id = p_user_id; return; end if;
  insert into public.customer_sources (user_id, source, updated_by) values (p_user_id, left(trim(p_source), 80), me.full_name)
  on conflict (user_id) do update set source = excluded.source, updated_by = excluded.updated_by, updated_at = now();
end $$;

-- ---------- 7. Клиенты и аналитика с учётом возвратов, себестоимости и источника ----------
-- «Купил на» — оплаченные заказы минус возвращённые деньги.
create or replace function public.customers_list()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare r jsonb;
begin
  perform public.customers_staff();
  select coalesce(jsonb_agg(c order by (c->>'last_at') desc), '[]'::jsonb) into r from (
    select jsonb_build_object(
      'id', o.user_id,
      'name', (array_agg(o.customer_name order by o.id desc))[1],
      'phone', (array_agg(o.phone order by o.id desc) filter (where coalesce(o.phone, '') <> ''))[1],
      'username', (array_agg(to_jsonb(o) ->> 'username' order by o.id desc) filter (where to_jsonb(o) ->> 'username' is not null))[1],
      'orders', count(*),
      'bought', count(*) filter (where o.status in ('paid', 'delivered', 'return_requested', 'return_approved')),
      'returns', count(*) filter (where o.status = 'returned'),
      'spent', coalesce(sum(coalesce(o.paid_amount, o.total) - coalesce(o.refund_amount, 0))
        filter (where o.status in ('paid', 'delivered', 'return_requested', 'return_approved', 'returned')), 0),
      'first_at', min(o.created_at), 'last_at', max(o.created_at),
      'source', (select s.source from public.customer_sources s where s.user_id = o.user_id),
      'tags', coalesce((select t.tags from public.customer_tags t where t.user_id = o.user_id), '{}'),
      'notes', (select count(*) from public.customer_notes n where n.user_id = o.user_id)) c
    from public.orders o
    where o.user_id is not null
    group by o.user_id) x;
  return r;
end $$;

create or replace function public.customer_card(p_user_id bigint)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare r jsonb;
begin
  perform public.customers_staff();
  select jsonb_build_object(
    'orders', coalesce((select jsonb_agg(jsonb_build_object(
        'id', o.id, 'at', o.created_at, 'status', o.status, 'total', o.total, 'items', o.items,
        'name', o.customer_name, 'phone', o.phone, 'way', o.delivery_way, 'addr', o.address,
        'paid', o.paid_amount, 'method', o.payment_method, 'manager', coalesce(o.accepted_by, o.paid_by),
        'refund', o.refund_amount)
      order by o.id desc) from public.orders o where o.user_id = p_user_id), '[]'::jsonb),
    'notes', coalesce((select jsonb_agg(jsonb_build_object('id', n.id, 'body', n.body, 'author', n.author, 'at', n.created_at)
      order by n.id desc) from public.customer_notes n where n.user_id = p_user_id), '[]'::jsonb),
    'tags', coalesce((select t.tags from public.customer_tags t where t.user_id = p_user_id), '{}'),
    'source', (select s.source from public.customer_sources s where s.user_id = p_user_id))
  into r;
  return r;
end $$;

-- Заявки за период (только директор): + возврат, себестоимость, источник клиента
create or replace function public.analytics_orders(p_from date, p_to date)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare r jsonb;
begin
  if public.app_role() <> 'admin' then raise exception 'staff:forbidden' using errcode = '42501'; end if;
  select coalesce(jsonb_agg(jsonb_build_object(
      'id', id, 'at', coalesce(accepted_at, paid_at), 'status', status, 'total', total,
      'customer', customer_name, 'manager', coalesce(accepted_by, paid_by),
      'method', payment_method, 'paid', paid_amount, 'paid_at', paid_at,
      'refund', refund_amount, 'restocked', restocked, 'return_reason', return_reason,
      'cost', coalesce(cost_total, public.order_items_cost(items)),
      'source', (select s.source from public.customer_sources s where s.user_id = o.user_id))
    order by coalesce(accepted_at, paid_at) desc), '[]'::jsonb)
  into r
  from (select * from public.orders
    where coalesce(accepted_by, paid_by) is not null
      and (p_from is null or (coalesce(accepted_at, paid_at) at time zone 'Europe/Moscow')::date >= p_from)
      and (p_to   is null or (coalesce(accepted_at, paid_at) at time zone 'Europe/Moscow')::date <= p_to)
    order by coalesce(accepted_at, paid_at) desc limit 2000) o;
  return r;
end $$;

-- Выгрузка в Excel (только директор): все заказы за период с позициями, себестоимостью и источником
create or replace function public.export_orders(p_from date, p_to date)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
begin
  if public.app_role() <> 'admin' then raise exception 'staff:forbidden' using errcode = '42501'; end if;
  return coalesce((select jsonb_agg(jsonb_build_object(
      'id', o.id, 'created_at', o.created_at, 'status', o.status, 'customer', o.customer_name, 'phone', o.phone,
      'user_id', o.user_id, 'way', o.delivery_way, 'addr', o.address, 'items', o.items, 'total', o.total,
      'manager', coalesce(o.accepted_by, o.paid_by), 'accepted_at', o.accepted_at,
      'method', o.payment_method, 'paid', o.paid_amount, 'paid_at', o.paid_at, 'delivered_at', o.delivered_at,
      'cost', coalesce(o.cost_total, public.order_items_cost(o.items)),
      'refund', o.refund_amount, 'refund_method', o.refund_method, 'returned_at', o.returned_at, 'restocked', o.restocked,
      'return_reason', coalesce(o.return_reason, o.return_request_reason),
      'source', (select s.source from public.customer_sources s where s.user_id = o.user_id))
    order by o.id) from public.orders o
    where (p_from is null or (o.created_at at time zone 'Europe/Moscow')::date >= p_from)
      and (p_to   is null or (o.created_at at time zone 'Europe/Moscow')::date <= p_to)), '[]'::jsonb);
end $$;

revoke execute on function public.product_costs_get(), public.product_cost_set(bigint, numeric), public.order_history(bigint),
  public.order_return_request(bigint, text), public.order_return(bigint, text, numeric, text, boolean),
  public.order_return_approve(bigint, text, numeric, text), public.order_return_done(bigint, boolean),
  public.order_return_decline(bigint, text), public.customer_source_answer(text), public.customer_source_set(bigint, text),
  public.customers_list(), public.customer_card(bigint), public.analytics_orders(date, date), public.export_orders(date, date) from public;
grant execute on function public.product_costs_get(), public.product_cost_set(bigint, numeric), public.order_history(bigint),
  public.order_return_request(bigint, text), public.order_return(bigint, text, numeric, text, boolean),
  public.order_return_approve(bigint, text, numeric, text), public.order_return_done(bigint, boolean),
  public.order_return_decline(bigint, text), public.customer_source_answer(text), public.customer_source_set(bigint, text),
  public.customers_list(), public.customer_card(bigint), public.analytics_orders(date, date), public.export_orders(date, date) to anon, authenticated;

-- ---------- 8. Список заказов у персонала видит новые столбцы ----------
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
select exists (select 1 from pg_proc where proname = 'order_history')
   and exists (select 1 from pg_proc where proname = 'order_return')
   and exists (select 1 from pg_tables where schemaname = 'public' and tablename = 'product_costs')
   and exists (select 1 from pg_trigger where tgname = 'orders_stock_on_insert') as "CRM настроена";
