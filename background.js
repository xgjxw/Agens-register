const URLS = {
  tempMail: "https://mail.cx/zh/",
  agnesLogin: "https://platform.agnes-ai.com/login",
  redfoxLogin: "https://redfox.hk/login?redirect=%2Fdashboard%2Faccount"
};

const CONTENT_SCRIPT_FILES = {
  "https://mail.cx": ["content/tempmail.js"],
  "https://platform.agnes-ai.com": ["content/agnes.js"],
  "https://redfox.hk": ["content/redfox.js"]
};

const DEFAULT_CONFIG = {
  targetType: "agnes",
  loopCount: 1,
  fixedPassword: "Agnes#2026!Auto",
  countFailedAttempt: true,
  maxRetryPerRound: 2,
  codeTimeoutMs: 120000,
  pollIntervalMs: 5000,
  exportFileName: "agens-keys.txt"
};

const REDFOX_API_BASE = "https://redfox.hk";

let stateHydrated = false;

let runState = {
  running: false,
  stopping: false,
  startedAt: null,
  targetType: DEFAULT_CONFIG.targetType,
  currentRound: 0,
  totalRounds: 0,
  successCount: 0,
  failCount: 0,
  lastError: "",
  lastEmail: "",
  lastCode: "",
  currentPhase: "",
  verificationPollCount: 0,
  pendingExports: [],
  keyLedger: [],
  exportedHistory: [],
  autoSavedFiles: [],
  creditRefresh: {
    running: false,
    current: "",
    checked: 0,
    total: 0,
    updated: 0,
    lastError: "",
    lastUpdatedAt: ""
  },
  results: []
};

chrome.runtime.onInstalled.addListener(async () => {
  const { config } = await chrome.storage.local.get("config");
  if (!config) {
    await chrome.storage.local.set({ config: DEFAULT_CONFIG });
  }
  await hydrateState();
  await persistState();
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  handleMessage(message)
    .then((data) => sendResponse({ ok: true, data }))
    .catch((error) => {
      console.error("[AgensMachine]", error);
      sendResponse({ ok: false, error: error.message || String(error) });
    });
  return true;
});

async function handleMessage(message) {
  await hydrateState();

  switch (message?.type) {
    case "popup:getState":
      return getCombinedState();
    case "popup:saveConfig":
      return saveConfig(message.config || {});
    case "popup:start":
      return startRun(message.config || {});
    case "popup:stop":
      return stopRun();
    case "popup:exportNow":
      return exportResults();
    case "popup:refreshRedFoxCredits":
      return refreshRedFoxCredits();
    default:
      throw new Error(`未知消息类型: ${message?.type}`);
  }
}

async function getCombinedState() {
  await hydrateState();

  const { config = DEFAULT_CONFIG } = await chrome.storage.local.get("config");
  return {
    config,
    state: {
      ...runState,
      targetType: runState.targetType || config.targetType || DEFAULT_CONFIG.targetType
    }
  };
}

async function saveConfig(partialConfig) {
  const { config = DEFAULT_CONFIG } = await chrome.storage.local.get("config");
  const nextConfig = {
    ...DEFAULT_CONFIG,
    ...config,
    ...sanitizeConfig(partialConfig)
  };
  await chrome.storage.local.set({ config: nextConfig });
  return { config: nextConfig };
}

async function startRun(overrideConfig = {}) {
  await hydrateState();

  if (runState.running) {
    throw new Error("任务已在运行中");
  }

  const { config = DEFAULT_CONFIG } = await chrome.storage.local.get("config");
  const mergedConfig = {
    ...DEFAULT_CONFIG,
    ...config,
    ...sanitizeConfig(overrideConfig)
  };

  await chrome.storage.local.set({ config: mergedConfig });

  runState = {
    running: true,
    stopping: false,
    startedAt: new Date().toISOString(),
    targetType: mergedConfig.targetType,
    currentRound: 0,
    totalRounds: mergedConfig.loopCount,
    successCount: 0,
    failCount: 0,
    lastError: "",
    lastEmail: "",
    lastCode: "",
    currentPhase: "准备开始",
    verificationPollCount: 0,
    pendingExports: runState.pendingExports || [],
    keyLedger: runState.keyLedger || [],
    exportedHistory: runState.exportedHistory || [],
    autoSavedFiles: runState.autoSavedFiles || [],
    creditRefresh: runState.creditRefresh || createEmptyCreditRefreshState(),
    results: []
  };
  await persistState();

  runAutomation(mergedConfig).catch(async (error) => {
    console.error("[AgensMachine] runAutomation failed", error);
    runState.lastError = error.message || String(error);
    runState.running = false;
    runState.stopping = false;
    await persistState();
  });

  return { started: true };
}

async function stopRun() {
  runState.stopping = true;
  await persistState();
  return { stopping: true };
}

async function runAutomation(config) {
  let round = 1;
  let completedCount = 0;

  while (completedCount < config.loopCount) {
    if (runState.stopping) {
      break;
    }

    runState.currentRound = round;
    runState.lastError = "";
    runState.currentPhase = `第 ${round} 轮准备中`;
    runState.verificationPollCount = 0;
    await persistState();

    let roundResult = null;
    try {
      roundResult = await runSingleRound(round, config);
      runState.currentPhase = `第 ${round} 轮完成`;
      const exportItem = toPendingExportItem(roundResult);
      runState.successCount += 1;
      runState.results.push(roundResult);
      runState.pendingExports.push(exportItem);
      upsertKeyLedgerItem(exportItem);
      completedCount += 1;
      await persistState();
      await autoSaveLedgerFile(config);
    } catch (error) {
      runState.failCount += 1;
      runState.lastError = error.message || String(error);
      roundResult = {
        targetType: normalizeTargetType(config.targetType),
        round,
        email: "",
        password: config.fixedPassword,
        apiKey: "",
        status: "failed",
        createdAt: new Date().toISOString(),
        error: runState.lastError
      };
      runState.results.push(roundResult);

      if (config.countFailedAttempt) {
        completedCount += 1;
      }
    }

    await persistState();
    round += 1;
  }

  runState.running = false;
  runState.stopping = false;
  runState.currentPhase = "全部完成";
  runState.verificationPollCount = 0;
  await persistState();
  await autoSaveLedgerFile(config);
}

async function runSingleRound(round, config) {
  let lastError = null;

  for (let attempt = 1; attempt <= config.maxRetryPerRound; attempt += 1) {
    try {
      await resetWorkflowTabs();
      return await doRound(round, attempt, config);
    } catch (error) {
      lastError = error;
      console.warn(`[AgensMachine] round ${round} attempt ${attempt} failed`, error);
      await resetWorkflowTabs();
      if (attempt < config.maxRetryPerRound) {
        await delay(1500);
      }
    }
  }

  throw lastError || new Error(`第 ${round} 轮执行失败`);
}

async function doRound(round, attempt, config) {
  const targetType = normalizeTargetType(config.targetType);
  if (targetType === "redfox") {
    return doRedFoxRound(round, attempt, config);
  }
  return doAgnesRound(round, attempt, config);
}

async function doAgnesRound(round, attempt, config) {
  runState.currentPhase = `第 ${round} 轮：准备临时邮箱`;
  await persistState();

  const tempMailTab = await ensureTab(URLS.tempMail);
  const agnesTab = await ensureTab(URLS.agnesLogin);

  const emailInfo = await sendTabMessage(tempMailTab.id, {
    type: "tm:prepareFreshMailbox"
  });
  const email = emailInfo?.email;
  if (!email) {
    throw new Error("未能从 TempMail 读取邮箱地址");
  }
  runState.lastEmail = email;
  runState.currentPhase = `第 ${round} 轮：提交注册邮箱`;
  await persistState();

  await sendTabMessage(agnesTab.id, {
    type: "agnes:startRegistration",
    payload: {
      email
    }
  });

  const code = await pollVerificationCode(tempMailTab.id, config, round);
  if (!code) {
    throw new Error("未能读取验证码");
  }
  runState.lastCode = code;
  runState.currentPhase = `第 ${round} 轮：提交验证码`;
  await persistState();

  await sendTabMessage(agnesTab.id, {
    type: "agnes:completeRegistration",
    payload: {
      email,
      code,
      password: config.fixedPassword
    }
  });

  runState.currentPhase = `第 ${round} 轮：创建 API Key`;
  await persistState();

  const apiKeyInfo = await sendTabMessage(agnesTab.id, {
    type: "agnes:createApiKey",
    payload: {
      round
    }
  });

  const apiKey = apiKeyInfo?.apiKey || "";
  if (!apiKey) {
    throw new Error("注册成功，但未读取到 API Key");
  }

  await sendTabMessage(agnesTab.id, {
    type: "agnes:logout"
  });

  return {
    targetType: "agnes",
    round,
    attempt,
    email,
    password: config.fixedPassword,
    apiKey,
    status: "success",
    createdAt: new Date().toISOString(),
    error: ""
  };
}

async function doRedFoxRound(round, attempt, config) {
  runState.currentPhase = `第 ${round} 轮：清理 RedFox 登录缓存`;
  await persistState();
  await clearSiteDataForOrigin("https://redfox.hk");

  runState.currentPhase = `第 ${round} 轮：准备临时邮箱`;
  await persistState();
  const tempMailTab = await ensureTab(URLS.tempMail);
  const redfoxTab = await ensureTab(URLS.redfoxLogin);
  await assertRedFoxLoginPage(redfoxTab.id);

  const emailInfo = await sendTabMessage(tempMailTab.id, {
    type: "tm:prepareFreshMailbox"
  });
  const email = emailInfo?.email;
  if (!email) {
    throw new Error("未能从 TempMail 读取邮箱地址");
  }
  runState.lastEmail = email;
  runState.currentPhase = `第 ${round} 轮：提交注册邮箱`;
  await persistState();

  await sendTabMessage(redfoxTab.id, {
    type: "redfox:startRegistration",
    payload: { email }
  });

  const code = await pollVerificationCode(tempMailTab.id, config, round);
  if (!code) {
    throw new Error("未能读取验证码");
  }
  runState.lastCode = code;
  runState.currentPhase = `第 ${round} 轮：提交验证码`;
  await persistState();

  await sendTabMessage(redfoxTab.id, {
    type: "redfox:completeRegistration",
    payload: {
      email,
      code,
      password: config.fixedPassword
    }
  });
  await waitForRedFoxDashboard(redfoxTab.id, 30000);
  await ensureContentScriptInjected(redfoxTab.id);

  runState.currentPhase = `第 ${round} 轮：创建 API Key`;
  await persistState();

  const apiKeyInfo = await sendTabMessage(redfoxTab.id, {
    type: "redfox:createApiKey",
    payload: { round }
  });

  const apiKey = apiKeyInfo?.apiKey || "";
  if (!apiKey) {
    throw new Error("RedFox 注册成功，但未读取到 API Key");
  }

  const credits = await getCurrentRedFoxCreditsSafely();

  await sendTabMessage(redfoxTab.id, {
    type: "redfox:logout"
  });
  await clearSiteDataForOrigin("https://redfox.hk");

  return {
    targetType: "redfox",
    round,
    attempt,
    email,
    password: config.fixedPassword,
    apiKey,
    credits,
    status: "success",
    createdAt: new Date().toISOString(),
    error: ""
  };
}

async function getCurrentRedFoxCreditsSafely() {
  try {
    const overview = await redfoxApiRequest("/story/web/points/overview");
    return extractRedFoxCredits(overview?.data);
  } catch (error) {
    console.warn("[AgensMachine] RedFox credits fetch failed", error);
    return "";
  }
}

async function refreshRedFoxCredits() {
  await hydrateState();

  if (runState.creditRefresh?.running) {
    throw new Error("RedFox 积分刷新已在运行中");
  }

  const { config = DEFAULT_CONFIG } = await chrome.storage.local.get("config");
  const targets = getUniqueRedFoxCreditTargets();
  if (!targets.length) {
    return { refreshed: false, count: 0, reason: "暂无 RedFox 账号" };
  }

  runState.creditRefresh = {
    running: true,
    current: "",
    checked: 0,
    total: targets.length,
    updated: 0,
    lastError: "",
    lastUpdatedAt: ""
  };
  await persistState();

  const errors = [];
  try {
    for (const target of targets) {
      const password = target.password || config.fixedPassword;
      try {
        if (!target.email || !password) {
          throw new Error(`账号 ${target.email || "-"} 缺少邮箱或密码`);
        }

        runState.creditRefresh.current = target.email;
        await persistState();

        const result = await fetchRedFoxCreditsByLogin(target.email, password);
        updateRedFoxCreditsForEmail(target.email, result.credits, result.raw);
        runState.creditRefresh.updated += 1;
        runState.creditRefresh.lastUpdatedAt = new Date().toISOString();
      } catch (error) {
        const message = `${target.email || "-"}: ${error.message || String(error)}`;
        errors.push(message);
        runState.creditRefresh.lastError = message;
      } finally {
        runState.creditRefresh.checked += 1;
        await persistState();
      }
    }
  } finally {
    await redfoxApiRequest("/story/web/user/logout", { method: "POST" }).catch(() => {});
    runState.creditRefresh.running = false;
    runState.creditRefresh.current = "";
    runState.creditRefresh.lastError = errors.join(" | ");
    runState.creditRefresh.lastUpdatedAt = new Date().toISOString();
    await persistState();
    await autoSaveLedgerFile(config);
  }

  return {
    refreshed: true,
    count: runState.creditRefresh.updated,
    checked: runState.creditRefresh.checked,
    errors
  };
}

function getUniqueRedFoxCreditTargets() {
  const map = new Map();
  const items = [
    ...(runState.keyLedger || []),
    ...(runState.pendingExports || []),
    ...(runState.exportedHistory || [])
  ];
  for (const item of items) {
    if (normalizeTargetType(item?.targetType) !== "redfox" || !item?.email) {
      continue;
    }
    const key = String(item.email).trim().toLowerCase();
    if (!map.has(key)) {
      map.set(key, {
        email: item.email,
        password: item.password || ""
      });
    }
  }
  return [...map.values()];
}

async function fetchRedFoxCreditsByLogin(email, password) {
  await clearSiteDataForOrigin(REDFOX_API_BASE);
  await redfoxApiRequest("/story/web/user/login", {
    method: "POST",
    body: {
      email: String(email).trim(),
      password: String(password).trim()
    }
  });

  const overview = await redfoxApiRequest("/story/web/points/overview");
  const credits = extractRedFoxCredits(overview?.data);
  if (credits === "") {
    throw new Error(`RedFox 账号 ${email} 未能解析积分字段`);
  }
  return { credits, raw: overview?.data || null };
}

async function redfoxApiRequest(path, options = {}) {
  const method = String(options.method || "GET").toUpperCase();
  const fetchOptions = {
    method,
    credentials: "include",
    headers: {
      "Content-Type": "application/json;charset=UTF-8",
      ...(options.headers || {})
    }
  };

  if (options.body !== undefined && method !== "GET" && method !== "DELETE") {
    fetchOptions.body = JSON.stringify(options.body);
  }

  let url = `${REDFOX_API_BASE}${path}`;
  if (options.body !== undefined && (method === "GET" || method === "DELETE")) {
    const params = new URLSearchParams();
    Object.entries(options.body || {}).forEach(([key, value]) => {
      if (value !== undefined && value !== null) {
        params.append(key, String(value));
      }
    });
    const qs = params.toString();
    if (qs) {
      url += `${url.includes("?") ? "&" : "?"}${qs}`;
    }
  }

  const response = await fetch(url, fetchOptions);
  let payload = null;
  try {
    payload = await response.json();
  } catch {
    payload = null;
  }

  if (!response.ok) {
    throw new Error(payload?.msg || `RedFox API 请求失败：${response.status} ${response.statusText}`);
  }

  const code = Number(payload?.code);
  if (![200, 2000].includes(code)) {
    throw new Error(payload?.msg || `RedFox API 响应异常：${payload?.code ?? "unknown"}`);
  }

  return payload;
}

function extractRedFoxCredits(data) {
  const directKeys = [
    "totalAvailablePoints",
    "availablePoints",
    "totalPoints",
    "remainingPoints",
    "balance",
    "credits",
    "points"
  ];
  for (const key of directKeys) {
    const value = data?.[key];
    if (value !== undefined && value !== null && value !== "") {
      const num = Number(value);
      return Number.isFinite(num) ? num : value;
    }
  }

  const free = Number(data?.freeAvailablePoints);
  const paid = Number(data?.paidAvailablePoints);
  if (Number.isFinite(free) || Number.isFinite(paid)) {
    return (Number.isFinite(free) ? free : 0) + (Number.isFinite(paid) ? paid : 0);
  }

  return "";
}

function updateRedFoxCreditsForEmail(email, credits, rawCredits) {
  const normalizedEmail = String(email || "").trim().toLowerCase();
  const updateList = (items = []) =>
    items.map((item) => {
      if (normalizeTargetType(item?.targetType) !== "redfox") {
        return item;
      }
      if (String(item.email || "").trim().toLowerCase() !== normalizedEmail) {
        return item;
      }
      return {
        ...item,
        credits,
        rawCredits,
        creditsUpdatedAt: new Date().toISOString()
      };
    });

  runState.keyLedger = updateList(runState.keyLedger);
  runState.pendingExports = updateList(runState.pendingExports);
  runState.exportedHistory = updateList(runState.exportedHistory);
  runState.results = updateList(runState.results);
}

async function resetWorkflowTabs() {
  const allTabs = await chrome.tabs.query({});
  const closable = allTabs.filter((tab) => {
    if (!tab.id || typeof tab.url !== "string") {
      return false;
    }
    return (
      tab.url.startsWith("https://tempmail.ing/") ||
      tab.url.startsWith("https://mail.cx/") ||
      tab.url.startsWith("https://platform.agnes-ai.com/") ||
      tab.url.startsWith("https://redfox.hk/")
    );
  });

  if (closable.length) {
    await chrome.tabs.remove(closable.map((tab) => tab.id));
    await delay(800);
  }
}

async function clearSiteDataForOrigin(origin) {
  if (!chrome.browsingData?.remove) {
    return;
  }

  try {
    await chrome.browsingData.remove(
      { origins: [origin] },
      {
        cacheStorage: true,
        cookies: true,
        indexedDB: true,
        localStorage: true,
        serviceWorkers: true,
        webSQL: true
      }
    );
    await delay(500);
  } catch (error) {
    console.warn("[AgensMachine] clear site data failed", { origin, error });
  }
}

async function assertRedFoxLoginPage(tabId) {
  const tab = await chrome.tabs.get(tabId);
  const url = String(tab?.url || "");
  try {
    const parsed = new URL(url);
    if (parsed.origin === "https://redfox.hk" && parsed.pathname.startsWith("/dashboard")) {
      throw new Error("RedFox 仍处于已登录状态，已停止本轮以避免在同一账号重复创建 key");
    }
  } catch (error) {
    if (error instanceof TypeError) {
      return;
    }
    throw error;
  }
}

async function pollVerificationCode(tabId, config, round) {
  const deadline = Date.now() + config.codeTimeoutMs;

  while (Date.now() < deadline) {
    if (runState.stopping) {
      throw new Error("任务已停止");
    }

    const response = await sendTabMessage(tabId, {
      type: "tm:getLatestCode"
    });
    runState.verificationPollCount = (runState.verificationPollCount || 0) + 1;
    runState.currentPhase = `第 ${round || runState.currentRound} 轮：等待验证码（第 ${runState.verificationPollCount} 次轮询）`;
    if (isValidVerificationCode(response?.code)) {
      runState.currentPhase = `第 ${round || runState.currentRound} 轮：已获取验证码`;
      await persistState();
      return response.code;
    }
    await persistState();

    await delay(config.pollIntervalMs);
  }

  throw new Error("等待验证码超时");
}

function isValidVerificationCode(code) {
  const value = String(code || "");
  if (!/^\d{6}$/.test(value)) {
    return false;
  }
  return !new Set(["000000", "111111", "123456", "202500", "202600", "999999"]).has(value);
}

async function ensureTab(url) {
  const allTabs = await chrome.tabs.query({});
  const expectedOrigin = new URL(url).origin;
  const target = allTabs.find((tab) => {
    if (typeof tab.url !== "string") {
      return false;
    }
    try {
      return new URL(tab.url).origin === expectedOrigin;
    } catch {
      return false;
    }
  });
  if (target?.id) {
    if (target.url !== url) {
      await chrome.tabs.update(target.id, { url, active: false });
    } else {
      await chrome.tabs.update(target.id, { active: false });
    }
    await waitForTabComplete(target.id);
    return target;
  }

  const created = await chrome.tabs.create({
    url,
    active: false
  });
  await waitForTabComplete(created.id);
  return created;
}

async function waitForTabComplete(tabId) {
  const tab = await chrome.tabs.get(tabId);
  if (tab.status === "complete") {
    return;
  }

  await new Promise((resolve) => {
    const listener = (updatedTabId, info) => {
      if (updatedTabId === tabId && info.status === "complete") {
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      }
    };
    chrome.tabs.onUpdated.addListener(listener);
  });

  await delay(1000);
}

async function waitForRedFoxDashboard(tabId, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    let tab = null;
    try {
      tab = await chrome.tabs.get(tabId);
    } catch {
      break;
    }

    const url = String(tab?.url || "");
    if (url.startsWith("https://redfox.hk/dashboard")) {
      await waitForTabComplete(tabId);
      await delay(1500);
      return true;
    }

    await delay(500);
  }

  throw new Error("RedFox 注册提交后未进入 dashboard");
}

async function sendTabMessage(tabId, message) {
  let lastError = null;

  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const response = await chrome.tabs.sendMessage(tabId, message);
      if (!response?.ok) {
        throw new Error(response?.error || "内容脚本执行失败");
      }
      return response.data;
    } catch (error) {
      lastError = error;
      const messageText = String(error?.message || error);
      if (isExpectedNavigationMessage(message, messageText)) {
        return { submitted: true, channelClosed: true };
      }
      if (
        messageText.includes("Receiving end does not exist") ||
        messageText.includes("message channel closed") ||
        messageText.includes("Extension context invalidated")
      ) {
        await waitForTabComplete(tabId).catch(() => {});
        await ensureContentScriptInjected(tabId);
      }
      await delay(500);
    }
  }

  throw lastError || new Error("内容脚本通信失败");
}

function isExpectedNavigationMessage(message, errorText) {
  return (
    message?.type === "redfox:completeRegistration" &&
    (errorText.includes("message channel closed") || errorText.includes("Extension context invalidated"))
  );
}

async function ensureContentScriptInjected(tabId) {
  const tab = await chrome.tabs.get(tabId);
  if (!tab?.url) {
    return;
  }

  let origin = "";
  try {
    origin = new URL(tab.url).origin;
  } catch {
    return;
  }

  const files = CONTENT_SCRIPT_FILES[origin];
  if (!files?.length) {
    return;
  }

  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      files
    });
    await delay(300);
  } catch (error) {
    console.warn("[AgensMachine] inject content script failed", { tabId, origin, error });
  }
}

async function exportResults() {
  await hydrateState();

  const ledgerItems = getKeyLedgerItems();
  if (!ledgerItems.length) {
    return { exported: false, count: 0, fileName: "" };
  }

  const fileName = getLedgerFileName((await chrome.storage.local.get("config")).config || DEFAULT_CONFIG);
  await downloadItemsAsCsv(ledgerItems, fileName, "overwrite");

  runState.exportedHistory = [...ledgerItems, ...(runState.exportedHistory || [])].slice(0, 500);
  runState.pendingExports = [];
  await persistState();

  return { exported: true, fileName, count: ledgerItems.length };
}

async function autoSaveLedgerFile(config) {
  const ledgerItems = getKeyLedgerItems();
  if (!ledgerItems.length) {
    return { saved: false, count: 0, fileName: "" };
  }

  try {
    const fileName = getLedgerFileName(config || DEFAULT_CONFIG);
    await downloadItemsAsCsv(ledgerItems, fileName, "overwrite");

    runState.autoSavedFiles = [
      {
        fileName,
        reason: "ledger",
        count: ledgerItems.length,
        savedAt: new Date().toISOString()
      },
      ...(runState.autoSavedFiles || [])
    ].slice(0, 100);
    await persistState();

    return { saved: true, count: ledgerItems.length, fileName };
  } catch (error) {
    console.warn("[AgensMachine] auto save results failed", error);
    return { saved: false, count: ledgerItems.length, fileName: "", error: error.message || String(error) };
  }
}

async function downloadItemsAsCsv(items, fileName, conflictAction) {
  const lines = [
    ["targetType", "round", "email", "password", "apiKey", "credits", "status", "createdAt", "error"].map(escapeCsvCell).join(","),
    ...items.map((item) =>
      [
        item.targetType || "agnes",
        item.round,
        item.email,
        item.password,
        item.apiKey,
        item.credits ?? "",
        item.status,
        item.createdAt,
        item.error || ""
      ].map(escapeCsvCell).join(",")
    )
  ];

  const content = `\uFEFF${lines.join("\r\n")}`;
  const dataUrl = `data:text/plain;charset=utf-8,${encodeURIComponent(content)}`;

  await chrome.downloads.download({
    url: dataUrl,
    filename: fileName,
    conflictAction,
    saveAs: false
  });
}

function escapeCell(value) {
  return String(value).replace(/\t/g, " ").replace(/\r?\n/g, " ");
}

function escapeCsvCell(value) {
  const text = String(value ?? "");
  if (/[",\r\n]/.test(text)) {
    return `"${text.replace(/"/g, '""')}"`;
  }
  return text;
}

function sanitizeConfig(input) {
  return {
    targetType: normalizeTargetType(input.targetType || DEFAULT_CONFIG.targetType),
    loopCount: normalizeInt(input.loopCount, DEFAULT_CONFIG.loopCount, 1, 9999),
    fixedPassword: String(input.fixedPassword || DEFAULT_CONFIG.fixedPassword).trim(),
    countFailedAttempt: Boolean(input.countFailedAttempt),
    maxRetryPerRound: normalizeInt(input.maxRetryPerRound, DEFAULT_CONFIG.maxRetryPerRound, 1, 20),
    codeTimeoutMs: normalizeInt(input.codeTimeoutMs, DEFAULT_CONFIG.codeTimeoutMs, 10000, 600000),
    pollIntervalMs: normalizeInt(input.pollIntervalMs, DEFAULT_CONFIG.pollIntervalMs, 1000, 60000),
    exportFileName: normalizeFileName(input.exportFileName || DEFAULT_CONFIG.exportFileName)
  };
}

function normalizeTargetType(value) {
  return value === "redfox" ? "redfox" : "agnes";
}

function normalizeInt(value, fallback, min, max) {
  const num = Number(value);
  if (!Number.isFinite(num)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, Math.floor(num)));
}

function normalizeFileName(name) {
  const cleaned = String(name).trim().replace(/[<>:"/\\|?*\x00-\x1F]/g, "-");
  return cleaned || DEFAULT_CONFIG.exportFileName;
}

function createEmptyCreditRefreshState() {
  return {
    running: false,
    current: "",
    checked: 0,
    total: 0,
    updated: 0,
    lastError: "",
    lastUpdatedAt: ""
  };
}

function getLedgerFileName(config) {
  const safeName = normalizeFileName(config?.exportFileName || DEFAULT_CONFIG.exportFileName);
  const dotIndex = safeName.lastIndexOf(".");
  const stem = dotIndex > 0 ? safeName.slice(0, dotIndex) : safeName;
  return `${stem}.csv`;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function toPendingExportItem(result) {
  return {
    targetType: result.targetType,
    round: result.round,
    attempt: result.attempt,
    email: result.email,
    password: result.password,
    apiKey: result.apiKey,
    credits: normalizeCredits(result.credits, result.targetType),
    status: result.status,
    createdAt: result.createdAt,
    error: result.error || ""
  };
}

function normalizeCredits(value, targetType) {
  if (value !== undefined && value !== null && value !== "") {
    const num = Number(value);
    return Number.isFinite(num) ? num : value;
  }
  return normalizeTargetType(targetType) === "redfox" ? 200 : "";
}

function normalizeLedgerItem(item) {
  return {
    targetType: item.targetType || "agnes",
    round: item.round,
    attempt: item.attempt,
    email: item.email || "",
    password: item.password || "",
    apiKey: item.apiKey || "",
    credits: normalizeCredits(item.credits, item.targetType),
    status: item.status || "success",
    createdAt: item.createdAt || new Date().toISOString(),
    error: item.error || ""
  };
}

function getLedgerKey(item) {
  if (item.apiKey) {
    return `key:${item.apiKey}`;
  }
  return `row:${item.targetType || ""}:${item.email || ""}:${item.round || ""}:${item.createdAt || ""}`;
}

function dedupeLedgerItems(items) {
  const map = new Map();
  for (const item of items) {
    const normalized = normalizeLedgerItem(item || {});
    if (!normalized.apiKey) {
      continue;
    }
    map.set(getLedgerKey(normalized), normalized);
  }
  return [...map.values()];
}

function upsertKeyLedgerItem(item) {
  const nextItem = normalizeLedgerItem(item);
  if (!nextItem.apiKey) {
    return;
  }

  const ledger = runState.keyLedger || [];
  const key = getLedgerKey(nextItem);
  const index = ledger.findIndex((existing) => getLedgerKey(existing) === key);
  if (index >= 0) {
    ledger[index] = nextItem;
  } else {
    ledger.push(nextItem);
  }
  runState.keyLedger = ledger;
}

function getKeyLedgerItems() {
  runState.keyLedger = dedupeLedgerItems([
    ...(runState.keyLedger || []),
    ...(runState.pendingExports || []),
    ...(runState.exportedHistory || [])
  ]);
  return runState.keyLedger;
}

async function persistState() {
  await chrome.storage.local.set({ runState });
}

async function hydrateState() {
  if (stateHydrated) {
    return;
  }

  const stored = await chrome.storage.local.get("runState");
  if (stored.runState && typeof stored.runState === "object") {
    runState = {
      ...runState,
      ...stored.runState,
      pendingExports: stored.runState.pendingExports || [],
      keyLedger: dedupeLedgerItems([
        ...(stored.runState.keyLedger || []),
        ...(stored.runState.pendingExports || []),
        ...(stored.runState.exportedHistory || [])
      ]),
      exportedHistory: stored.runState.exportedHistory || [],
      autoSavedFiles: stored.runState.autoSavedFiles || [],
      creditRefresh: {
        ...createEmptyCreditRefreshState(),
        ...(stored.runState.creditRefresh || {}),
        running: false,
        current: ""
      },
      results: stored.runState.results || []
    };
  }

  stateHydrated = true;
}
