-- =====================================================================
--  ТЕМП · карточки клиентов: сводка по покупателю, его заказы, заметки и метки
--  Запускать ПОСЛЕ основного скрипта, supabase-staff.sql и supabase-payments.sql.
--  Supabase → SQL Editor → новая вкладка (New query) → вставить ЦЕЛИКОМ → Run.
--  Можно запускать повторно. Заказы не меняются; клиенты собираются из уже сделанных заказов.
--  Покупатель свою карточку, заметки и метки не видит — только директор и менеджеры.
-- =====================================================================

-- ---------- 1. Заметки менеджеров и метки клиента ----------
create table if not exists public.customer_notes (
  id         bigint generated always as identity primary key,
  user_id    bigint not null,               -- Telegram ID покупателя (как orders.user_id)
  body       text not null check (length(body) between 1 and 1000),
  author     text,
  author_id  bigint,
  created_at timestamptz not null default now()
);
create index if not exists customer_notes_user_idx on public.customer_notes (user_id, id desc);

create table if not exists public.customer_tags (
  user_id    bigint primary key,
  tags       text[] not null default '{}',
  updated_at timestamptz not null default now()
);

-- Таблицы закрыты: читать и менять их можно только через функции ниже
revoke all on public.customer_notes, public.customer_tags from anon, authenticated;
alter table public.customer_notes enable row level security;
alter table public.customer_tags enable row level security;

-- Сотрудник по входу (логин и пароль); иначе — ошибка «нет прав»
create or replace function public.customers_staff()
returns public.staff_accounts language plpgsql stable security definer set search_path = '' as $$
declare me public.staff_accounts := public.staff_current();
begin
  if me.id is null then raise exception 'staff:forbidden' using errcode = '42501'; end if;
  return me;
end $$;
revoke execute on function public.customers_staff() from public, anon, authenticated;

-- ---------- 2. Список клиентов: из заказов, сгруппированных по Telegram ID ----------
-- «Купил на» — сумма оплаченных и вручённых заказов (полученная сумма, если отмечена кнопкой «Оплатить»).
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
      'bought', count(*) filter (where o.status in ('paid', 'delivered')),
      'spent', coalesce(sum(coalesce(o.paid_amount, o.total)) filter (where o.status in ('paid', 'delivered')), 0),
      'first_at', min(o.created_at), 'last_at', max(o.created_at),
      'tags', coalesce((select t.tags from public.customer_tags t where t.user_id = o.user_id), '{}'),
      'notes', (select count(*) from public.customer_notes n where n.user_id = o.user_id)) c
    from public.orders o
    where o.user_id is not null
    group by o.user_id) x;
  return r;
end $$;

-- ---------- 3. Карточка клиента: сводка, все заказы, заметки ----------
create or replace function public.customer_card(p_user_id bigint)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare r jsonb;
begin
  perform public.customers_staff();
  select jsonb_build_object(
    'orders', coalesce((select jsonb_agg(jsonb_build_object(
        'id', o.id, 'at', o.created_at, 'status', o.status, 'total', o.total, 'items', o.items,
        'name', o.customer_name, 'phone', o.phone, 'way', o.delivery_way, 'addr', o.address,
        'paid', o.paid_amount, 'method', o.payment_method, 'manager', coalesce(o.accepted_by, o.paid_by))
      order by o.id desc) from public.orders o where o.user_id = p_user_id), '[]'::jsonb),
    'notes', coalesce((select jsonb_agg(jsonb_build_object('id', n.id, 'body', n.body, 'author', n.author, 'at', n.created_at)
      order by n.id desc) from public.customer_notes n where n.user_id = p_user_id), '[]'::jsonb),
    'tags', coalesce((select t.tags from public.customer_tags t where t.user_id = p_user_id), '{}'))
  into r;
  return r;
end $$;

-- ---------- 4. Заметки и метки ----------
create or replace function public.customer_note_add(p_user_id bigint, p_body text)
returns void language plpgsql volatile security definer set search_path = '' as $$
declare me public.staff_accounts := public.customers_staff();
begin
  if length(trim(coalesce(p_body, ''))) = 0 then raise exception 'staff:empty' using errcode = '22023'; end if;
  insert into public.customer_notes (user_id, body, author, author_id) values (p_user_id, left(trim(p_body), 1000), me.full_name, me.id);
end $$;

-- Удалить заметку может её автор или директор
create or replace function public.customer_note_delete(p_id bigint)
returns void language plpgsql volatile security definer set search_path = '' as $$
declare me public.staff_accounts := public.customers_staff();
begin
  delete from public.customer_notes where id = p_id and (author_id = me.id or me.role = 'admin');
  if not found then raise exception 'staff:forbidden' using errcode = '42501'; end if;
end $$;

create or replace function public.customer_tags_set(p_user_id bigint, p_tags text[])
returns void language plpgsql volatile security definer set search_path = '' as $$
begin
  perform public.customers_staff();
  insert into public.customer_tags (user_id, tags, updated_at)
  values (p_user_id, coalesce((select array_agg(distinct left(trim(t), 30)) from unnest(p_tags) t where trim(t) <> ''), '{}'), now())
  on conflict (user_id) do update set tags = excluded.tags, updated_at = now();
end $$;

revoke execute on function public.customers_list(), public.customer_card(bigint), public.customer_note_add(bigint, text),
  public.customer_note_delete(bigint), public.customer_tags_set(bigint, text[]) from public;
grant execute on function public.customers_list(), public.customer_card(bigint), public.customer_note_add(bigint, text),
  public.customer_note_delete(bigint), public.customer_tags_set(bigint, text[]) to anon, authenticated;

notify pgrst, 'reload schema';

-- ---------- Проверка: должно быть «true» ----------
select exists (select 1 from pg_proc where proname = 'customer_card')
   and exists (select 1 from pg_tables where schemaname = 'public' and tablename = 'customer_notes') as "карточки клиентов настроены";
