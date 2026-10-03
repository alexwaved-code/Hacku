const DISTRICTS = [
  ["central", "中西區", "Central and Western"],
  ["wan-chai", "灣仔", "Wan Chai"],
  ["eastern", "東區", "Eastern"],
  ["southern", "南區", "Southern"],
  ["yau-tsim-mong", "油尖旺", "Yau Tsim Mong"],
  ["sham-shui-po", "深水埗", "Sham Shui Po"],
  ["kowloon-city", "九龍城", "Kowloon City"],
  ["wong-tai-sin", "黃大仙", "Wong Tai Sin"],
  ["kwun-tong", "觀塘", "Kwun Tong"],
  ["kwai-tsing", "葵青", "Kwai Tsing"],
  ["tsuen-wan", "荃灣", "Tsuen Wan"],
  ["tuen-mun", "屯門", "Tuen Mun"],
  ["yuen-long", "元朗", "Yuen Long"],
  ["north", "北區", "North"],
  ["tai-po", "大埔", "Tai Po"],
  ["sha-tin", "沙田", "Sha Tin"],
  ["sai-kung", "西貢", "Sai Kung"],
  ["islands", "離島", "Islands"],
];

const METHODS = [
  ["visa", "methodVisa", "pay-visa.svg"],
  ["mastercard", "methodMastercard", "pay-mastercard.svg"],
  ["unionpay", "methodUnionpay", "pay-unionpay.svg"],
  ["fps", "methodFps", "pay-fps.png"],
  ["alipay", "methodAlipay", "pay-alipay.svg"],
  ["wechat", "methodWechat", "pay-wechat.svg"],
];

function phoneOk(value) {
  const compact = value.replace(/[\s-]/g, "");
  return /^(?:\+?852)?[2-9]\d{7}$/.test(compact);
}

function localize(root) {
  root.querySelectorAll("[data-i18n]").forEach((el) => {
    el.textContent = t(el.dataset.i18n);
  });
  root.querySelectorAll("[data-i18n-attr]").forEach((el) => {
    for (const pair of el.dataset.i18nAttr.split(",")) {
      const [attr, key] = pair.split(":");
      el.setAttribute(attr.trim(), t(key.trim()));
    }
  });
}

function paintFields(root) {
  const district = root.querySelector("#district");
  const selected = district.value;
  district.replaceChildren(new Option(t("chooseDistrict"), ""));
  const lang = HackuText.get();
  for (const [id, zh, en] of DISTRICTS) district.add(new Option(lang === "en" ? en : zh, id));
  if ([...district.options].some((option) => option.value === selected)) district.value = selected;

  const methods = root.querySelector("#methods");
  const picked = methods.querySelector("input:checked")?.value || "";
  methods.replaceChildren(
    ...METHODS.map(([id, key, src]) => {
      const input = document.createElement("input");
      input.type = "radio";
      input.name = "payment";
      input.value = id;
      input.required = true;
      if (id === picked) input.checked = true;
      const mark = document.createElement("img");
      mark.src = src;
      mark.alt = "";
      mark.width = 72;
      mark.height = 40;
      const name = document.createElement("span");
      name.className = "method-name";
      name.textContent = t(key);
      const label = document.createElement("label");
      label.className = "method";
      label.append(input, mark, name);
      return label;
    })
  );
}

function fill(form, profile) {
  form.consignee.value = profile.consignee;
  form.phone.value = profile.phone;
  form.line1.value = profile.line1;
  form.line2.value = profile.line2;
  form.district.value = profile.district;
  const picked = form.querySelector(`input[name="payment"][value="${profile.payment}"]`);
  if (picked) picked.checked = true;
  else form.querySelectorAll('input[name="payment"]').forEach((input) => (input.checked = false));
}

function read(form) {
  const payment = form.querySelector('input[name="payment"]:checked');
  return {
    consignee: form.consignee.value,
    phone: form.phone.value,
    line1: form.line1.value,
    line2: form.line2.value,
    district: form.district.value,
    payment: payment ? payment.value : "",
  };
}

function show(form, kind, key) {
  const status = form.querySelector("#status");
  status.className = `settings-status ${kind}`;
  status.textContent = t(key);
}

function showSettingsPane(form, pane) {
  const shell = form.closest(".settings-shell");
  if (!shell) return;
  shell.querySelectorAll("[data-pane]").forEach((button) => {
    button.setAttribute("aria-pressed", String(button.dataset.pane === pane));
  });
  shell.querySelectorAll("[data-pane-panel]").forEach((panel) => {
    panel.hidden = panel.dataset.panePanel !== pane;
  });
  const heading = shell.querySelector(".settings-bar h2");
  if (heading) heading.textContent = t(pane === "pay" ? "payment" : "settingsTitle");
}

function bindForm(form) {
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    const profile = read(form);
    if (!profile.consignee || !profile.line1 || !profile.district) {
      showSettingsPane(form, "info");
      form.reportValidity();
      return;
    }
    if (!phoneOk(profile.phone)) {
      showSettingsPane(form, "info");
      show(form, "bad", "phoneInvalid");
      form.phone.focus();
      return;
    }
    if (!profile.payment) {
      showSettingsPane(form, "pay");
      show(form, "bad", "paymentRequired");
      return;
    }
    HackuProfile.save(profile);
    show(form, "ok", "settingsSaved");
  });
  form.querySelector("#clear").addEventListener("click", () => {
    fill(form, HackuProfile.clear());
    show(form, "ok", "settingsCleared");
  });
}

function formMarkup() {
  return `
    <form id="settings" class="settings">
      <div class="info-grid" data-pane-panel="info">
        <label class="field">
          <span data-i18n="consignee">收件人姓名</span>
          <input id="consignee" name="consignee" type="text" maxlength="80" autocomplete="name" required />
        </label>
        <label class="field">
          <span data-i18n="contact">聯絡電話</span>
          <input id="phone" name="phone" type="tel" maxlength="24" inputmode="tel" autocomplete="tel" placeholder="9123 4567" required />
        </label>
        <label class="field">
          <span data-i18n="address1">街道、大廈</span>
          <input id="line1" name="line1" type="text" maxlength="120" autocomplete="address-line1" required />
        </label>
        <label class="field">
          <span data-i18n="address2">樓層、單位（可留空）</span>
          <input id="line2" name="line2" type="text" maxlength="120" autocomplete="address-line2" />
        </label>
        <label class="field">
          <span data-i18n="district">地區</span>
          <select id="district" name="district" autocomplete="address-level2" required></select>
        </label>
      </div>
      <div data-pane-panel="pay" hidden>
        <p class="hint" data-i18n="paymentNote">只記下你想用哪一種。真正付款在 Stripe 結帳頁完成。</p>
        <div class="methods" id="methods"></div>
      </div>
      <div class="settings-actions">
        <button type="submit" class="pay" data-i18n="saveSettings">儲存</button>
        <button type="button" id="clear" class="pill" data-i18n="clearSettings">清除</button>
        <p id="status" class="settings-status" role="status"></p>
      </div>
    </form>`;
}

const pageForm = document.querySelector("#settings");
if (pageForm) {
  HackuText.apply();
  document.title = `${t("settingsTitle")} · ${t("title")}`;
  paintFields(document);
  fill(pageForm, HackuProfile.load());
  bindForm(pageForm);
  document.querySelectorAll("[data-lang]").forEach((button) => {
    button.addEventListener("click", () => {
      HackuText.set(button.dataset.lang);
      document.title = `${t("settingsTitle")} · ${t("title")}`;
      paintFields(document);
    });
  });
} else {
  let dialog;

  function paintDialog() {
    localize(dialog);
    paintFields(dialog);
    const form = dialog.querySelector("#settings");
    const pane = dialog.querySelector("[data-pane][aria-pressed='true']")?.dataset.pane || "info";
    showSettingsPane(form, pane);
  }

  function openSettings() {
    if (!dialog) {
      dialog = document.createElement("dialog");
      dialog.className = "settings-dialog";
      dialog.innerHTML = `
        <div class="settings-shell">
          <nav class="settings-nav" data-i18n-attr="aria-label:settingsTitle" aria-label="收件設定">
            <button type="button" data-pane="info" aria-pressed="true" data-i18n-attr="aria-label:settingsInfo" aria-label="收件資料">
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <rect x="5" y="3" width="14" height="18" rx="2" fill="none" stroke="currentColor" stroke-width="2"></rect>
                <circle cx="12" cy="9" r="2" fill="none" stroke="currentColor" stroke-width="2"></circle>
                <path d="M8.5 15.5c.6-1.5 1.8-2.2 3.5-2.2s2.9.7 3.5 2.2" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"></path>
              </svg>
            </button>
            <button type="button" data-pane="pay" aria-pressed="false" data-i18n-attr="aria-label:payment" aria-label="付款方式">
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <path d="M4 7.2A2.2 2.2 0 0 1 6.2 5H18a2 2 0 0 1 2 2v1.2H6.4A2.4 2.4 0 0 1 4 5.8v1.4z" fill="currentColor"></path>
                <path d="M3 9h18v9.2A1.8 1.8 0 0 1 19.2 20H4.8A1.8 1.8 0 0 1 3 18.2V9z" fill="currentColor"></path>
                <path d="M15 12.2h6v3.6h-6a1.8 1.8 0 0 1 0-3.6z" fill="var(--paper)"></path>
                <circle cx="16.1" cy="14" r="0.7" fill="currentColor"></circle>
              </svg>
            </button>
          </nav>
          <div class="settings-main">
            <div class="settings-bar">
              <h2 data-i18n="settingsTitle">收件設定</h2>
              <button type="button" class="settings-x" data-i18n-attr="aria-label:close" aria-label="關閉">
                <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"></path></svg>
              </button>
            </div>
            ${formMarkup()}
          </div>
        </div>`;
      document.body.append(dialog);
      const form = dialog.querySelector("#settings");
      bindForm(form);
      dialog.querySelectorAll("[data-pane]").forEach((button) => {
        const bounce = () => {
          const icon = button.querySelector("svg");
          icon.classList.remove("bounce");
          void icon.offsetWidth;
          icon.classList.add("bounce");
        };
        button.addEventListener("pointerenter", bounce);
        button.addEventListener("click", (event) => {
          if (event.button !== 0) return;
          bounce();
          showSettingsPane(form, button.dataset.pane);
        });
      });
      dialog.querySelector(".settings-x").addEventListener("click", () => dialog.close());
      dialog.addEventListener("click", (event) => {
        if (event.target === dialog) dialog.close();
      });
    }
    paintDialog();
    const form = dialog.querySelector("#settings");
    showSettingsPane(form, "info");
    fill(form, HackuProfile.load());
    const status = form.querySelector("#status");
    status.textContent = "";
    status.className = "settings-status";
    if (!dialog.open) dialog.showModal();
  }

  document.addEventListener("click", (event) => {
    const link = event.target.closest('a[href="settings.html"]');
    if (!link) return;
    event.preventDefault();
    openSettings();
  });

  document.addEventListener("click", (event) => {
    if (!dialog?.open || !event.target.closest("[data-lang]")) return;
    paintDialog();
  });
}
