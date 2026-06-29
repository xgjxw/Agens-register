const REDFOX_TEXT = {
  register: ["注册", "sign up", "create account"],
  login: ["登录", "sign in"],
  sendCode: ["获取验证码", "发送验证码", "send code", "get code", "verification code"],
  submitRegister: ["注册", "确认注册", "sign up", "create account"],
  keyManagement: ["密钥管理", "api key", "api keys", "key management"],
  createKey: ["创建密钥", "创建", "create key", "create", "generate"],
  confirmCreate: ["确认创建", "确认", "创建", "confirm", "ok"],
  saved: ["我已保存", "完成", "确认", "saved", "done", "ok"],
  logout: ["退出登录", "退出", "logout", "sign out", "log out"]
};

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  handleRedFoxMessage(message)
    .then((data) => sendResponse({ ok: true, data }))
    .catch((error) => {
      console.error("[RedFox]", error);
      sendResponse({ ok: false, error: error.message || String(error) });
    });
  return true;
});

async function handleRedFoxMessage(message) {
  switch (message?.type) {
    case "redfox:startRegistration":
      return startRegistration(message.payload || {});
    case "redfox:completeRegistration":
      return completeRegistration(message.payload || {});
    case "redfox:createApiKey":
      return createApiKey(message.payload || {});
    case "redfox:logout":
      return logout();
    default:
      throw new Error(`未知 RedFox 消息: ${message?.type}`);
  }
}

async function startRegistration({ email }) {
  await waitForReady();
  await openRegisterEntry();

  const emailInput = await waitForElement(() => findEmailInput(), 15000);
  if (!emailInput) {
    throw new Error("未找到 RedFox 注册邮箱输入框");
  }

  setInputValue(emailInput, email);
  await delay(800);
  if (!String(emailInput.value || "").includes(email)) {
    throw new Error("RedFox 邮箱输入框未成功写入，可能命中了隐藏表单或受控输入");
  }

  const codeButton = await waitForElement(() => findSendCodeTrigger(emailInput), 12000);
  if (!codeButton) {
    throw new Error("未找到 RedFox 获取验证码按钮");
  }

  if (!isDisabled(codeButton) && !isVerificationCountdownActive()) {
    clickElementRobustly(codeButton);
  }

  await delay(1200);
  return { sent: true };
}

async function completeRegistration({ code, password }) {
  await waitForReady();

  const codeInput = await waitForElement(() => findCodeInput(), 30000);
  if (!codeInput) {
    throw new Error("未找到 RedFox 验证码输入框");
  }
  setInputValue(codeInput, code);

  const passwordInputs = findPasswordInputs();
  if (passwordInputs.length < 1) {
    throw new Error("未找到 RedFox 密码输入框");
  }
  setInputValue(passwordInputs[0], password);
  if (passwordInputs[1]) {
    setInputValue(passwordInputs[1], password);
  }

  await delay(1000);

  const submitButton = await waitForElement(() => findSubmitRegisterButton(), 12000);
  if (!submitButton) {
    throw new Error("未找到 RedFox 注册提交按钮");
  }
  clickElementRobustly(submitButton);

  await delay(300);
  return { submitted: true };
}

async function createApiKey({ round }) {
  await waitForReady();
  await ensureAccountPage();

  const keyEntry = await waitForElement(() => findClickableByText(REDFOX_TEXT.keyManagement), 10000);
  if (keyEntry) {
    clickElementRobustly(keyEntry);
    await delay(1200);
  }

  const createButton = await waitForElement(() => findCreateKeyButton(), 15000);
  if (!createButton) {
    throw new Error("未找到 RedFox 创建密钥按钮");
  }
  clickElementRobustly(createButton);
  await delay(1200);

  const keyName = `redfox-auto-${round}-${Date.now()}`;
  const nameInput = await waitForElement(() => findKeyNameInput(), 10000);
  if (!nameInput) {
    throw new Error("未找到 RedFox 密钥名称输入框");
  }
  setInputValue(nameInput, keyName);
  await delay(500);

  const confirmButton = await waitForElement(() => findCreateDialogConfirmButton(), 10000);
  if (!confirmButton) {
    throw new Error("未找到 RedFox 确认创建按钮");
  }
  clickElementRobustly(confirmButton);

  const apiKey = await waitForApiKeyValue(20000, keyName);
  if (!apiKey) {
    throw new Error("RedFox 创建密钥后未读取到完整 API Key");
  }

  const savedButton = await waitForElement(() => findSavedButton(), 8000);
  if (savedButton) {
    clickElementRobustly(savedButton);
    await delay(800);
  }

  return { apiKey };
}

async function logout() {
  await waitForReady();

  const logoutEntry = findClickableByText(REDFOX_TEXT.logout);
  if (logoutEntry) {
    clickElementRobustly(logoutEntry);
    await delay(1000);
    return { loggedOut: true };
  }

  return { loggedOut: false, reason: "未找到退出入口" };
}

async function openRegisterEntry() {
  const currentText = normalizeText(document.body.innerText || "");
  if (currentText.includes("确认密码") || currentText.includes("获取验证码")) {
    return;
  }

  const registerTab = findClickableByText(REDFOX_TEXT.register);
  if (registerTab) {
    clickElementRobustly(registerTab);
    await delay(1200);
  }
}

function findEmailInput() {
  return firstVisible([
    ...document.querySelectorAll("input[name='email'], input[type='email']"),
    findInputByHints(["邮箱", "email", "your@email.com"])
  ]);
}

function findCodeInput() {
  return firstVisible([
    ...document.querySelectorAll("input[name='code'], input[name='verification_code']"),
    findInputByHints(["验证码", "verification", "code"])
  ]);
}

function findPasswordInputs() {
  const inputs = Array.from(document.querySelectorAll("input[type='password'], input")).filter((input) => {
    const haystack = fieldHaystack(input);
    return isElementVisible(input) && (haystack.includes("密码") || haystack.includes("password"));
  });
  return uniqueInputs(inputs);
}

function findKeyNameInput() {
  return firstVisible([
    findInputByHints(["密钥名称", "名称", "name", "key name"]),
    ...(getTopVisibleDialog()?.querySelectorAll("input") || [])
  ]);
}

function findInputByHints(hints) {
  const inputs = Array.from(document.querySelectorAll("input, textarea")).filter(isElementVisible);
  return inputs.find((input) => hints.some((hint) => fieldHaystack(input).includes(String(hint).toLowerCase()))) || null;
}

function firstVisible(items) {
  return items.flat().filter(Boolean).find(isElementVisible) || null;
}

function fieldHaystack(input) {
  return normalizeText(
    [
      input.placeholder,
      input.name,
      input.id,
      input.type,
      input.getAttribute("aria-label"),
      input.getAttribute("title"),
      getFieldLabelText(input)
    ]
      .filter(Boolean)
      .join(" ")
  );
}

function getFieldLabelText(input) {
  const label = input.closest("label");
  if (label?.innerText) {
    return label.innerText;
  }
  const formItem = input.closest(".ant-form-item, .form-item, .field, div");
  return formItem?.innerText?.slice(0, 160) || "";
}

function uniqueInputs(inputs) {
  const seen = new Set();
  const unique = [];
  for (const input of inputs) {
    const key = input.name || input.id || input.placeholder || input.outerHTML.slice(0, 80);
    if (!seen.has(key)) {
      seen.add(key);
      unique.push(input);
    }
  }
  return unique;
}

function findSendCodeTrigger(emailInput) {
  const codeInput = findCodeInput();
  const roots = [
    codeInput?.closest(".ant-form-item, .form-item, .field, div"),
    codeInput?.parentElement,
    emailInput?.closest("form"),
    document.body
  ].filter(Boolean);

  for (const root of roots) {
    const trigger = findButtonByText(REDFOX_TEXT.sendCode, root);
    if (trigger && isElementVisible(trigger)) {
      return trigger;
    }
  }

  return null;
}

function findSubmitRegisterButton() {
  const form = findCodeInput()?.closest("form") || document;
  const exact = Array.from(form.querySelectorAll("button, a, div[role='button'], span[role='button']")).find((el) => {
    const text = normalizeText(el.textContent || "");
    return text === "注册" || text.includes("确认注册") || text === "sign up";
  });
  if (exact && isElementVisible(exact)) {
    return exact;
  }
  return findButtonByText(REDFOX_TEXT.submitRegister, form);
}

function findCreateKeyButton() {
  const candidates = Array.from(document.querySelectorAll("button, a, div[role='button'], span[role='button']"));
  return (
    candidates.find((el) => {
      const text = normalizeText(el.textContent || "");
      return (text.includes("创建密钥") || text.includes("create key")) && isElementVisible(el);
    }) ||
    findButtonByText(REDFOX_TEXT.createKey)
  );
}

function findCreateDialogConfirmButton() {
  const dialog = getTopVisibleDialog() || document;
  return (
    findButtonByText(REDFOX_TEXT.confirmCreate, dialog) ||
    Array.from(dialog.querySelectorAll("button, a, div[role='button'], span[role='button']"))
      .filter((el) => isElementVisible(el))
      .filter((el) => {
        const text = normalizeText(el.textContent || "");
        return !text.includes("取消") && !text.includes("cancel");
      })
      .pop() ||
    null
  );
}

function findSavedButton() {
  const dialog = getTopVisibleDialog() || document;
  return findButtonByText(REDFOX_TEXT.saved, dialog);
}

function findButtonByText(keywords, root = document) {
  const nodes = root.querySelectorAll("button, a, div[role='button'], span[role='button']");
  for (const node of nodes) {
    const text = normalizeText(node.innerText || node.textContent || "");
    if (keywords.some((keyword) => text.includes(String(keyword).toLowerCase()))) {
      return node;
    }
  }
  return null;
}

function findClickableByText(keywords) {
  return findButtonByText(keywords);
}

function getVisibleDialogs() {
  return Array.from(
    document.querySelectorAll("[role='dialog'], .ant-modal, .ant-modal-content, .modal, .dialog, [class*='modal']")
  ).filter((el) => isElementVisible(el));
}

function getTopVisibleDialog() {
  const dialogs = getVisibleDialogs();
  return dialogs[dialogs.length - 1] || null;
}

async function waitForApiKeyValue(timeoutMs, excludedValue = "") {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const apiKey = extractApiKey(excludedValue);
    if (apiKey) {
      return apiKey;
    }
    await delay(300);
  }
  return "";
}

function extractApiKey(excludedValue = "") {
  const scopes = [...getVisibleDialogs(), document.body].filter(Boolean);
  for (const scope of scopes) {
    const apiKey = extractApiKeyFromScope(scope, excludedValue);
    if (apiKey) {
      return apiKey;
    }
  }
  return "";
}

function extractApiKeyFromScope(scope, excludedValue = "") {
  const values = [scope.innerText || ""];
  for (const element of scope.querySelectorAll("input, textarea, code, pre, td, div, span")) {
    values.push(element.value || element.textContent || "");
  }

  const patterns = [
    /\b(ak_[A-Za-z0-9_-]{20,})\b/g,
    /\b(ak-[A-Za-z0-9_-]{20,})\b/g,
    /\b(sk-[A-Za-z0-9_-]{20,})\b/g
  ];

  for (const value of values) {
    if (value.includes("...")) {
      continue;
    }
    for (const pattern of patterns) {
      for (const match of value.matchAll(pattern)) {
        const token = match[1];
        if (token && token !== excludedValue) {
          return token;
        }
      }
    }
  }

  return "";
}

async function ensureAccountPage() {
  if (!location.pathname.startsWith("/dashboard")) {
    location.href = "https://redfox.hk/dashboard/account";
    await waitForReady();
    await delay(2500);
  }
}

async function waitForDashboard(timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (location.pathname.startsWith("/dashboard") || normalizeText(document.body.innerText || "").includes("控制台")) {
      await delay(1500);
      return true;
    }
    await delay(500);
  }
  return false;
}

function isVerificationCountdownActive() {
  const codeInput = findCodeInput();
  const root = codeInput?.closest(".ant-form-item, .form-item, .field, div") || document.body;
  const text = normalizeText(root?.innerText || "");
  return /\b\d{1,3}\s*s?\b/.test(text) || text.includes("秒");
}

function isDisabled(element) {
  return Boolean(
    element.disabled ||
      element.getAttribute("aria-disabled") === "true" ||
      element.classList.contains("disabled") ||
      element.classList.contains("ant-btn-disabled")
  );
}

function clickElementRobustly(element) {
  element.scrollIntoView({ block: "center", inline: "center" });
  element.focus?.();
  element.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
  element.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
  element.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
  element.click?.();
  element.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
}

function setInputValue(input, value) {
  const prototype = input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const descriptor = Object.getOwnPropertyDescriptor(prototype, "value");
  input.focus();
  input.select?.();
  if (descriptor?.set) {
    descriptor.set.call(input, "");
  } else {
    input.value = "";
  }
  input.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "deleteContentBackward", data: null }));
  if (descriptor?.set) {
    descriptor.set.call(input, value);
  } else {
    input.value = value;
  }
  input.dispatchEvent(new InputEvent("beforeinput", { bubbles: true, inputType: "insertText", data: String(value) }));
  input.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: String(value) }));
  input.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "a" }));
  input.dispatchEvent(new KeyboardEvent("keyup", { bubbles: true, key: "a" }));
  input.dispatchEvent(new Event("change", { bubbles: true }));
  input.dispatchEvent(new Event("compositionend", { bubbles: true }));
  input.blur();
  input.dispatchEvent(new Event("blur", { bubbles: true }));
}

function isElementVisible(element) {
  if (!element) {
    return false;
  }
  const rect = element.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0;
}

function normalizeText(text) {
  return String(text || "").replace(/\s+/g, " ").trim().toLowerCase();
}

async function waitForReady() {
  if (document.readyState === "complete" || document.readyState === "interactive") {
    return;
  }
  await new Promise((resolve) => {
    window.addEventListener("DOMContentLoaded", resolve, { once: true });
  });
}

async function waitForElement(fn, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = fn();
    if (value) {
      return value;
    }
    await delay(300);
  }
  return null;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
