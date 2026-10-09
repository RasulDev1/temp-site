#!/bin/bash
# VEXA MEN — запуск на Mac. Первый раз: правый клик по файлу → «Открыть».
cd "$(dirname "$0")"
NODE="$(command -v node || true)"
[ -z "$NODE" ] && [ -x runtime/node/bin/node ] && NODE="runtime/node/bin/node"
if [ -z "$NODE" ]; then
  echo "Node.js не найден. Скачиваю переносную версию, это нужно один раз..."
  V=v22.12.0; A=x64; [ "$(uname -m)" = "arm64" ] && A=arm64
  mkdir -p runtime && curl -fL "https://nodejs.org/dist/$V/node-$V-darwin-$A.tar.gz" | tar xz -C runtime \
    && mv "runtime/node-$V-darwin-$A" runtime/node && NODE="runtime/node/bin/node"
fi
if [ -z "$NODE" ]; then echo "Не удалось скачать Node.js. Установите его с https://nodejs.org и запустите снова."; read -r; exit 1; fi
"$NODE" launcher.js
echo; read -r -p "Нажмите Enter, чтобы закрыть окно"
