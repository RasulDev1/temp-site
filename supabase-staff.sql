-- =====================================================================
--  VEXA · вход сотрудников по логину и паролю (директор и менеджеры)
--  Запускать ПОСЛЕ основного скрипта, supabase-chat.sql и supabase-archive.sql.
--  Supabase → SQL Editor → новая вкладка (New query) → вставить ЦЕЛИКОМ → Run.
--  Можно запускать повторно: аккаунты сотрудников не удаляются.
--
--  После этого права сотрудника даёт ТОЛЬКО вход по логину и паролю
--  (роли по Telegram ID больше не действуют).
--  Если заново запускаете основной скрипт настройки базы — после него запустите этот ещё раз.
-- =====================================================================

-- ---------- 0. ВАШ АККАУНТ ДИРЕКТОРА ----------
-- Впишите логин и пароль директора (пароль — не короче 8 символов).
-- Если аккаунт уже создан, оставьте ВПИШИТЕ_… как есть — он не изменится.
-- Чтобы сменить пароль директора, впишите тот же логин и новый пароль и запустите скрипт снова.
do $$
declare
  director_name     text := 'Абуев Расул';
  director_login    text := 'ВПИШИТЕ_ЛОГИН';
  director_password text := 'ВПИШИТЕ_ПАРОЛЬ';
begin
  create extension if not exists pgcrypto with schema extensions;

  create table if not exists public.staff_accounts (
    id            bigint generated always as identity primary key,
    login         text not null unique,
    password_hash text not null,
    full_name     text not null,
    role          text not null default 'manager' check (role in ('manager', 'admin')),
    failed_logins int not null default 0,
    locked_until  timestamptz,
    created_at    timestamptz not null default now()
  );
  create table if not exists public.staff_sessions (
    token_hash text primary key,
    account_id bigint not null references public.staff_accounts (id) on delete cascade,
    expires_at timestamptz not null
  );

  if director_login <> 'ВПИШИТЕ_ЛОГИН' and director_password <> 'ВПИШИТЕ_ПАРОЛЬ' then
    if length(director_password) < 8 then raise exception 'Пароль директора должен быть не короче 8 символов'; end if;
    insert into public.staff_accounts (login, password_hash, full_name, role)
    values (lower(trim(director_login)), extensions.crypt(director_password, extensions.gen_salt('bf', 10)), director_name, 'admin')
    on conflict (login) do update set password_hash = excluded.password_hash, full_name = excluded.full_name,
      role = 'admin', failed_logins = 0, locked_until = null;
  end if;
end $$;

-- Таблицы закрыты: читать и менять их можно только через функции ниже
revoke all on public.staff_accounts, public.staff_sessions from anon, authenticated;
alter table public.staff_accounts enable row level security;
alter table public.staff_sessions enable row level security;

-- ---------- 1. Сессия сотрудника: заголовок X-Staff-Token ----------
create or replace function public.staff_current()
returns public.staff_accounts language sql stable security definer set search_path = '' as $$
  select a.* from public.staff_sessions s join public.staff_accounts a on a.id = s.account_id
  where s.token_hash = encode(extensions.digest(
          nullif(nullif(current_setting('request.headers', true), '')::json ->> 'x-staff-token', ''), 'sha256'), 'hex')
    and s.expires_at > now()
$$;
revoke execute on function public.staff_current() from public, anon, authenticated;

-- Роль для правил доступа: теперь только по входу сотрудника (логин и пароль)
create or replace function public.app_role()
returns text language sql stable security definer set search_path = '' as $$
  select coalesce((select role from public.staff_current()), 'none')
$$;

-- ---------- 2. Вход, проверка, выход ----------
-- Ошибки входа возвращаются как {"error": "..."}, а не исключением — чтобы счётчик неверных паролей сохранялся
create or replace function public.staff_login(p_login text, p_password text)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare a public.staff_accounts; token text;
begin
  select * into a from public.staff_accounts where login = lower(trim(coalesce(p_login, '')));
  if a.id is null then
    perform pg_sleep(0.4);
    return jsonb_build_object('error', 'bad_credentials');
  end if;
  if a.locked_until > now() then return jsonb_build_object('error', 'locked'); end if;
  if extensions.crypt(coalesce(p_password, ''), a.password_hash) <> a.password_hash then
    -- 5 неверных паролей подряд — вход в этот аккаунт блокируется на 15 минут
    update public.staff_accounts set
      locked_until  = case when failed_logins + 1 >= 5 then now() + interval '15 minutes' end,
      failed_logins = case when failed_logins + 1 >= 5 then 0 else failed_logins + 1 end
    where id = a.id;
    perform pg_sleep(0.4);
    return jsonb_build_object('error', 'bad_credentials');
  end if;
  update public.staff_accounts set failed_logins = 0, locked_until = null where id = a.id;
  delete from public.staff_sessions where expires_at < now();
  token := encode(extensions.gen_random_bytes(32), 'hex');
  insert into public.staff_sessions (token_hash, account_id, expires_at)
  values (encode(extensions.digest(token, 'sha256'), 'hex'), a.id, now() + interval '30 days');
  return jsonb_build_object('token', token, 'name', a.full_name, 'login', a.login, 'role', a.role,
    'staff_topic', public.realtime_topic('staff'));
end $$;

create or replace function public.staff_me()
returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_build_object('name', a.full_name, 'login', a.login, 'role', a.role,
           'staff_topic', public.realtime_topic('staff'))
  from public.staff_current() a where a.id is not null
$$;

create or replace function public.staff_logout()
returns void language sql volatile security definer set search_path = '' as $$
  delete from public.staff_sessions
  where token_hash = encode(extensions.digest(
          nullif(nullif(current_setting('request.headers', true), '')::json ->> 'x-staff-token', ''), 'sha256'), 'hex')
$$;

-- ---------- 3. «Сотрудники»: директор заводит ФИО, логин и пароль ----------
create or replace function public.staff_list()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare me public.staff_accounts := public.staff_current();
begin
  if me.role is distinct from 'admin' then raise exception 'staff:forbidden' using errcode = '42501'; end if;
  return coalesce((select jsonb_agg(jsonb_build_object('id', id, 'name', full_name, 'login', login, 'role', role,
           'me', id = me.id) order by role, full_name) from public.staff_accounts), '[]'::jsonb);
end $$;

create or replace function public.staff_save(p_id bigint, p_name text, p_login text, p_password text)
returns void language plpgsql volatile security definer set search_path = '' as $$
declare me public.staff_accounts := public.staff_current(); l text := lower(trim(coalesce(p_login, '')));
begin
  if me.role is distinct from 'admin' then raise exception 'staff:forbidden' using errcode = '42501'; end if;
  if length(trim(coalesce(p_name, ''))) not between 2 and 80 then raise exception 'staff:bad_name' using errcode = '22023'; end if;
  if l !~ '^[a-z0-9._-]{3,32}$' then raise exception 'staff:bad_login' using errcode = '22023'; end if;
  if coalesce(p_password, '') <> '' and length(p_password) < 8 then raise exception 'staff:short_password' using errcode = '22023'; end if;
  if exists (select 1 from public.staff_accounts where login = l and id is distinct from p_id) then
    raise exception 'staff:login_taken' using errcode = '23505';
  end if;
  if p_id is null then
    if coalesce(p_password, '') = '' then raise exception 'staff:short_password' using errcode = '22023'; end if;
    insert into public.staff_accounts (login, password_hash, full_name, role)
    values (l, extensions.crypt(p_password, extensions.gen_salt('bf', 10)), trim(p_name), 'manager');
  else
    update public.staff_accounts set full_name = trim(p_name), login = l,
      password_hash = case when coalesce(p_password, '') = '' then password_hash
                           else extensions.crypt(p_password, extensions.gen_salt('bf', 10)) end,
      failed_logins = 0, locked_until = null
    where id = p_id;
    -- сменили пароль — старые входы этого сотрудника закрываются (кроме вашего текущего)
    if coalesce(p_password, '') <> '' then
      delete from public.staff_sessions where account_id = p_id and account_id <> me.id;
    end if;
  end if;
end $$;

create or replace function public.staff_delete(p_id bigint)
returns void language plpgsql volatile security definer set search_path = '' as $$
declare me public.staff_accounts := public.staff_current();
begin
  if me.role is distinct from 'admin' then raise exception 'staff:forbidden' using errcode = '42501'; end if;
  if p_id = me.id then raise exception 'staff:self' using errcode = '42501'; end if;
  delete from public.staff_accounts where id = p_id;
end $$;

revoke execute on function public.staff_login(text, text), public.staff_me(), public.staff_logout(),
  public.staff_list(), public.staff_save(bigint, text, text, text), public.staff_delete(bigint) from public;
grant execute on function public.staff_login(text, text), public.staff_me(), public.staff_logout(),
  public.staff_list(), public.staff_save(bigint, text, text, text), public.staff_delete(bigint) to anon, authenticated;

-- ---------- 4. Чат: менеджер пишет по своему входу, Telegram для этого не нужен ----------
create or replace function public.order_messages_before_insert()
returns trigger language plpgsql security definer set search_path = '' as $$
declare me bigint := public.tg_id(); staff boolean := public.is_staff(); o public.orders;
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

notify pgrst, 'reload schema';

-- ---------- Проверка ----------
select (select count(*) from public.staff_accounts where role = 'admin') as "директоров (нужно 1+)",
       exists (select 1 from pg_proc where proname = 'staff_login')  as "вход по паролю настроен";
