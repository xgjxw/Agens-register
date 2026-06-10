const URLS = {
  tempMail: "https://tempmail.ing/zh-CN/",
  agnesLogin: "https://platform.agnes-ai.com/login"
};

const CONTENT_SCRIPT_FILES = {
  "https://tempmail.ing": ["content/tempmail.js"],
  "https://platform.agnes-ai.com": ["content/agnes.js"]
};

const DEFAULT_CONFIG = {
  loopCount: 1,
  fixedPassword: "Agnes#2026!Auto",
  countFailedAttempt: true,
  maxRetryPerRound: 2,
  codeTimeoutMs: 120000,
  pollIntervalMs: 5000,
  exportFileName: "agens-keys.txt"
};

let runState = {
  running: false,
  stopping: false,
  startedAt: null,
  currentRound: 0,
  totalRounds: 0,
  successCount: 0,
  failCount: 0,
  lastError: "",
  lastEmail: "",
  lastCode: "",
  pendingExports: [],
  exportedHistory: [],
  results: []
};

chrome.runtime.onInstalled.addListener(async () => {
  const { config } = await chrome.storage.local.get("config");
  if (!config) {
    await chrome.storage.local.set({ config: DEFAULT_CONFIG });
  }
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
    default:
      throw new Error(`未知消息类型: ${message?.type}`);
  }
}

async function getCombinedState() {
  const { config = DEFAULT_CONFIG } = await chrome.storage.local.get("config");
  return {
    config,
    state: runState
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
    currentRound: 0,
    totalRounds: mergedConfig.loopCount,
    successCount: 0,
    failCount: 0,
    lastError: "",
    lastEmail: "",
    lastCode: "",
    pendingExports: runState.pendingExports || [],
    exportedHistory: runState.exportedHistory || [],
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
    await persistState();

    let roundResult = null;
    try {
      roundResult = await runSingleRound(round, config);
      runState.successCount += 1;
      runState.results.push(roundResult);
      runState.pendingExports.push(toPendingExportItem(roundResult));
      completedCount += 1;
    } catch (error) {
      runState.failCount += 1;
      runState.lastError = error.message || String(error);
      roundResult = {
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
  await persistState();
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
  await persistState();

  await sendTabMessage(agnesTab.id, {
    type: "agnes:startRegistration",
    payload: {
      email
    }
  });

  const code = await pollVerificationCode(tempMailTab.id, config);
  if (!code) {
    throw new Error("未能读取验证码");
  }
  runState.lastCode = code;
  await persistState();

  await sendTabMessage(agnesTab.id, {
    type: "agnes:completeRegistration",
    payload: {
      email,
      code,
      password: config.fixedPassword
    }
  });

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

async function resetWorkflowTabs() {
  const allTabs = await chrome.tabs.query({});
  const closable = allTabs.filter((tab) => {
    if (!tab.id || typeof tab.url !== "string") {
      return false;
    }
    return (
      tab.url.startsWith("https://tempmail.ing/") ||
      tab.url.startsWith("https://platform.agnes-ai.com/")
    );
  });

  if (closable.length) {
    await chrome.tabs.remove(closable.map((tab) => tab.id));
    await delay(800);
  }
}

async function pollVerificationCode(tabId, config) {
  const deadline = Date.now() + config.codeTimeoutMs;

  while (Date.now() < deadline) {
    if (runState.stopping) {
      throw new Error("任务已停止");
    }

    const response = await sendTabMessage(tabId, {
      type: "tm:getLatestCode"
    });
    if (response?.code) {
      return response.code;
    }

    await delay(config.pollIntervalMs);
  }

  throw new Error("等待验证码超时");
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
      if (String(error?.message || error).includes("Receiving end does not exist")) {
        await ensureContentScriptInjected(tabId);
      }
      await delay(500);
    }
  }

  throw lastError || new Error("内容脚本通信失败");
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
  const pendingItems = (runState.pendingExports || []).filter((item) => item.apiKey);
  if (!pendingItems.length) {
    return { exported: false, count: 0, fileName: "" };
  }

  const lines = [
    "round\temail\tpassword\tapiKey\tstatus\tcreatedAt\terror",
    ...pendingItems.map((item) =>
      [
        item.round,
        item.email,
        item.password,
        item.apiKey,
        item.status,
        item.createdAt,
        escapeCell(item.error || "")
      ].join("\t")
    )
  ];

  const fileName = (await chrome.storage.local.get("config")).config?.exportFileName || DEFAULT_CONFIG.exportFileName;
  const content = lines.join("\n");
  const dataUrl = `data:text/plain;charset=utf-8,${encodeURIComponent(content)}`;

  await chrome.downloads.download({
    url: dataUrl,
    filename: fileName,
    conflictAction: "overwrite",
    saveAs: false
  });

  runState.exportedHistory = [...pendingItems, ...(runState.exportedHistory || [])].slice(0, 500);
  runState.pendingExports = [];
  await persistState();

  return { exported: true, fileName, count: pendingItems.length };
}

function escapeCell(value) {
  return String(value).replace(/\t/g, " ").replace(/\r?\n/g, " ");
}

function sanitizeConfig(input) {
  return {
    loopCount: normalizeInt(input.loopCount, DEFAULT_CONFIG.loopCount, 1, 9999),
    fixedPassword: String(input.fixedPassword || DEFAULT_CONFIG.fixedPassword).trim(),
    countFailedAttempt: Boolean(input.countFailedAttempt),
    maxRetryPerRound: normalizeInt(input.maxRetryPerRound, DEFAULT_CONFIG.maxRetryPerRound, 1, 20),
    codeTimeoutMs: normalizeInt(input.codeTimeoutMs, DEFAULT_CONFIG.codeTimeoutMs, 10000, 600000),
    pollIntervalMs: normalizeInt(input.pollIntervalMs, DEFAULT_CONFIG.pollIntervalMs, 1000, 60000),
    exportFileName: normalizeFileName(input.exportFileName || DEFAULT_CONFIG.exportFileName)
  };
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

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function toPendingExportItem(result) {
  return {
    round: result.round,
    attempt: result.attempt,
    email: result.email,
    password: result.password,
    apiKey: result.apiKey,
    status: result.status,
    createdAt: result.createdAt,
    error: result.error || ""
  };
}

async function persistState() {
  await chrome.storage.local.set({ runState });
}
