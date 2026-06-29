const TEMPMAIL_KEYWORDS = {
  refresh: ["刷新", "refresh"],
  change: ["更换地址", "change", "new", "新地址"],
  claim: ["获取此地址", "get this address", "use this address"],
  agnes: ["agnes", "redfox", "verification", "验证码"]
};

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  handleTempMailMessage(message)
    .then((data) => sendResponse({ ok: true, data }))
    .catch((error) => {
      console.error("[TempMail]", error);
      sendResponse({ ok: false, error: error.message || String(error) });
    });
  return true;
});

async function handleTempMailMessage(message) {
  switch (message?.type) {
    case "tm:prepareFreshMailbox":
      return { email: await prepareFreshMailbox() };
    case "tm:getEmail":
      return { email: await getEmailAddress() };
    case "tm:getLatestCode":
      return { code: await getLatestCode() };
    default:
      throw new Error(`未知 TempMail 消息: ${message?.type}`);
  }
}

async function getEmailAddress() {
  await waitForDocumentReady();
  if (isMailCx()) {
    return getMailCxEmailAddress();
  }

  const email = extractEmailFromPage();
  if (email) {
    return email;
  }

  const changeBtn = findClickableByText(TEMPMAIL_KEYWORDS.change);
  if (changeBtn) {
    changeBtn.click();
    await delay(1500);
  }

  const nextEmail = extractEmailFromPage();
  if (!nextEmail) {
    throw new Error("页面上未找到邮箱地址");
  }
  return nextEmail;
}

async function prepareFreshMailbox() {
  await waitForDocumentReady();
  if (isMailCx()) {
    return prepareMailCxMailbox();
  }

  const oldEmail = extractEmailFromPage();
  const changeBtn = findClickableByText(TEMPMAIL_KEYWORDS.change);
  if (changeBtn) {
    changeBtn.click();
    await delay(1800);
  }

  const nextEmail = await waitForEmailChange(oldEmail, 12000);
  if (!nextEmail) {
    throw new Error("更换临时邮箱地址失败");
  }

  await closeMailModalIfAny();
  await clickRefreshIfAny();
  await delay(1200);

  return nextEmail;
}

async function getLatestCode() {
  await waitForDocumentReady();
  if (isMailCx()) {
    const apiCode = await getMailCxLatestCode();
    return apiCode || "";
  }

  const directCode = extractPreferredCode();
  if (directCode) {
    return directCode;
  }

  await clickRefreshIfAny();

  const mailItem = findMailItem();
  if (mailItem) {
    mailItem.click();
    await delay(1800);
  }

  const modalCode = await waitForCodeInOpenedMail(5000);
  if (modalCode) {
    return modalCode;
  }

  return extractPreferredCode();
}

async function getMailCxEmailAddress() {
  const email = extractEmailFromPage();
  if (email) {
    return email;
  }

  const claimBtn = findMailCxClaimButton();
  if (claimBtn) {
    clickElement(claimBtn);
    await delay(1200);
  }

  const nextEmail = extractEmailFromPage();
  if (!nextEmail) {
    throw new Error("mail.cx 页面上未找到邮箱地址");
  }
  return nextEmail;
}

async function prepareMailCxMailbox() {
  const oldEmail = extractEmailFromPage();

  const newBtn = findMailCxNewButton();
  if (newBtn) {
    clickElement(newBtn);
    await delay(600);
  }

  const claimBtn = await waitForElement(() => findMailCxClaimButton(), 5000);
  if (claimBtn) {
    clickElement(claimBtn);
    await delay(1200);
  }

  const nextEmail = await waitForEmailChange(oldEmail, 12000);
  if (!nextEmail || nextEmail === oldEmail) {
    throw new Error("mail.cx 更换临时邮箱地址失败");
  }

  return nextEmail;
}

async function getMailCxLatestCode() {
  const email = extractEmailFromPage();
  if (!email) {
    return "";
  }

  const headers = {};
  const clientId = getMailCxClientId();
  if (clientId) {
    headers["x-client-id"] = clientId;
  }

  try {
    const inbox = await fetchWithTimeout(`/v1/inbox/${encodeURIComponent(email)}`, {
      headers,
      timeoutMs: 8000
    });
    if (!inbox || inbox.status === 204) {
      return "";
    }
    if (!inbox.ok) {
      return "";
    }

    const data = await inbox.json();
    const emails = normalizeMailCxInbox(data);
    for (const mail of emails) {
      const summaryText = flattenMailCxEmail(mail);
      if (!looksLikeTargetVerificationMail(summaryText)) {
        continue;
      }

      const summaryCode = extractCodeNearKeywords(summaryText);
      if (summaryCode) {
        return summaryCode;
      }

      if (mail.id) {
        const detail = await fetchMailCxEmailDetail(mail.id, headers);
        const detailCode = extractCodeNearKeywords(detail);
        if (detailCode) {
          return detailCode;
        }
      }
    }
  } catch (error) {
    if (error?.name !== "AbortError") {
      console.warn("[TempMail] mail.cx inbox read failed", error);
    }
  }

  const visibleCode = extractMailCxVisibleCode();
  if (visibleCode) {
    return visibleCode;
  }

  const mailItem = findMailCxMailItem();
  if (mailItem) {
    clickElement(mailItem);
    await delay(1200);
    const openedCode = extractMailCxVisibleCode();
    if (openedCode) {
      return openedCode;
    }
  }

  return "";
}

function normalizeMailCxInbox(data) {
  if (Array.isArray(data)) {
    return data;
  }
  if (Array.isArray(data?.emails)) {
    return data.emails;
  }
  if (Array.isArray(data?.data)) {
    return data.data;
  }
  if (data?.id) {
    return [data];
  }
  return [];
}

async function fetchMailCxEmailDetail(id, headers) {
  try {
    const response = await fetchWithTimeout(`/v1/email/${encodeURIComponent(id)}`, {
      headers,
      timeoutMs: 5000
    });
    if (!response?.ok) {
      return "";
    }
    return flattenMailCxEmail(await response.json());
  } catch {
    return "";
  }
}

function flattenMailCxEmail(mail) {
  return normalizeRawText(
    [
      mail?.subject,
      mail?.from,
      mail?.from_email,
      mail?.from_name,
      mail?.text_body,
      stripHtml(mail?.html_body),
      flattenText(mail?.attachments || [])
    ].join(" ")
  );
}

function stripHtml(html) {
  const text = String(html || "");
  if (!text) {
    return "";
  }
  const doc = new DOMParser().parseFromString(text, "text/html");
  return doc.body?.innerText || doc.body?.textContent || text.replace(/<[^>]+>/g, " ");
}

function getMailCxClientId() {
  return localStorage.getItem("mailtd_cid") || "";
}

function isMailCx() {
  return location.hostname === "mail.cx";
}

function extractMailCxVisibleCode() {
  const scopedTexts = [];

  const detailNodes = Array.from(document.querySelectorAll("article, main, section, [class*='mail'], [class*='email'], [class*='inbox'], [class*='message'], iframe"))
    .filter((node) => isElementVisible(node));

  for (const node of detailNodes) {
    if (node instanceof HTMLIFrameElement) {
      try {
        scopedTexts.push(normalizeRawText(node.contentDocument?.body?.innerText || node.contentDocument?.body?.textContent || ""));
      } catch {
        // ignore cross-origin iframe
      }
    } else {
      scopedTexts.push(normalizeRawText(node.innerText || node.textContent || ""));
    }
  }

  const bodyText = normalizeRawText(document.body.innerText || "");
  if (looksLikeTargetVerificationMail(bodyText)) {
    scopedTexts.push(bodyText);
  }

  for (const text of scopedTexts) {
    if (!looksLikeTargetVerificationMail(text)) {
      continue;
    }
    const code = extractCodeNearKeywords(text);
    if (code) {
      return code;
    }
  }

  return "";
}

function extractEmailFromPage() {
  const candidates = [];

  if (isMailCx()) {
    const storedEmail = extractMailCxStoredEmail();
    if (storedEmail) {
      candidates.push({ email: storedEmail, score: 120 });
    }
  }

  for (const element of document.querySelectorAll("input, textarea, [contenteditable='true'], button, span, div, p")) {
    if (!isElementVisible(element)) {
      continue;
    }

    const sources = [
      { text: element.value, score: 100 },
      { text: element.getAttribute?.("title"), score: 60 },
      { text: element.getAttribute?.("aria-label"), score: 40 },
      { text: element.textContent, score: 10 }
    ];

    for (const source of sources) {
      const matches = String(source.text || "").match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi) || [];
      for (const email of matches) {
        if (isRealMailboxCandidate(email)) {
          candidates.push({ email, score: source.score });
        }
      }
    }
  }

  const bestByEmail = new Map();
  for (const candidate of candidates) {
    const key = candidate.email.toLowerCase();
    const previous = bestByEmail.get(key);
    if (!previous || candidate.score > previous.score) {
      bestByEmail.set(key, candidate);
    }
  }

  return [...bestByEmail.values()].sort((a, b) => b.score - a.score)[0]?.email || "";
}

function extractMailCxStoredEmail() {
  try {
    const stored = JSON.parse(localStorage.getItem("mailtd_mb") || "{}");
    return isRealMailboxCandidate(stored?.address) ? stored.address : "";
  } catch {
    return "";
  }
}

function isRealMailboxCandidate(email) {
  const normalized = String(email || "").trim().toLowerCase();
  if (!normalized || normalized.includes("example")) {
    return false;
  }
  const blocked = new Set([
    "email@tempmail.ing",
    "email@mail.cx",
    "your@email.com",
    "your@example.com",
    "test@example.com"
  ]);
  if (blocked.has(normalized)) {
    return false;
  }
  return !normalized.startsWith("your@") && !normalized.startsWith("email@");
}

function findMailItem() {
  const selectors = [
    "[role='button']",
    "li",
    "tr",
    ".mail-item",
    ".email-item",
    ".message-item",
    ".inbox-item",
    "div"
  ];

  for (const selector of selectors) {
    for (const element of document.querySelectorAll(selector)) {
      const text = normalizeText(element.innerText || "");
      if (TEMPMAIL_KEYWORDS.agnes.some((keyword) => text.includes(keyword))) {
        return element;
      }
    }
  }

  return null;
}

function findMailCxMailItem() {
  const selectors = [
    "article",
    "li",
    "tr",
    "[role='button']",
    "[class*='mail']",
    "[class*='email']",
    "[class*='inbox']",
    "[class*='message']",
    "div"
  ];

  for (const selector of selectors) {
    for (const element of document.querySelectorAll(selector)) {
      if (!isElementVisible(element)) {
        continue;
      }
      const text = normalizeRawText(element.innerText || element.textContent || "");
      if (looksLikeTargetVerificationMail(text)) {
        return element;
      }
    }
  }

  return null;
}

function looksLikeTargetVerificationMail(text) {
  const normalized = normalizeRawText(text).toLowerCase();
  return (
    (normalized.includes("agnes") ||
      normalized.includes("redfox") ||
      normalized.includes("redfoxhub") ||
      normalized.includes("红狐")) &&
    (normalized.includes("verification code") ||
      normalized.includes("verify your email address") ||
      normalized.includes("please enter the verification code") ||
      normalized.includes("验证码") ||
      normalized.includes("校验码") ||
      normalized.includes("验证操作"))
  );
}

function extractCodeFromText(text) {
  const normalized = String(text || "");
  const patterns = [
    /\b(\d{6})\b/g
  ];

  for (const pattern of patterns) {
    const matches = [...normalized.matchAll(pattern)];
    for (const match of matches) {
      const code = match[1];
      if (isValidVerificationCode(code)) {
        return code;
      }
    }
  }

  return "";
}

function extractPreferredCode() {
  const scopedTexts = [];

  const modalCandidates = document.querySelectorAll(
    "[role='dialog'], .modal, .dialog, .popup, .message-detail, .email-detail"
  );

  for (const element of modalCandidates) {
    const text = normalizeRawText(element.innerText || "");
    if (looksLikeAgnesMail(text)) {
      scopedTexts.push(text);
    }
  }

  const agnesBlocks = Array.from(document.querySelectorAll("div, section, article")).filter((el) => {
    const text = normalizeRawText(el.innerText || "");
    return text.includes("agnes") && text.includes("verification");
  });

  for (const element of agnesBlocks) {
    scopedTexts.push(normalizeRawText(element.innerText || ""));
  }

  scopedTexts.push(normalizeRawText(document.body.innerText || ""));
  scopedTexts.push(...extractTextsFromAccessibleFrames());

  for (const text of scopedTexts) {
    const exact = extractCodeNearKeywords(text);
    if (exact) {
      return exact;
    }
  }

  for (const text of scopedTexts) {
    const fallback = extractCodeFromText(text);
    if (fallback) {
      return fallback;
    }
  }

  return "";
}

function extractTextsFromAccessibleFrames() {
  const texts = [];
  const frames = document.querySelectorAll("iframe");

  for (const frame of frames) {
    try {
      const doc = frame.contentDocument || frame.contentWindow?.document || null;
      if (!doc?.body) {
        continue;
      }

      const text = normalizeRawText(doc.body.innerText || doc.body.textContent || "");
      if (text) {
        texts.push(text);
      }
    } catch {
      // cross-origin iframe 无法直接读取
    }
  }

  return texts;
}

async function waitForCodeInOpenedMail(timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const code = extractPreferredCode();
    if (code) {
      return code;
    }
    await delay(400);
  }
  return "";
}

function extractCodeNearKeywords(text) {
  const normalized = String(text || "");
  const keywordPatterns = [
    /verification code[\s\S]{0,120}?\b(\d{6})\b/gi,
    /verify your email address[\s\S]{0,120}?\b(\d{6})\b/gi,
    /please enter the verification code[\s\S]{0,120}?\b(\d{6})\b/gi,
    /verification[\s\S]{0,120}?\b(\d{6})\b/gi,
    /验证码[\s\S]{0,120}?\b(\d{6})\b/gi,
    /验证码为[\s\S]{0,80}?\b(\d{6})\b/gi,
    /您的验证码为[\s\S]{0,80}?\b(\d{6})\b/gi,
    /校验码[\s\S]{0,120}?\b(\d{6})\b/gi,
    /账号验证[\s\S]{0,160}?\b(\d{6})\b/gi,
    /agnes[\s\S]{0,160}?\b(\d{6})\b/gi,
    /redfox[\s\S]{0,160}?\b(\d{6})\b/gi,
    /红狐[\s\S]{0,160}?\b(\d{6})\b/gi
  ];

  for (const pattern of keywordPatterns) {
    const matches = [...normalized.matchAll(pattern)];
    for (const match of matches) {
      if (isValidVerificationCode(match?.[1])) {
        return match[1];
      }
    }
  }

  return "";
}

function isValidVerificationCode(code) {
  const value = String(code || "");
  if (!/^\d{6}$/.test(value)) {
    return false;
  }
  return !new Set(["000000", "111111", "123456", "202500", "202600", "999999"]).has(value);
}

function looksLikeAgnesMail(text) {
  return looksLikeTargetVerificationMail(text);
}

function normalizeRawText(text) {
  return String(text || "").replace(/\s+/g, " ").trim();
}

function findClickableByText(keywords) {
  const nodes = document.querySelectorAll("button, a, div[role='button'], span[role='button']");
  for (const node of nodes) {
    const text = normalizeText(node.innerText || node.textContent || "");
    if (keywords.some((keyword) => text.includes(keyword.toLowerCase()))) {
      return node;
    }
  }
  return null;
}

function findMailCxNewButton() {
  return Array.from(document.querySelectorAll("button")).find((node) => {
    const text = normalizeText(node.innerText || node.textContent || "");
    return text === "new" || text.includes("新地址");
  });
}

function findMailCxClaimButton() {
  return Array.from(document.querySelectorAll("button")).find((node) => {
    const text = normalizeText(node.innerText || node.textContent || "");
    return text.includes("获取此地址") || text.includes("get this address") || text.includes("use this address");
  });
}

function clickElement(element) {
  element.scrollIntoView?.({ block: "center", inline: "center" });
  element.focus?.();
  element.click?.();
}

function isElementVisible(element) {
  if (!element) {
    return false;
  }
  const rect = element.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0;
}

async function waitForEmailChange(previousEmail, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const current = extractEmailFromPage();
    if (current && current !== previousEmail) {
      return current;
    }
    await delay(300);
  }
  return "";
}

async function closeMailModalIfAny() {
  const closeBtn = Array.from(document.querySelectorAll("button, span, div[role='button']"))
    .find((node) => {
      const text = normalizeText(node.innerText || node.textContent || "");
      return text === "×" || text === "x";
    });
  if (closeBtn) {
    closeBtn.click();
    await delay(500);
  }
}

async function clickRefreshIfAny() {
  const refreshBtn = findClickableByText(TEMPMAIL_KEYWORDS.refresh);
  if (refreshBtn) {
    refreshBtn.click();
    await delay(1800);
  }
}

function normalizeText(text) {
  return String(text || "").replace(/\s+/g, " ").trim().toLowerCase();
}

async function waitForDocumentReady() {
  if (document.readyState === "complete" || document.readyState === "interactive") {
    return;
  }
  await new Promise((resolve) => {
    window.addEventListener("DOMContentLoaded", resolve, { once: true });
  });
}

async function waitForElement(factory, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const element = factory();
    if (element) {
      return element;
    }
    await delay(250);
  }
  return null;
}

async function fetchWithTimeout(url, options = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs || 5000);
  try {
    return await fetch(url, {
      ...options,
      signal: controller.signal
    });
  } finally {
    clearTimeout(timeout);
  }
}

function flattenText(value) {
  const parts = [];
  const visit = (node) => {
    if (node === null || node === undefined) {
      return;
    }
    if (typeof node === "string" || typeof node === "number" || typeof node === "boolean") {
      parts.push(String(node));
      return;
    }
    if (Array.isArray(node)) {
      node.forEach(visit);
      return;
    }
    if (typeof node === "object") {
      Object.values(node).forEach(visit);
    }
  };
  visit(value);
  return normalizeRawText(parts.join(" "));
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
