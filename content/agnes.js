const AGNES_TEXT = {
  register: ["注册", "sign up", "create account"],
  sendCode: ["发送验证码", "send code", "get code", "verification code"],
  submit: ["继续", "continue", "提交", "submit", "完成", "注册", "sign up"],
  apiKey: ["api key", "api keys", "密钥", "key management"],
  createKey: ["创建", "create", "generate", "new key"],
  save: ["保存", "save", "create", "generate"],
  confirm: ["确认", "confirm", "ok"],
  logout: ["退出登录", "logout", "sign out", "log out"]
};

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  handleAgnesMessage(message)
    .then((data) => sendResponse({ ok: true, data }))
    .catch((error) => {
      console.error("[Agnes]", error);
      sendResponse({ ok: false, error: error.message || String(error) });
    });
  return true;
});

async function handleAgnesMessage(message) {
  switch (message?.type) {
    case "agnes:startRegistration":
      return startRegistration(message.payload || {});
    case "agnes:completeRegistration":
      return completeRegistration(message.payload || {});
    case "agnes:createApiKey":
      return createApiKey(message.payload || {});
    case "agnes:logout":
      return logout();
    default:
      throw new Error(`未知 Agnes 消息: ${message?.type}`);
  }
}

async function startRegistration({ email }) {
  await waitForReady();
  await openRegisterEntry();
  await delay(1500);

  const emailInput = await waitForElement(() => findEmailInput(), 15000);
  if (!emailInput) {
    throw new Error("未找到注册邮箱输入框");
  }

  setInputValue(emailInput, email);
  await delay(800);

  const codeBtn = await waitForElement(() => findSendCodeTrigger(emailInput), 12000);
  if (!codeBtn) {
    throw new Error("未找到发送验证码按钮");
  }

  if (isVerificationCountdownActive()) {
    return { sent: true, skipped: true };
  }

  clickElementRobustly(codeBtn);
  await delay(1000);
  return { sent: true, skipped: false };
}

async function completeRegistration({ code, password }) {
  await waitForReady();

  const codeInput = await waitForElement(() => findCodeInput(), 30000);
  if (!codeInput) {
    throw new Error("未找到验证码输入框");
  }
  setInputValue(codeInput, code);

  const passwordInputs = findPasswordInputs();
  if (!passwordInputs.length) {
    throw new Error("未找到密码输入框");
  }

  setInputValue(passwordInputs[0], password);
  if (passwordInputs[1]) {
    setInputValue(passwordInputs[1], password);
    passwordInputs[1].focus();
    passwordInputs[1].dispatchEvent(new KeyboardEvent("keyup", { bubbles: true, key: "Tab" }));
    passwordInputs[1].blur();
  }

  await delay(1500);

  const submitBtn = await waitForElement(() => findSubmitButton(), 12000);
  if (submitBtn) {
    clickElementRobustly(submitBtn);
  } else {
    const submitted = submitRegistrationForm();
    if (!submitted) {
      throw new Error("未找到注册提交按钮");
    }
  }

  await delay(5000);
  return { registered: true };
}

async function createApiKey({ round }) {
  await waitForReady();

  const apiKeyEntry = findClickableByText(AGNES_TEXT.apiKey);
  if (apiKeyEntry) {
    clickElementRobustly(apiKeyEntry);
    await delay(2000);
  }

  const createBtn = await waitForElement(() => findButtonByText(AGNES_TEXT.createKey), 10000);
  if (!createBtn) {
    throw new Error("未找到创建 API Key 按钮");
  }
  clickElementRobustly(createBtn);
  await delay(1500);

  const keyName = `agens-auto-${round}-${Date.now()}`;
  const nameInput = await waitForElement(() => findKeyNameInput(), 10000);
  if (!nameInput) {
    throw new Error("未找到密钥名称输入框");
  }
  setInputValue(nameInput, keyName);
  await delay(500);

  const saveClicked = await submitCreateKeyDialog(nameInput);
  if (!saveClicked) {
    throw new Error("未找到密钥创建弹窗的保存按钮");
  }

  const apiKey = await waitForApiKeyValue(15000, keyName);
  if (!apiKey) {
    throw new Error("创建后未能在弹窗中读取到真实 API Key");
  }

  const confirmBtn = await waitForElement(() => findFinalConfirmButton(), 10000);
  if (confirmBtn) {
    clickElementRobustly(confirmBtn);
    await delay(1200);
  }

  return { apiKey };
}

async function logout() {
  await waitForReady();

  const logoutEntry = findClickableByText(AGNES_TEXT.logout);
  if (!logoutEntry) {
    return { loggedOut: false, reason: "未找到退出入口" };
  }

  clickElementRobustly(logoutEntry);
  await delay(1500);
  return { loggedOut: true };
}

async function openRegisterEntry() {
  const registerLink = findClickableByText(AGNES_TEXT.register);
  if (registerLink) {
    clickElementRobustly(registerLink);
    await delay(1500);
  }
}

function findEmailInput() {
  return (
    document.querySelector("input[name='email']") ||
    document.querySelector("input[placeholder='邮箱']") ||
    findInputByHints(["邮箱", "email"])
  );
}

function findCodeInput() {
  return (
    document.querySelector("input[name='verification_code']") ||
    document.querySelector("input[placeholder='验证码']") ||
    findInputByHints(["验证码", "verification_code", "verification", "code"])
  );
}

function findKeyNameInput() {
  return (
    document.querySelector("input[placeholder*='名称']") ||
    document.querySelector("input[placeholder*='name' i]") ||
    findInputByHints(["name", "名称", "备注", "label"])
  );
}

function findInputByHints(hints) {
  const candidates = Array.from(document.querySelectorAll("input, textarea"));
  for (const input of candidates) {
    const haystack = normalizeText(
      [
        input.placeholder,
        input.name,
        input.id,
        input.type,
        input.getAttribute("aria-label"),
        getFieldLabelText(input)
      ]
        .filter(Boolean)
        .join(" ")
    );
    if (hints.some((hint) => haystack.includes(String(hint).toLowerCase()))) {
      return input;
    }
  }
  return null;
}

function getFieldLabelText(input) {
  const label = input.closest("label");
  if (label?.innerText) {
    return label.innerText;
  }

  const parent = input.parentElement;
  if (parent?.innerText) {
    return parent.innerText.slice(0, 120);
  }

  return "";
}

function findPasswordInputs() {
  const inputs = Array.from(document.querySelectorAll("input[type='password'], input"));
  const filtered = inputs.filter((input) => {
    const haystack = normalizeText(
      [
        input.type,
        input.placeholder,
        input.name,
        input.id,
        input.getAttribute("aria-label"),
        getFieldLabelText(input)
      ]
        .filter(Boolean)
        .join(" ")
    );
    return haystack.includes("password") || haystack.includes("密码");
  });

  const unique = [];
  const seen = new Set();
  for (const input of filtered) {
    const key = input.name || input.id || input.placeholder || String(unique.length);
    if (!seen.has(key)) {
      seen.add(key);
      unique.push(input);
    }
  }
  return unique;
}

function findButtonByText(keywords, root = document) {
  const buttons = root.querySelectorAll("button, a, div[role='button'], span[role='button']");
  for (const button of buttons) {
    const text = normalizeText(button.innerText || button.textContent || "");
    if (keywords.some((keyword) => text.includes(String(keyword).toLowerCase()))) {
      return button;
    }
  }
  return null;
}

function findClickableByText(keywords) {
  return findButtonByText(keywords);
}

function findSubmitButton() {
  const direct =
    document.querySelector("button[type='submit']") ||
    document.querySelector(".ant-btn[type='submit']") ||
    document.querySelector("form button");
  if (direct && isElementVisible(direct)) {
    return direct;
  }

  const byText = findButtonByText(AGNES_TEXT.submit);
  if (byText && isElementVisible(byText)) {
    return byText;
  }

  const broadMatch = Array.from(document.querySelectorAll("button, a, div, span")).find((el) => {
    const text = normalizeText(el.textContent || "");
    return text === "继续" || text === "continue" || text.includes("继续");
  });
  if (broadMatch && isElementVisible(broadMatch)) {
    return broadMatch;
  }

  return null;
}

function findSaveKeyButton() {
  const dialog = findCreateKeyDialog() || getTopVisibleDialog() || document;
  const candidate = findButtonByText(AGNES_TEXT.save, dialog);
  if (candidate && isElementVisible(candidate)) {
    return candidate;
  }

  return Array.from(dialog.querySelectorAll("button, a, div[role='button'], span[role='button']")).find((el) => {
    const text = normalizeText(el.textContent || "");
    return (text === "保存" || text === "save") && isElementVisible(el);
  }) || null;
}

function findFinalConfirmButton() {
  const dialog = getTopVisibleDialog() || document;
  const candidate = findButtonByText(AGNES_TEXT.confirm, dialog);
  if (candidate && isElementVisible(candidate)) {
    return candidate;
  }

  return Array.from(dialog.querySelectorAll("button, a, div[role='button'], span[role='button']")).find((el) => {
    const text = normalizeText(el.textContent || "");
    return (text === "确认" || text === "confirm" || text === "ok") && isElementVisible(el);
  }) || null;
}

function findCreateKeyDialog() {
  const dialogs = getVisibleDialogs();
  return (
    dialogs.find((el) => {
      const text = normalizeText(el.innerText || "");
      return text.includes("创建新的密钥") || text.includes("create new key");
    }) || dialogs[dialogs.length - 1] || null
  );
}

function getVisibleDialogs() {
  return Array.from(
    document.querySelectorAll("[role='dialog'], .ant-modal, .ant-modal-content, .modal, .dialog")
  ).filter((el) => isElementVisible(el));
}

function getTopVisibleDialog() {
  const dialogs = getVisibleDialogs();
  return dialogs[dialogs.length - 1] || null;
}

async function submitCreateKeyDialog(nameInput) {
  const deadline = Date.now() + 10000;

  while (Date.now() < deadline) {
    const dialog = findCreateKeyDialog();
    const saveBtn = findSaveKeyButton();
    if (saveBtn) {
      clickElementRobustly(saveBtn);
      await delay(600);
      return true;
    }

    if (dialog) {
      const visibleButtons = Array.from(
        dialog.querySelectorAll("button, a, div[role='button'], span[role='button']")
      ).filter((el) => isElementVisible(el));

      const primaryCandidate = visibleButtons.find((el) => {
        const text = normalizeText(el.textContent || "");
        return text.includes("保存") || text.includes("save");
      });
      if (primaryCandidate) {
        clickElementRobustly(primaryCandidate);
        await delay(600);
        return true;
      }

      const nonCancelButtons = visibleButtons.filter((el) => {
        const text = normalizeText(el.textContent || "");
        return !text.includes("取消") && !text.includes("cancel");
      });
      const lastActionBtn = nonCancelButtons[nonCancelButtons.length - 1];
      if (lastActionBtn) {
        clickElementRobustly(lastActionBtn);
        await delay(600);
        return true;
      }
    }

    if (nameInput) {
      nameInput.focus();
      nameInput.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Enter", code: "Enter" }));
      nameInput.dispatchEvent(new KeyboardEvent("keypress", { bubbles: true, key: "Enter", code: "Enter" }));
      nameInput.dispatchEvent(new KeyboardEvent("keyup", { bubbles: true, key: "Enter", code: "Enter" }));
      await delay(600);
      return true;
    }

    await delay(300);
  }

  return false;
}

function submitRegistrationForm() {
  const form =
    document.querySelector("form") ||
    findCodeInput()?.closest("form") ||
    findPasswordInputs()?.[0]?.closest("form");

  if (!form) {
    return false;
  }

  if (typeof form.requestSubmit === "function") {
    form.requestSubmit();
    return true;
  }

  form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  return true;
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

function isElementVisible(element) {
  if (!element) {
    return false;
  }
  const rect = element.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0;
}

function findSendCodeTrigger(emailInput) {
  const codeInput = findCodeInput();
  const searchRoots = [
    codeInput?.parentElement,
    codeInput?.closest(".ant-input-affix-wrapper"),
    codeInput?.closest(".ant-form-item"),
    emailInput?.closest("form"),
    document.body
  ].filter(Boolean);

  for (const root of searchRoots) {
    const imageTrigger = root.querySelector(
      "img[src*='new_canSend'], img[src*='new_resend'], img[alt*='send' i], img[alt*='resend' i], img[alt*='can send' i]"
    );
    if (imageTrigger) {
      return imageTrigger;
    }

    const clickableIcon = Array.from(root.querySelectorAll("img")).find((el) => {
      const src = (el.getAttribute("src") || "").toLowerCase();
      const alt = (el.getAttribute("alt") || "").toLowerCase();
      return (
        src.includes("cansend") ||
        src.includes("resend") ||
        src.includes("new_cansend") ||
        src.includes("new_resend") ||
        alt.includes("send") ||
        alt.includes("resend")
      );
    });
    if (clickableIcon) {
      return clickableIcon;
    }

    const clickable = Array.from(root.querySelectorAll("span, div, button, a")).find((el) => {
      const text = normalizeText(el.textContent || "");
      return AGNES_TEXT.sendCode.some((keyword) => text.includes(String(keyword).toLowerCase()));
    });
    if (clickable) {
      return clickable;
    }
  }

  return null;
}

function isVerificationCountdownActive() {
  const codeInput = findCodeInput();
  const root =
    codeInput?.closest(".ant-form-item") ||
    codeInput?.parentElement ||
    document.body;

  const text = normalizeText(root?.innerText || "");
  return /\b\d{1,3}\b/.test(text);
}

function setInputValue(input, value) {
  const prototype = Object.getPrototypeOf(input);
  const descriptor = Object.getOwnPropertyDescriptor(prototype, "value");
  input.focus();
  if (descriptor?.set) {
    descriptor.set.call(input, "");
  } else {
    input.value = "";
  }
  input.dispatchEvent(new Event("input", { bubbles: true }));
  if (descriptor?.set) {
    descriptor.set.call(input, value);
  } else {
    input.value = value;
  }
  input.dispatchEvent(new Event("input", { bubbles: true }));
  input.dispatchEvent(new KeyboardEvent("keyup", { bubbles: true, key: "a" }));
  input.dispatchEvent(new Event("change", { bubbles: true }));
  input.blur();
  input.dispatchEvent(new Event("blur", { bubbles: true }));
}

async function waitForApiKeyValue(timeoutMs, excludedValue) {
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
  const dialogs = getVisibleDialogs();
  for (const dialog of dialogs) {
    const dialogKey = extractApiKeyFromScope(dialog, excludedValue);
    if (dialogKey) {
      return dialogKey;
    }
  }

  return extractApiKeyFromScope(document.body, excludedValue);
}

function extractApiKeyFromScope(scope, excludedValue = "") {
  if (!scope) {
    return "";
  }

  const text = scope.innerText || "";
  const patterns = [
    /\b(sk-[A-Za-z0-9_-]{16,})\b/g,
    /\b(ak-[A-Za-z0-9_-]{16,})\b/g,
    /\b([A-Za-z0-9_-]{24,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,})\b/g,
    /\b([A-Za-z0-9_-]{32,})\b/g
  ];

  for (const pattern of patterns) {
    const matches = [...text.matchAll(pattern)];
    if (matches[0]?.[1] && matches[0][1] !== excludedValue) {
      return matches[0][1];
    }
  }

  for (const element of scope.querySelectorAll("input, textarea, code, pre, td, div, span")) {
    const value = element.value || element.textContent || "";
    const token =
      value.match(/\bsk-[A-Za-z0-9_-]{16,}\b/)?.[0] ||
      value.match(/\bak-[A-Za-z0-9_-]{16,}\b/)?.[0] ||
      value.match(/\b[A-Za-z0-9_-]{32,}\b/)?.[0];
    if (token && token !== excludedValue) {
      return token;
    }
  }

  return "";
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
