-- =====================================================================
--  VEXA · переписка по заказу (покупатель ↔ менеджер, файлы, чеки)
--  Запускать ПОСЛЕ основного скрипта настройки базы (там tg_id, is_staff, realtime_topic).
--  Supabase → SQL Editor → вставить ЦЕЛИКОМ → Run. Токен бота здесь не нужен.
--  Можно запускать повторно: сообщения не удаляются, правила доступа пересоздаются.
-- =====================================================================

-- ---------- 1. Таблица сообщений ----------
create table if not exists public.order_messages (
  id bigint generated always as identity primary key
);
alter table public.order_messages add column if not exists order_id   bigint;
alter table public.order_messages add column if not exists user_id    bigint;
alter table public.order_messages add column if not exists from_staff boolean not null default false;
alter table public.order_messages add column if not exists body       text;
alter table public.order_messages add column if not exists file_name  text;
alter table public.order_messages add column if not exists file_type  text;
alter table public.order_messages add column if not exists file_size  integer;
alter table public.order_messages add column if not exists file_data  text;   -- файл в base64
alter table public.order_messages add column if not exists created_at timestamptz not null default now();
create index if not exists order_messages_order_idx on public.order_messages (order_id, id);

alter table public.order_messages drop constraint if exists order_messages_order_fk;
alter table public.order_messages add constraint order_messages_order_fk
  foreign key (order_id) references public.orders (id) on delete cascade;
alter table public.order_messages drop constraint if exists order_messages_content_check;
alter table public.order_messages add constraint order_messages_content_check check (
  order_id is not null
  and (body is null or length(body) between 1 and 2000)
  and (body is not null or file_data is not null)
  and (file_data is null or (
        length(file_data) <= 4500000                                   -- ~3,3 МБ файла
        and file_type in ('image/jpeg', 'image/png', 'image/webp', 'application/pdf')
        and length(coalesce(file_name, '')) between 1 and 200)));

-- ---------- 2. Кто пишет: база сама ставит отправителя и проверяет статус заказа ----------
create or replace function public.order_messages_before_insert()
returns trigger language plpgsql security definer set search_path = '' as $$
declare me bigint := public.tg_id(); o public.orders;
begin
  select * into o from public.orders where id = new.order_id;
  if me is null or o.id is null then raise exception 'chat:denied' using errcode = '42501'; end if;
  -- писать можно, когда менеджер принял заказ (отправил реквизиты) и после оплаты
  if o.status not in ('awaiting_payment', 'paid') then raise exception 'chat:closed' using errcode = '42501'; end if;
  -- защита от спама: не больше 30 сообщений за 10 минут и 20 файлов на заказ
  if (select count(*) from public.order_messages
      where user_id = me and created_at > now() - interval '10 minutes') >= 30 then
    raise exception 'chat:too_many' using errcode = '42501';
  end if;
  if new.file_data is not null and (select count(*) from public.order_messages
      where order_id = new.order_id and file_data is not null) >= 20 then
    raise exception 'chat:too_many_files' using errcode = '42501';
  end if;
  new.user_id    := me;
  new.from_staff := o.user_id <> me;          -- не владелец заказа = менеджер (правило ниже пускает только персонал)
  new.file_size  := case when new.file_data is null then null else length(new.file_data) * 3 / 4 end;
  if new.file_data is null then new.file_name := null; new.file_type := null; end if;
  new.created_at := now();
  return new;
end $$;
drop trigger if exists order_messages_before_insert on public.order_messages;
create trigger order_messages_before_insert before insert on public.order_messages
  for each row execute function public.order_messages_before_insert();

-- Realtime: в канал уходит только номер заказа; сообщения сайт перечитывает обычным запросом (под RLS)
create or replace function public.order_messages_notify()
returns trigger language plpgsql security definer set search_path = '' as $$
declare owner bigint;
begin
  select user_id into owner from public.orders where id = new.order_id;
  begin
    perform realtime.send(jsonb_build_object('id', new.order_id, 'op', 'message', 'staff', new.from_staff),
                          'changed', public.realtime_topic('staff'), false);
    perform realtime.send(jsonb_build_object('id', new.order_id, 'op', 'message', 'staff', new.from_staff),
                          'changed', public.realtime_topic('user', owner), false);
  exception when others then null;
  end;
  return null;
end $$;
drop trigger if exists order_messages_notify on public.order_messages;
create trigger order_messages_notify after insert on public.order_messages
  for each row execute function public.order_messages_notify();

-- ---------- 3. Права и правила доступа (RLS) ----------
revoke all on public.order_messages from anon, authenticated;
grant select on public.order_messages to anon, authenticated;
grant insert (order_id, body, file_name, file_type, file_data) on public.order_messages to anon, authenticated;

do $$ declare p record; begin
  for p in select policyname from pg_policies where schemaname = 'public' and tablename = 'order_messages' loop
    execute format('drop policy %I on public.order_messages', p.policyname);
  end loop;
end $$;
alter table public.order_messages enable row level security;

-- читать и писать: покупатель — только в своих заказах, менеджер и директор — во всех
create policy order_messages_select on public.order_messages for select to anon, authenticated
  using (exists (select 1 from public.orders o where o.id = order_id
                 and (o.user_id = (select public.tg_id()) or (select public.is_staff()))));
create policy order_messages_insert on public.order_messages for insert to anon, authenticated
  with check (exists (select 1 from public.orders o where o.id = order_id
                      and (o.user_id = (select public.tg_id()) or (select public.is_staff()))));

-- Сводка для списка заказов: сколько сообщений и номер последнего от каждой стороны
create or replace view public.order_chat_summary with (security_invoker = true) as
  select order_id,
         count(*)::int                                        as total,
         coalesce(max(id) filter (where from_staff), 0)       as last_staff,
         coalesce(max(id) filter (where not from_staff), 0)   as last_customer
  from public.order_messages group by order_id;
revoke all on public.order_chat_summary from anon, authenticated;
grant select on public.order_chat_summary to anon, authenticated;

notify pgrst, 'reload schema';

-- ---------- Проверка: должно быть «true» ----------
select exists (select 1 from pg_tables where schemaname = 'public' and tablename = 'order_messages') as "таблица чата есть",
       exists (select 1 from pg_views  where schemaname = 'public' and viewname  = 'order_chat_summary') as "сводка чата есть";
