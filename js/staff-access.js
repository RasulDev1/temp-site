// Ключ доступа к репозиторию GitHub: без него изменения в товарах не сохраняются (GitHub Pages).
// Открывается, когда сотрудник нажимает «Товары», а ключа на этом устройстве ещё нет.
import { $, escapeHtml, haptic, openLink } from "./core.js?v=20261001b";
import { errorMessage } from "./state.js?v=20261001b";
import { repository, signIn, signOut, hasGitHubKey } from "./github.js?v=20261001b";
import { isDirector } from "./roles.js?v=20261001b";
import { sheetBody, openSheet } from "./nav.js?v=20261001b";

const TOKEN_PAGE = "https://github.com/settings/personal-access-tokens/new";

/** Как директору создать ключ — для себя и для каждого менеджера */
export const keyInstructions = () => `<ol class="steps">
  <li>Откройте страницу создания ключа на GitHub.</li>
  <li><b>Token name</b> — например «Магазин», <b>Expiration</b> — «No expiration» или год.</li>
  <li><b>Repository access</b> → <b>Only select repositories</b> → <b>${escapeHtml(repository.split("/")[1])}</b>.</li>
  <li><b>Permissions</b> → <b>Repository permissions</b> → <b>Contents</b> → <b>Read and write</b>.</li>
  <li><b>Generate token</b> — скопируйте ключ, он начинается с <b>github_pat_</b>.</li>
</ol>`;

/** reason — почему открыли (например, сотрудник нажал «Товары» без ключа) */
export function openStaffAccess(reason = "") {
  sheetBody.innerHTML = `<div class="grab"></div>
    <h2 class="p-name">Ключ для изменения товаров</h2>
    ${reason ? `<p class="ord-note">${reason}</p>` : ""}
    ${hasGitHubKey() ? `<p class="adm-sub">Ключ сохранён на этом устройстве — изменения сохраняются.</p>
      <button class="ghost danger" id="removeKey">Удалить ключ с этого устройства</button>`
    : `<p class="adm-sub">Товары, цены и остатки хранятся в репозитории GitHub. Чтобы сохранять изменения, на этом устройстве нужен ключ доступа.
        ${isDirector() ? "Создайте его:" : "Его выдаёт директор."}</p>
      ${isDirector() ? `${keyInstructions()}<button class="ghost" id="openTokenPage" style="width:100%">Открыть GitHub</button>` : ""}
      <label class="field"><span>Ключ</span><input id="githubKey" autocomplete="off" placeholder="github_pat_…"></label>
      <p class="hint" id="hint"></p>
      <button class="primary" id="saveKey">Сохранить ключ</button>`}`;
  sheetBody.onclick = async (e) => {
    const t = e.target;
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
