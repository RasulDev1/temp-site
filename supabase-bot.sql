-- =====================================================================
--  ТЕМП · переписка по заказу и в Telegram-боте, синхронно с сайтом
--  Запускать ПОСЛЕ supabase-chat.sql и supabase-staff.sql.
--  Supabase → SQL Editor → новая вкладка (New query) → вставить ЦЕЛИКОМ → Run.
--  Можно запускать повторно.
--
--  Что делает:
--   • сообщение менеджера в чате заказа на сайте → бот сразу пишет его покупателю в Telegram;
--   • ответ покупателя боту (текст, фото, PDF) → функция telegram-bot кладёт его в чат заказа на сайте.
--  Токен бота берётся из Supabase Vault — тот же, что для входа через Telegram.
-- =====================================================================

-- Отправка HTTP-запросов из базы (к Telegram)
create extension if not exists pg_net;

-- Адрес магазина — для кнопок «Открыть заказ» в сообщениях бота
create or replace function public.bot_shop_url()
returns text language sql immutable set search_path = '' as $$
  select 'https://rasuldev1.github.io/temp-site/'
$$;

-- Какой заказ покупатель выбрал в боте («Мои заказы» → нажал на заказ): туда уходят его следующие сообщения
create table if not exists public.bot_chat_state (
  telegram_id bigint primary key,
  order_id    bigint,
  updated_at  timestamptz not null default now()
);
revoke all on public.bot_chat_state from anon, authenticated;
grant all on public.bot_chat_state to service_role;
alter table public.bot_chat_state enable row level security;

-- ---------- 1. Кто пишет в чат: покупатель на сайте, покупатель через бота или сотрудник ----------
create or replace function public.order_messages_before_insert()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  -- покупатель на сайте — по подписи Telegram; через бота — его ID передаёт функция bot_customer_message
  me bigint := coalesce(public.tg_id(), nullif(current_setting('temp.bot_sender', true), '')::bigint);
  staff boolean := public.is_staff();
  o public.orders;
begin
  select * into o from public.orders where id = new.order_id;
  if o.id is null or (me is null and not staff) then raise exception 'chat:denied' using errcode = '42501'; end if;
  if o.status not in ('awaiting_payment', 'paid') then raise exception 'chat:closed' using errcode = '42501'; end if;
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

-- ---------- 2. Покупатель написал боту → в чат заказа ----------
-- Вызывает только функция telegram-bot (ключ service_role). Заказ: тот, на чьё сообщение покупатель ответил,
-- иначе его последний принятый или оплаченный заказ.
create or replace function public.bot_customer_message(
  p_telegram_id bigint, p_order_id bigint, p_body text, p_file_name text, p_file_type text, p_file_data text)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare o public.orders;
begin
  if p_order_id is not null then
    select * into o from public.orders where id = p_order_id and user_id = p_telegram_id;
  end if;
  if o.id is null or o.status not in ('awaiting_payment', 'paid') then
    select * into o from public.orders
    where user_id = p_telegram_id and status in ('awaiting_payment', 'paid') order by id desc limit 1;
  end if;
  if o.id is null then return jsonb_build_object('error', 'no_open_order'); end if;
  perform set_config('temp.bot_sender', p_telegram_id::text, true);
  insert into public.order_messages (order_id, body, file_name, file_type, file_data)
  values (o.id, nullif(left(trim(coalesce(p_body, '')), 2000), ''), p_file_name, p_file_type, p_file_data);
  perform set_config('temp.bot_sender', '', true);
  return jsonb_build_object('order_id', o.id);
exception when others then
  perform set_config('temp.bot_sender', '', true);
  return jsonb_build_object('error', coalesce(substring(sqlerrm from 'chat:([a-z_]+)'), 'server'));
end $$;
revoke execute on function public.bot_customer_message(bigint, bigint, text, text, text, text) from public, anon, authenticated;
grant execute on function public.bot_customer_message(bigint, bigint, text, text, text, text) to service_role;

-- ---------- 3. Менеджер написал на сайте → бот отправляет покупателю ----------
create or replace function public.order_messages_to_bot()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  owner bigint; created timestamptz; local_date timestamp; token text; txt text;
  months text[] := array['января', 'февраля', 'марта', 'апреля', 'мая', 'июня',
                         'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];
begin
  if not new.from_staff then return null; end if;
  select user_id, created_at into owner, created from public.orders where id = new.order_id;
  select decrypted_secret into token from vault.decrypted_secrets where name = 'telegram_bot_token' limit 1;
  if owner is null or token is null or token = 'ВСТАВЬТЕ_ТОКЕН_БОТА' then return null; end if;
  local_date := created at time zone 'Europe/Moscow'; -- дата по времени магазина (Краснодар)
  -- покупателю — без номера заказа: «заказ от 3 октября»
  txt := '💬 Менеджер ТЕМП · заказ от ' || extract(day from local_date)::int || ' ' || months[extract(month from local_date)::int]
      || case when coalesce(new.body, '') <> '' then E'\n\n' || new.body else '' end
      || case when new.file_name is not null
              then E'\n\n📎 Менеджер прислал файл «' || new.file_name || '» — его можно открыть в магазине, в чате заказа.' else '' end
      || E'\n\nОтветить можно прямо здесь.';
  -- менеджер написал по этому заказу — ответ покупателя в боте уйдёт сюда же
  insert into public.bot_chat_state (telegram_id, order_id) values (owner, new.order_id)
  on conflict (telegram_id) do update set order_id = excluded.order_id, updated_at = now();
  begin
    perform net.http_post(
      url := 'https://api.telegram.org/bot' || token || '/sendMessage',
      body := jsonb_build_object('chat_id', owner, 'text', txt,
        'reply_markup', jsonb_build_object('inline_keyboard', jsonb_build_array(jsonb_build_array(
          jsonb_build_object('text', '📦 Открыть заказ', 'web_app', jsonb_build_object('url', public.bot_shop_url() || '?tab=orders')))))),
      headers := '{"Content-Type": "application/json"}'::jsonb);
  exception when others then null; -- бот не смог отправить — на сайте сообщение всё равно есть
  end;
  return null;
end $$;
drop trigger if exists order_messages_to_bot on public.order_messages;
create trigger order_messages_to_bot after insert on public.order_messages
  for each row execute function public.order_messages_to_bot();

notify pgrst, 'reload schema';

-- ---------- Проверка: должно быть «true» ----------
select exists (select 1 from pg_extension where extname = 'pg_net')           as "отправка из базы включена",
       exists (select 1 from pg_proc where proname = 'bot_customer_message') as "приём сообщений из бота готов",
       exists (select 1 from pg_tables where tablename = 'bot_chat_state')    as "выбор заказа в боте готов";
