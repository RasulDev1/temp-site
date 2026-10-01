// «Для сотрудников»: свой Telegram ID (его директор вписывает при назначении менеджера)
// и ключ доступа, без которого изменения не сохраняются в репозиторий (GitHub Pages).
import { $, telegramUser, escapeHtml, haptic, openLink, copyToClipboard } from "./core.js?v=20261001b";
import { state, errorMessage } from "./state.js?v=20261001b";
import { repository, signIn, signOut, hasGitHubKey } from "./github.js?v=20261001b";
import { isStaff, isDirector } from "./roles.js?v=20261001b";
import { sheetBody, openSheet } from "./nav.js?v=20261001b";

const TOKEN_PAGE = "https://github.com/settings/personal-access-tokens/new";

/** Как директору создать ключ — ему для себя и для каждого менеджера */
export const keyInstructions = () => `<ol class="steps">
  <li>Откройте страницу создания ключа на GitHub.</li>
  <li><b>Token name</b> — например «Магазин», <b>Expiration</b> — «No expiration» или год.</li>
  <li><b>Repository access</b> → <b>Only select repositories</b> → <b>${escapeHtml(repository.split("/")[1])}</b>.</li>
  <li><b>Permissions</b> → <b>Repository permissions</b> → <b>Contents</b> → <b>Read and write</b>.</li>
  <li><b>Generate token</b> — скопируйте ключ, он начинается с <b>github_pat_</b>.</li>
</ol>`;

function keySection() {
  if (hasGitHubKey()) return `<p class="label">Ключ доступа</p>
    <p class="adm-sub">Ключ сохранён на этом устройстве — изменения сохраняются.</p>
    <button class="ghost danger" id="removeKey">Удалить ключ с этого устройства</button>`;
  if (!isStaff()) return "";
  return `<p class="label">Ключ доступа</p>
    <p class="adm-sub">Чтобы изменения в каталоге сохранялись, на этом устройстве нужен ключ доступа к репозиторию.
      ${isDirector() ? "Создайте его:" : "Его выдаёт директор."}</p>
    ${isDirector() ? `${keyInstructions()}<button class="ghost" id="openTokenPage" style="width:100%">Открыть GitHub</button>` : ""}
    <label class="field"><span>Ключ</span><input id="githubKey" autocomplete="off" placeholder="github_pat_…"></label>
    <p class="hint" id="hint"></p>
    <button class="primary" id="saveKey">Сохранить ключ</button>`;
}

/** reason — почему открыли (например, сотрудник нажал «Управление товарами» без ключа) */
export function openStaffAccess(reason = "") {
  const id = telegramUser?.id;
  sheetBody.innerHTML = `<div class="grab"></div>
    <h2 class="p-name">Для сотрудников</h2>
    ${reason ? `<p class="ord-note">${reason}</p>` : ""}
    ${isStaff() ? `<p class="adm-sub">Вы вошли как: <b>${escapeHtml(state.role.position)}</b>, ${escapeHtml(state.role.name)}.</p>` : ""}
    ${id ? `<p class="label">Ваш Telegram ID</p>
      <div class="req"><p class="req-t">${id}</p><button class="ghost copy" id="copyId">Скопировать</button></div>
      ${isStaff() ? "" : `<p class="adm-sub" style="margin-top:8px">Чтобы директор назначил вас менеджером, отправьте ему этот номер.</p>`}`
    : `<p class="adm-sub">Откройте магазин через бота в Telegram — здесь появится ваш Telegram ID.</p>`}
    ${keySection()}`;
  sheetBody.onclick = async (e) => {
    const t = e.target;
    if (t.id === "copyId") copyToClipboard(String(id), t);
    if (t.id === "openTokenPage") openLink(TOKEN_PAGE);
    if (t.id === "removeKey") { signOut(); location.reload(); }
    if (t.id !== "saveKey") return;
    const key = $("githubKey").value.trim();
    if (!key) { $("hint").textContent = "Вставьте ключ"; return haptic("medium"); }
    t.disabled = true;
    t.textContent = "Проверяем ключ…";
    try {
      await signIn(key);
      haptic("success");
      location.reload();
    } catch (error) {
      t.disabled = false;
      t.textContent = "Сохранить ключ";
      $("hint").textContent = error.code === "forbidden" ? "Ключ не даёт права записи в этот репозиторий." : errorMessage(error);
    }
  };
  openSheet("staffAccess");
}
