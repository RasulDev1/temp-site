// Вход для сотрудников по ссылке …/crm.html (старая …/staff.html перенаправляет туда): логин и пароль выдаёт директор в «Сотрудниках».
import { $, haptic, toast, emit } from "./core.js?v=20261001b";
import { state, useSupabase } from "./state.js?v=20261001b";
import { staffLogin } from "./supabase.js?v=20261001b";
import { sheetBody, openSheet, closeSheet } from "./nav.js?v=20261001b";

const LOGIN_ERRORS = {
  bad_credentials: "Неверный логин или пароль.",
  locked: "Слишком много неверных попыток. Вход в этот аккаунт закрыт на 15 минут.",
  no_function: "Вход для сотрудников ещё не настроен: в Supabase нужно запустить supabase-staff.sql.",
  network: "Нет связи с базой. Проверьте интернет и повторите.",
};

export function openStaffLogin() {
  sheetBody.innerHTML = `<div class="grab"></div><h2 class="p-name">Вход для сотрудников</h2>
    ${useSupabase ? `<p class="adm-sub">Логин и пароль выдаёт директор.</p>
    <label class="field"><span>Логин</span><input id="staffLoginName" autocomplete="username" autocapitalize="none" autocorrect="off" spellcheck="false"></label>
    <label class="field"><span>Пароль</span><input id="staffPassword" type="password" autocomplete="current-password"></label>
    <p class="hint" id="hint"></p>
    <button class="primary" id="staffSignIn">Войти</button>`
    : `<p class="adm-sub">Вход для сотрудников работает только с базой Supabase (js/config.js).</p>`}`;
  // Обработчики ничего не возвращают: false из onkeydown отменил бы ввод с клавиатуры
  sheetBody.onclick = (e) => { if (e.target.id === "staffSignIn") signIn(e.target); };
  sheetBody.onkeydown = (e) => { if (state.view === "staffLogin" && e.key === "Enter") signIn($("staffSignIn")); };
  openSheet("staffLogin");
  setTimeout(() => $("staffLoginName")?.focus(), 350);
}

let signingIn = false;
async function signIn(button) {
  if (signingIn || !button) return;
  const login = $("staffLoginName").value.trim(), password = $("staffPassword").value;
  if (!login || !password) { $("hint").textContent = "Введите логин и пароль"; return haptic("medium"); }
  signingIn = button.disabled = true;
  button.textContent = "Входим…";
  try {
    state.staffSession = await staffLogin(login, password);
    history.replaceState(null, "", location.pathname); // убираем ?staff из адреса
    closeSheet();
    emit("staffrole");
    haptic("success");
    toast(`Вы вошли: ${state.staffSession.name}`);
  } catch (error) {
    $("hint").textContent = LOGIN_ERRORS[error.code] || "Не удалось войти. Повторите через минуту.";
    $("staffPassword").value = "";
    haptic("medium");
  } finally {
    signingIn = button.disabled = false;
    button.textContent = "Войти";
  }
}
