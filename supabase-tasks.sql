-- =====================================================================
--  ТЕМП · задачи и напоминания для сотрудников («перезвонить клиенту в пятницу»)
--  Запускать ПОСЛЕ основного скрипта, supabase-staff.sql и supabase-bot.sql.
--  Supabase → SQL Editor → новая вкладка (New query) → вставить ЦЕЛИКОМ → Run.
--  Можно запускать повторно. Задачи не удаляются.
--
--  Напоминание в срок задачи приходит:
--   • на сайте — счётчик на кнопке «Задачи» и всплывающее сообщение;
--   • в Telegram от бота — если сотрудник один раз нажал «Получать в Telegram» в разделе «Задачи»,
--     открыв магазин через бота. Проверка раз в минуту (pg_cron), токен бота — из Supabase Vault.
-- =====================================================================

-- ---------- 1. Telegram сотрудника: куда слать напоминания ----------
alter table public.staff_accounts add column if not exists telegram_id bigint;

-- ---------- 2. Задачи ----------
create table if not exists public.staff_tasks (
  id             bigint generated always as identity primary key,
  title          text not null check (length(title) between 1 and 500),
  due_at         timestamptz not null,
  customer_id    bigint,          -- Telegram ID клиента (как orders.user_id)
  customer_name  text,
  order_id       bigint,
  assignee_id    bigint references public.staff_accounts (id) on delete set null,
  assignee_name  text,
  created_by_id  bigint,
  created_by     text,
  created_at     timestamptz not null default now(),
  done_at        timestamptz,
  done_by        text,
  notified_at    timestamptz      -- напоминание уже отправлено
);
create index if not exists staff_tasks_due_idx on public.staff_tasks (due_at) where done_at is null;
create index if not exists staff_tasks_customer_idx on public.staff_tasks (customer_id);

-- Таблица закрыта: читать и менять задачи можно только через функции ниже
revoke all on public.staff_tasks from anon, authenticated;
alter table public.staff_tasks enable row level security;

create or replace function public.tasks_me()
returns public.staff_accounts language plpgsql stable security definer set search_path = '' as $$
declare me public.staff_accounts := public.staff_current();
begin
  if me.id is null then raise exception 'staff:forbidden' using errcode = '42501'; end if;
  return me;
end $$;
revoke execute on function public.tasks_me() from public, anon, authenticated;

create or replace function public.task_json(t public.staff_tasks, me public.staff_accounts)
returns jsonb language sql stable set search_path = '' as $$
  select jsonb_build_object('id', t.id, 'title', t.title, 'due', t.due_at,
    'customer_id', t.customer_id, 'customer', t.customer_name, 'order_id', t.order_id,
    'assignee_id', t.assignee_id, 'assignee', t.assignee_name, 'created_by', t.created_by,
    'done_at', t.done_at, 'done_by', t.done_by, 'mine', t.assignee_id = me.id,
    'can_delete', t.created_by_id = me.id or me.role = 'admin')
$$;
revoke execute on function public.task_json(public.staff_tasks, public.staff_accounts) from public, anon, authenticated;

-- ---------- 3. Список: мои (назначены мне или поставлены мной) или все (только директор) ----------
-- Открытые задачи — все; выполненные — за последние 14 дней. p_customer — задачи одного клиента.
create or replace function public.tasks_list(p_all boolean, p_customer bigint)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare me public.staff_accounts := public.tasks_me(); r jsonb;
begin
  select coalesce(jsonb_agg(public.task_json(t, me) order by t.done_at is not null, t.due_at), '[]'::jsonb) into r
  from public.staff_tasks t
  where (p_customer is null or t.customer_id = p_customer)
    and (p_customer is not null or (p_all and me.role = 'admin') or t.assignee_id = me.id or t.created_by_id = me.id)
    and (t.done_at is null or t.done_at > now() - interval '14 days');
  return r;
end $$;

-- Кому можно поручить задачу, и подключён ли Telegram у меня
create or replace function public.tasks_staff()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare me public.staff_accounts := public.tasks_me();
begin
  return jsonb_build_object('me', me.id, 'telegram', me.telegram_id is not null,
    'staff', coalesce((select jsonb_agg(jsonb_build_object('id', a.id, 'name', a.full_name) order by a.full_name)
                       from public.staff_accounts a), '[]'::jsonb));
end $$;

-- ---------- 4. Создать или изменить задачу ----------
create or replace function public.task_save(p_id bigint, p_title text, p_due timestamptz, p_customer bigint,
  p_customer_name text, p_order bigint, p_assignee bigint)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare me public.staff_accounts := public.tasks_me(); who public.staff_accounts; t public.staff_tasks;
begin
  if length(trim(coalesce(p_title, ''))) = 0 then raise exception 'staff:empty' using errcode = '22023'; end if;
  if p_due is null then raise exception 'staff:no_due' using errcode = '22023'; end if;
  select * into who from public.staff_accounts where id = coalesce(p_assignee, me.id);
  if who.id is null then raise exception 'staff:no_assignee' using errcode = '22023'; end if;
  if p_id is null then
    insert into public.staff_tasks (title, due_at, customer_id, customer_name, order_id, assignee_id, assignee_name, created_by_id, created_by)
    values (left(trim(p_title), 500), p_due, p_customer, nullif(trim(coalesce(p_customer_name, '')), ''), p_order,
            who.id, who.full_name, me.id, me.full_name)
    returning * into t;
  else
    update public.staff_tasks set title = left(trim(p_title), 500), due_at = p_due, assignee_id = who.id, assignee_name = who.full_name,
      notified_at = case when due_at = p_due and assignee_id = who.id then notified_at end
    where id = p_id and (assignee_id = me.id or created_by_id = me.id or me.role = 'admin')
    returning * into t;
    if t.id is null then raise exception 'staff:forbidden' using errcode = '42501'; end if;
  end if;
  return public.task_json(t, me);
end $$;

create or replace function public.task_done(p_id bigint, p_done boolean)
returns void language plpgsql volatile security definer set search_path = '' as $$
declare me public.staff_accounts := public.tasks_me();
begin
  update public.staff_tasks set done_at = case when p_done then now() end, done_by = case when p_done then me.full_name end
  where id = p_id and (assignee_id = me.id or created_by_id = me.id or me.role = 'admin');
  if not found then raise exception 'staff:forbidden' using errcode = '42501'; end if;
end $$;

-- Удалить задачу может тот, кто её поставил, или директор
create or replace function public.task_delete(p_id bigint)
returns void language plpgsql volatile security definer set search_path = '' as $$
declare me public.staff_accounts := public.tasks_me();
begin
  delete from public.staff_tasks where id = p_id and (created_by_id = me.id or me.role = 'admin');
  if not found then raise exception 'staff:forbidden' using errcode = '42501'; end if;
end $$;

-- ---------- 5. «Получать в Telegram»: привязать Telegram, с которого открыт магазин ----------
create or replace function public.staff_link_telegram()
returns boolean language plpgsql volatile security definer set search_path = '' as $$
declare me public.staff_accounts := public.tasks_me(); tg bigint := public.tg_id();
begin
  if tg is null then raise exception 'staff:no_telegram' using errcode = '22023'; end if;
  update public.staff_accounts set telegram_id = tg where id = me.id;
  return true;
end $$;

create or replace function public.staff_unlink_telegram()
returns void language plpgsql volatile security definer set search_path = '' as $$
declare me public.staff_accounts := public.tasks_me();
begin
  update public.staff_accounts set telegram_id = null where id = me.id;
end $$;

-- ---------- 6. Напоминания в Telegram: раз в минуту отправить наступившие задачи ----------
create or replace function public.tasks_send_reminders()
returns int language plpgsql volatile security definer set search_path = '' as $$
declare token text; t record; sent int := 0;
begin
  select decrypted_secret into token from vault.decrypted_secrets where name = 'telegram_bot_token' limit 1;
  for t in
    update public.staff_tasks s set notified_at = now()
    where s.done_at is null and s.notified_at is null and s.due_at <= now() and s.due_at > now() - interval '3 days'
    returning s.*
  loop
    continue when token is null or token = 'ВСТАВЬТЕ_ТОКЕН_БОТА';
    declare chat bigint := (select telegram_id from public.staff_accounts where id = t.assignee_id);
    begin
      continue when chat is null;
      perform net.http_post(
        url := 'https://api.telegram.org/bot' || token || '/sendMessage',
        body := jsonb_build_object('chat_id', chat,
          'text', '⏰ Задача: ' || t.title
            || case when t.customer_name is not null then E'\nКлиент: ' || t.customer_name else '' end
            || case when t.order_id is not null then E'\nЗаказ №' || t.order_id else '' end
            || E'\nСрок: ' || to_char(t.due_at at time zone 'Europe/Moscow', 'DD.MM HH24:MI')
            || case when t.created_by is not null and t.created_by is distinct from t.assignee_name then E'\nПоставил: ' || t.created_by else '' end,
          'reply_markup', jsonb_build_object('inline_keyboard', jsonb_build_array(jsonb_build_array(
            jsonb_build_object('text', '✅ Открыть задачи', 'web_app', jsonb_build_object('url', public.bot_shop_url() || '?tasks')))))),
        headers := '{"Content-Type": "application/json"}'::jsonb);
      sent := sent + 1;
    exception when others then null; -- не отправилось — задача всё равно видна на сайте
    end;
  end loop;
  return sent;
end $$;
revoke execute on function public.tasks_send_reminders() from public, anon, authenticated;

revoke execute on function public.tasks_list(boolean, bigint), public.tasks_staff(),
  public.task_save(bigint, text, timestamptz, bigint, text, bigint, bigint), public.task_done(bigint, boolean),
  public.task_delete(bigint), public.staff_link_telegram(), public.staff_unlink_telegram() from public;
grant execute on function public.tasks_list(boolean, bigint), public.tasks_staff(),
  public.task_save(bigint, text, timestamptz, bigint, text, bigint, bigint), public.task_done(bigint, boolean),
  public.task_delete(bigint), public.staff_link_telegram(), public.staff_unlink_telegram() to anon, authenticated;

-- Расписание: каждую минуту (pg_cron). Если расширение недоступно — напоминания будут только на сайте.
do $$ begin
  create extension if not exists pg_cron;
  perform cron.unschedule(jobid) from cron.job where jobname = 'temp-task-reminders';
  perform cron.schedule('temp-task-reminders', '* * * * *', 'select public.tasks_send_reminders()');
exception when others then raise notice 'pg_cron недоступен: напоминания в Telegram не включены (%)', sqlerrm;
end $$;

notify pgrst, 'reload schema';

-- ---------- Проверка: «задачи настроены» — true; «напоминания в Telegram» — true, если pg_cron включился ----------
select exists (select 1 from pg_proc where proname = 'tasks_list') as "задачи настроены",
       exists (select 1 from pg_extension where extname = 'pg_cron') as "напоминания в Telegram";
