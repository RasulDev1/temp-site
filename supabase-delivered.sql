-- =====================================================================
--  ТЕМП · статус заказа «Вручён» (кнопка «Вручить» у менеджера)
--  Supabase → SQL Editor → новая вкладка (New query) → вставить ЦЕЛИКОМ → Run.
--  Можно запускать повторно. Заказы не меняются.
--
--  ВАЖНО: если когда-нибудь будете заново запускать ОСНОВНОЙ скрипт настройки базы,
--  сначала поправьте в нём строку проверки статусов, добавив 'delivered':
--    check (status in ('new', 'awaiting_payment', 'paid', 'delivered', 'cancelled'));
--  иначе основной скрипт остановится с ошибкой, если в базе уже есть вручённые заказы.
-- =====================================================================

alter table public.orders drop constraint if exists orders_status_check;
alter table public.orders add constraint orders_status_check
  check (status in ('new', 'awaiting_payment', 'paid', 'delivered', 'cancelled'));

notify pgrst, 'reload schema';

-- ---------- Проверка: должно быть «true» ----------
select pg_get_constraintdef(oid) like '%delivered%' as "статус «вручён» добавлен"
from pg_constraint where conname = 'orders_status_check';
