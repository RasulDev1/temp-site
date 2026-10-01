#!/bin/bash
# ТЕМП MEN — установка на VPS (Ubuntu / Debian).
# Запуск из папки проекта:  sudo bash install.sh
# Повторный запуск обновляет код, не трогая товары, заказы и настройки.
#
# Что делает:
#   1. ставит Node.js и веб-сервер Caddy (он сам получает HTTPS-сертификат);
#   2. копирует магазин в /opt/temp-shop и спрашивает токен бота и администратора;
#   3. выдаёт адрес вида https://1-2-3-4.sslip.io (свой домен — через DOMAIN=shop.ru sudo -E bash install.sh);
#   4. включает автозапуск после перезагрузки сервера и привязывает кнопку «Магазин» в боте.
set -euo pipefail

APP_DIR=/opt/temp-shop
SERVICE=temp-shop
PORT=3000
SRC_DIR="$(cd "$(dirname "$0")" && pwd)"

say() { printf '\n\033[1m%s\033[0m\n' "$*"; }
fail() { printf '\n\033[31m✖ %s\033[0m\n' "$*"; exit 1; }

[ "$(id -u)" -eq 0 ] || fail "Запустите с правами администратора: sudo bash install.sh"
command -v apt-get >/dev/null || fail "Скрипт рассчитан на Ubuntu или Debian."

say "1/5 Устанавливаю Node.js и Caddy…"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq curl ca-certificates gnupg debian-keyring debian-archive-keyring apt-transport-https rsync >/dev/null
if ! command -v node >/dev/null || [ "$(node -p 'process.versions.node.split(".")[0]')" -lt 18 ]; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash - >/dev/null
  apt-get install -y -qq nodejs >/dev/null
fi
if ! command -v caddy >/dev/null; then
  curl -1sLf https://dl.cloudsmith.io/public/caddy/stable/gpg.key | gpg --dearmor --yes -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt > /etc/apt/sources.list.d/caddy-stable.list
  apt-get update -qq && apt-get install -y -qq caddy >/dev/null
fi
echo "Node.js $(node -v), $(caddy version | cut -d' ' -f1)"

say "2/5 Копирую магазин в $APP_DIR…"
id "$SERVICE" >/dev/null 2>&1 || useradd --system --home "$APP_DIR" --shell /usr/sbin/nologin "$SERVICE"
mkdir -p "$APP_DIR"
# data (товары, заказы) и .env (токен) на сервере не перезаписываем
rsync -a --delete --exclude data --exclude .env --exclude runtime --exclude .git "$SRC_DIR"/ "$APP_DIR"/
[ -f "$APP_DIR/.env" ] || { [ -f "$SRC_DIR/.env" ] && cp "$SRC_DIR/.env" "$APP_DIR/.env"; } || true
[ -d "$APP_DIR/data" ] || { [ -d "$SRC_DIR/data" ] && cp -r "$SRC_DIR/data" "$APP_DIR/data"; } || true
touch "$APP_DIR/.env"

say "3/5 Адрес магазина…"
if [ -z "${DOMAIN:-}" ]; then
  IP="$(curl -4 -fsS https://api.ipify.org || curl -4 -fsS https://ifconfig.me)"
  [ -n "$IP" ] || fail "Не удалось узнать IP сервера. Укажите домен: DOMAIN=shop.ru sudo -E bash install.sh"
  DOMAIN="${IP//./-}.sslip.io"   # бесплатный адрес, который указывает на IP сервера
fi
URL="https://$DOMAIN"
echo "$URL"
set_env() { grep -q "^$1=" "$APP_DIR/.env" && sed -i "s|^$1=.*|$1=$2|" "$APP_DIR/.env" || echo "$1=$2" >> "$APP_DIR/.env"; }
set_env PORT "$PORT"
set_env PUBLIC_URL "$URL"

say "4/5 Бот и администратор…"
# Спрашивает токен и ждёт сообщения боту, только если этого ещё нет в .env
systemctl stop "$SERVICE" 2>/dev/null || true   # иначе работающий магазин заберёт сообщение боту
(cd "$APP_DIR" && node launcher.js --setup) || fail "Настройка бота не завершена."
chown -R "$SERVICE:$SERVICE" "$APP_DIR"
chmod 600 "$APP_DIR/.env"

say "5/5 Автозапуск и HTTPS…"
cat > /etc/systemd/system/$SERVICE.service <<EOF
[Unit]
Description=ТЕМП MEN — магазин в Telegram
After=network-online.target
Wants=network-online.target

[Service]
User=$SERVICE
WorkingDirectory=$APP_DIR
ExecStart=$(command -v node) server.js
Restart=always
RestartSec=3
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
EOF
cat > /etc/caddy/Caddyfile <<EOF
$DOMAIN {
	encode gzip
	reverse_proxy localhost:$PORT
}
EOF
if command -v ufw >/dev/null && ufw status | grep -q "Status: active"; then ufw allow 80/tcp >/dev/null; ufw allow 443/tcp >/dev/null; fi
systemctl daemon-reload
systemctl enable --now "$SERVICE" >/dev/null 2>&1
systemctl restart "$SERVICE"
systemctl enable caddy >/dev/null 2>&1
systemctl restart caddy

printf 'Жду, пока магазин заработает по HTTPS'
for _ in $(seq 1 30); do
  if curl -fsS -o /dev/null "$URL/api/catalog"; then
    printf '\n'
    say "✔ Магазин работает: $URL"
    echo "  Кнопка «Магазин» в боте настроена. Откройте бота в Telegram."
    echo "  Перезапуск:  sudo systemctl restart $SERVICE"
    echo "  Журнал:      sudo journalctl -u $SERVICE -f"
    echo "  Обновление:  загрузите новые файлы в папку проекта и снова выполните sudo bash install.sh"
    echo "  Не запускайте этого же бота ещё где-то (START.bat, Codespaces): бот работает только в одном месте."
    exit 0
  fi
  printf '.'; sleep 4
done
printf '\n'
fail "Магазин запущен, но $URL не отвечает. Проверьте, что в панели хостинга открыты порты 80 и 443.
Журнал магазина: sudo journalctl -u $SERVICE -n 50    Журнал HTTPS: sudo journalctl -u caddy -n 50"
