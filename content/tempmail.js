const TEMPMAIL_KEYWORDS = {
  refresh: ["刷新", "refresh"],
  change: ["更换地址", "change"],
  agnes: ["agnes", "verification", "验证码"]
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

function extractEmailFromPage() {
  const candidates = [];

  for (const element of document.querySelectorAll("input, textarea, [contenteditable='true'], button, span, div, p")) {
    const text = [
      element.value,
      element.textContent,
      element.getAttribute?.("aria-label"),
      element.getAttribute?.("title")
    ]
      .filter(Boolean)
      .join(" ");
    const email = text.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi)?.[0];
    if (email) {
      candidates.push(email);
    }
  }

  const unique = [...new Set(candidates)];
  return unique.find((item) => !item.includes("example")) || unique[0] || "";
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

function extractCodeFromText(text) {
  const normalized = String(text || "");
  const patterns = [
    /\b(\d{6})\b/g
  ];

  for (const pattern of patterns) {
    const matches = [...normalized.matchAll(pattern)];
    for (const match of matches) {
      const code = match[1];
      if (code && !["202500", "202600", "000000"].includes(code)) {
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
    /verification code[\s\S]{0,120}?\b(\d{6})\b/i,
    /verify your email address[\s\S]{0,120}?\b(\d{6})\b/i,
    /please enter the verification code[\s\S]{0,120}?\b(\d{6})\b/i,
    /agnes[\s\S]{0,160}?\b(\d{6})\b/i
  ];

  for (const pattern of keywordPatterns) {
    const match = normalized.match(pattern);
    if (match?.[1]) {
      return match[1];
    }
  }

  return "";
}

function looksLikeAgnesMail(text) {
  return (
    text.includes("agnes") &&
    (text.includes("verification code") ||
      text.includes("verify your email address") ||
      text.includes("please enter the verification code"))
  );
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

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
