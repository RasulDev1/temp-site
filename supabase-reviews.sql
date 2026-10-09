-- =====================================================================
--  VEXA · Отзывы о товарах
--  Отзыв закреплён за товаром. Оставить его может только покупатель, которому этот товар вручили
--  (заказ «Вручён», в том числе если потом оформили возврат). Один отзыв на товар от покупателя, его можно изменить.
--  Сотрудники могут скрыть отзыв и ответить на него от имени магазина.
--  Запускать ПОСЛЕ supabase-staff.sql и supabase-crm.sql.
--  Supabase → SQL Editor → новая вкладка (New query) → вставить ЦЕЛИКОМ → Run. Можно запускать повторно.
-- =====================================================================

create table if not exists public.product_reviews (
  id          bigint generated always as identity primary key,
  product_id  bigint not null,
  user_id     bigint not null,                 -- Telegram ID покупателя
  author      text   not null,                 -- «Иван П.» — из ФИО в заказе
  rating      int    not null check (rating between 1 and 5),
  body        text   not null default '' check (char_length(body) <= 1000),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  hidden      boolean not null default false,  -- скрыт сотрудником
  hidden_by   text,
  reply       text check (reply is null or char_length(reply) <= 1000),
  reply_by    text,
  reply_at    timestamptz,
  unique (product_id, user_id)
);
create index if not exists product_reviews_product on public.product_reviews (product_id, created_at desc);
revoke all on public.product_reviews from anon, authenticated;
alter table public.product_reviews enable row level security;

-- Telegram ID покупателя или null (сайт открыт не в Telegram)
create or replace function public.review_me()
returns bigint language plpgsql stable security definer set search_path = '' as $$
begin
  return public.tg_id();
exception when others then return null;
end $$;
revoke execute on function public.review_me() from public, anon, authenticated;

-- Покупателю вручили этот товар
create or replace function public.review_allowed(p_user bigint, p_product bigint)
returns boolean language sql stable security definer set search_path = '' as $$
  select p_user is not null and exists (
    select 1 from public.orders o, jsonb_array_elements(case when jsonb_typeof(o.items) = 'array' then o.items else '[]'::jsonb end) i
    where o.user_id = p_user and o.status in ('delivered', 'return_requested', 'returned') and i ->> 'id' = p_product::text)
$$;
revoke execute on function public.review_allowed(bigint, bigint) from public, anon, authenticated;

create or replace function public.review_json(r public.product_reviews, p_staff boolean)
returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_build_object('id', r.id, 'product', r.product_id, 'author', r.author, 'rating', r.rating, 'body', r.body,
    'at', r.created_at, 'edited', r.updated_at > r.created_at + interval '1 minute', 'reply', r.reply, 'reply_at', r.reply_at)
    || case when p_staff then jsonb_build_object('hidden', r.hidden, 'hidden_by', r.hidden_by, 'reply_by', r.reply_by, 'user_id', r.user_id) else '{}'::jsonb end
$$;
revoke execute on function public.review_json(public.product_reviews, boolean) from public, anon, authenticated;

-- Средняя оценка и число отзывов по всем товарам — для звёздочек в каталоге. Видно всем.
create or replace function public.reviews_summary()
returns jsonb language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_object_agg(product_id::text, jsonb_build_object('avg', avg_rating, 'count', n)), '{}'::jsonb)
  from (select product_id, round(avg(rating), 1) as avg_rating, count(*) as n
        from public.product_reviews where not hidden group by product_id) s
$$;
grant execute on function public.reviews_summary() to anon, authenticated;

-- Отзывы о товаре. Покупателю ещё: может ли он оставить отзыв и его собственный отзыв. Сотруднику — и скрытые.
create or replace function public.product_reviews_get(p_product bigint)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare me bigint := public.review_me(); staff boolean := public.is_staff(); mine public.product_reviews;
begin
  select * into mine from public.product_reviews where product_id = p_product and user_id = me;
  return jsonb_build_object(
    'reviews', coalesce((select jsonb_agg(public.review_json(r, staff) order by r.created_at desc)
                         from public.product_reviews r where r.product_id = p_product and (staff or not r.hidden)), '[]'::jsonb),
    'can_review', public.review_allowed(me, p_product),
    'mine', case when mine.id is null then null else public.review_json(mine, false) || jsonb_build_object('hidden', mine.hidden) end);
end $$;
grant execute on function public.product_reviews_get(bigint) to anon, authenticated;

-- Оценки покупателя по его товарам: { "id товара": оценка } — для «Мои заказы»
create or replace function public.my_reviews()
returns jsonb language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_object_agg(product_id::text, rating), '{}'::jsonb) from public.product_reviews where user_id = public.review_me()
$$;
grant execute on function public.my_reviews() to anon, authenticated;

-- Оставить или изменить отзыв. Ошибки: staff:not_bought — товар не вручали; staff:bad_rating
create or replace function public.review_save(p_product bigint, p_rating int, p_body text)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare me bigint := public.review_me(); fio text; parts text[]; who text; r public.product_reviews;
begin
  if not public.review_allowed(me, p_product) then raise exception 'staff:not_bought' using errcode = '42501'; end if;
  if p_rating is null or p_rating not between 1 and 5 then raise exception 'staff:bad_rating' using errcode = '22023'; end if;
  -- ФИО из последнего заказа: «Петров Иван Сергеевич» → «Иван П.»
  select customer_name into fio from public.orders where user_id = me and coalesce(customer_name, '') <> '' order by created_at desc limit 1;
  parts := regexp_split_to_array(btrim(coalesce(fio, '')), '\s+');
  who := case when coalesce(array_length(parts, 1), 0) >= 2 then parts[2] || ' ' || left(parts[1], 1) || '.'
              when coalesce(parts[1], '') <> '' then parts[1] else 'Покупатель' end;
  insert into public.product_reviews (product_id, user_id, author, rating, body)
  values (p_product, me, who, p_rating, left(btrim(coalesce(p_body, '')), 1000))
  on conflict (product_id, user_id) do update
    set rating = excluded.rating, body = excluded.body, author = excluded.author, updated_at = now()
  returning * into r;
  return public.review_json(r, false);
end $$;
grant execute on function public.review_save(bigint, int, text) to anon, authenticated;

-- Удалить свой отзыв (покупатель) или любой (директор)
create or replace function public.review_delete(p_id bigint)
returns void language plpgsql volatile security definer set search_path = '' as $$
declare me bigint := public.review_me();
begin
  if public.app_role() = 'admin' then delete from public.product_reviews where id = p_id; return; end if;
  delete from public.product_reviews where id = p_id and user_id = me;
  if not found then raise exception 'staff:forbidden' using errcode = '42501'; end if;
end $$;
grant execute on function public.review_delete(bigint) to anon, authenticated;

-- Все отзывы для раздела «Отзывы» в панели, новые сверху
create or replace function public.reviews_list()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
begin
  if not public.is_staff() then raise exception 'staff:forbidden' using errcode = '42501'; end if;
  return coalesce((select jsonb_agg(public.review_json(r, true) order by r.created_at desc)
                   from (select * from public.product_reviews order by created_at desc limit 500) r), '[]'::jsonb);
end $$;
grant execute on function public.reviews_list() to anon, authenticated;

-- Скрыть или вернуть отзыв (сотрудник)
create or replace function public.review_hide(p_id bigint, p_hidden boolean)
returns void language plpgsql volatile security definer set search_path = '' as $$
declare me public.staff_accounts := public.staff_current();
begin
  if me.id is null then raise exception 'staff:forbidden' using errcode = '42501'; end if;
  update public.product_reviews set hidden = coalesce(p_hidden, false), hidden_by = case when p_hidden then me.full_name end where id = p_id;
end $$;
grant execute on function public.review_hide(bigint, boolean) to anon, authenticated;

-- Ответ магазина на отзыв (сотрудник); пустой текст убирает ответ
create or replace function public.review_reply(p_id bigint, p_text text)
returns void language plpgsql volatile security definer set search_path = '' as $$
declare me public.staff_accounts := public.staff_current(); t text := nullif(left(btrim(coalesce(p_text, '')), 1000), '');
begin
  if me.id is null then raise exception 'staff:forbidden' using errcode = '42501'; end if;
  update public.product_reviews set reply = t, reply_by = case when t is null then null else me.full_name end,
    reply_at = case when t is null then null else now() end where id = p_id;
end $$;
grant execute on function public.review_reply(bigint, text) to anon, authenticated;

-- Проверка: должно показать «Отзывы настроены» = true
select to_regclass('public.product_reviews') is not null and to_regprocedure('public.review_save(bigint, integer, text)') is not null as "Отзывы настроены";
