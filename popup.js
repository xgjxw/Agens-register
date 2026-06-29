const fields = {
  targetType: document.querySelector("#targetType"),
  loopCount: document.querySelector("#loopCount"),
  fixedPassword: document.querySelector("#fixedPassword"),
  countFailedAttempt: document.querySelector("#countFailedAttempt"),
  maxRetryPerRound: document.querySelector("#maxRetryPerRound"),
  codeTimeoutMs: document.querySelector("#codeTimeoutMs"),
  pollIntervalMs: document.querySelector("#pollIntervalMs"),
  exportFileName: document.querySelector("#exportFileName")
};

const runBadge = document.querySelector("#runBadge");
const progressText = document.querySelector("#progressText");
const statusCards = document.querySelector("#statusCards");
const statusText = document.querySelector("#statusText");
const queueBody = document.querySelector("#queueBody");
const queueCount = document.querySelector("#queueCount");
const startBtn = document.querySelector("#startBtn");
const stopBtn = document.querySelector("#stopBtn");
const refreshCreditsBtn = document.querySelector("#refreshCreditsBtn");
const exportBtn = document.querySelector("#exportBtn");

document.querySelector("#saveBtn").addEventListener("click", async () => {
  await saveConfig();
  await refresh();
});

startBtn.addEventListener("click", async () => {
  startBtn.classList.add("active");
  await saveConfig();
  await sendMessage("popup:start", { config: readConfigFromForm() });
  await refresh();
});

stopBtn.addEventListener("click", async () => {
  stopBtn.classList.add("active");
  await sendMessage("popup:stop");
  await refresh();
});

refreshCreditsBtn.addEventListener("click", async () => {
  refreshCreditsBtn.classList.add("active");
  try {
    const result = await sendMessage("popup:refreshRedFoxCredits");
    await refresh();
    if (result.refreshed === false) {
      statusText.textContent += `\n\n${result.reason || "没有可刷新的 RedFox 账号"}。`;
    }
  } finally {
    setTimeout(() => refreshCreditsBtn.classList.remove("active"), 700);
  }
});

exportBtn.addEventListener("click", async () => {
  exportBtn.classList.add("active");
  const result = await sendMessage("popup:exportNow");
  await refresh();
  setTimeout(() => exportBtn.classList.remove("active"), 700);
  if (result.exported === false) {
    statusText.textContent += "\n\n没有可导出的 key。";
  }
});

setInterval(refresh, 1500);
refresh();

async function saveConfig() {
  await sendMessage("popup:saveConfig", { config: readConfigFromForm() });
}

async function refresh() {
  try {
    const response = await sendMessage("popup:getState");
    if (!isEditingForm()) {
      applyConfig(response.config);
    }
    renderState(response.state);
    renderQueue(response.state.pendingExports || []);
  } catch (error) {
    statusText.textContent = `状态读取失败: ${error.message || error}`;
  }
}

function applyConfig(config) {
  fields.targetType.value = config.targetType || "agnes";
  fields.loopCount.value = config.loopCount ?? "";
  fields.fixedPassword.value = config.fixedPassword ?? "";
  fields.countFailedAttempt.value = String(config.countFailedAttempt);
  fields.maxRetryPerRound.value = config.maxRetryPerRound ?? "";
  fields.codeTimeoutMs.value = config.codeTimeoutMs ?? "";
  fields.pollIntervalMs.value = config.pollIntervalMs ?? "";
  fields.exportFileName.value = config.exportFileName ?? "";
}

function renderState(state) {
  updateButtons(state);

  const phase = formatPhase(state);
  progressText.textContent = `${state.currentRound || 0}/${state.totalRounds || 0}`;
  statusCards.innerHTML = [
    card("成功", state.successCount ?? 0),
    card("失败", state.failCount ?? 0),
    card("待导出", (state.pendingExports || []).length),
    card("总表", (state.keyLedger || []).length),
    card("积分刷新", formatCreditRefreshCard(state.creditRefresh))
  ].join("");

  const lines = [
    `状态: ${state.running ? "运行中" : state.stopping ? "停止中" : "空闲"}`,
    `阶段: ${phase}`,
    `发卡类型: ${formatTargetType(state.targetType)}`,
    `轮次: ${state.currentRound || 0}/${state.totalRounds || 0}`,
    `最近邮箱: ${state.lastEmail || "-"}`,
    `最近验证码: ${state.lastCode || "-"}`,
    `最后错误: ${state.lastError || "-"}`,
    formatCreditRefreshStatus(state.creditRefresh),
    "",
    "最近结果:",
    formatRecentResults(state.results || [])
  ];

  statusText.textContent = lines.join("\n");
}

function updateButtons(state) {
  runBadge.className = "run-badge";
  if (state.stopping) {
    runBadge.classList.add("stopping");
    runBadge.textContent = "停止中";
  } else if (state.running) {
    runBadge.classList.add("running");
    runBadge.textContent = "运行中";
  } else {
    runBadge.classList.add("idle");
    runBadge.textContent = "空闲";
  }

  startBtn.classList.toggle("active", Boolean(state.running && !state.stopping));
  stopBtn.classList.toggle("active", Boolean(state.stopping));
  refreshCreditsBtn.classList.toggle("active", Boolean(state.creditRefresh?.running));
}

function formatPhase(state) {
  if (state.stopping) {
    return "正在停止，等待当前步骤结束";
  }
  if (!state.running) {
    return "等待开始";
  }
  if (state.currentPhase) {
    return state.currentPhase;
  }
  if (state.verificationPollCount > 0) {
    return `等待验证码，第 ${state.verificationPollCount} 次轮询`;
  }
  return "执行中";
}

function card(label, value) {
  return `
    <div class="status-card">
      <div class="label">${escapeHtml(label)}</div>
      <div class="value">${escapeHtml(String(value))}</div>
    </div>
  `;
}

function formatCreditRefreshCard(refreshState) {
  if (!refreshState?.running) {
    return refreshState?.lastUpdatedAt ? `已更新 ${refreshState.updated || 0}` : "-";
  }
  return `${refreshState.checked || 0}/${refreshState.total || 0}`;
}

function formatCreditRefreshStatus(refreshState) {
  if (!refreshState) {
    return "RedFox 积分刷新: -";
  }
  if (refreshState.running) {
    return `RedFox 积分刷新: 运行中 ${refreshState.checked || 0}/${refreshState.total || 0} ${refreshState.current || ""}`;
  }
  const updatedAt = refreshState.lastUpdatedAt ? formatLocalTime(refreshState.lastUpdatedAt) : "-";
  const error = refreshState.lastError ? `，错误: ${refreshState.lastError}` : "";
  return `RedFox 积分刷新: 已更新 ${refreshState.updated || 0} 个，时间: ${updatedAt}${error}`;
}

function formatRecentResults(results) {
  const recent = results.slice(-2);
  if (!recent.length) {
    return "暂无";
  }
  return recent
    .map((item) =>
      [
        `#${item.round || "-"} ${formatTargetType(item.targetType)} ${item.status || "-"}`,
        `邮箱: ${item.email || "-"}`,
        `Key: ${item.apiKey || "-"}`,
        item.error ? `错误: ${item.error}` : ""
      ]
        .filter(Boolean)
        .join("\n")
    )
    .join("\n---\n");
}

function renderQueue(items) {
  queueCount.textContent = String(items.length);

  if (!items.length) {
    queueBody.innerHTML = `
      <tr>
        <td colspan="6" class="empty">暂无待导出数据</td>
      </tr>
    `;
    return;
  }

  queueBody.innerHTML = items
    .map(
      (item) => `
        <tr>
          <td>${escapeHtml(String(item.round ?? "-"))}</td>
          <td>${escapeHtml(formatTargetType(item.targetType))}</td>
          <td class="mono">${escapeHtml(item.email || "-")}</td>
          <td class="mono key-cell" title="${escapeHtml(item.apiKey || "-")}">${escapeHtml(item.apiKey || "-")}</td>
          <td>${escapeHtml(String(item.credits ?? "-"))}</td>
          <td>${escapeHtml(formatLocalTime(item.createdAt))}</td>
        </tr>
      `
    )
    .join("");
}

function formatTargetType(value) {
  return value === "redfox" ? "RedFox" : "Agens";
}

function formatLocalTime(value) {
  if (!value) {
    return "-";
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }
  const pad = (n) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function readConfigFromForm() {
  return {
    targetType: fields.targetType.value,
    loopCount: Number(fields.loopCount.value),
    fixedPassword: fields.fixedPassword.value,
    countFailedAttempt: fields.countFailedAttempt.value === "true",
    maxRetryPerRound: Number(fields.maxRetryPerRound.value),
    codeTimeoutMs: Number(fields.codeTimeoutMs.value),
    pollIntervalMs: Number(fields.pollIntervalMs.value),
    exportFileName: fields.exportFileName.value
  };
}

function isEditingForm() {
  const active = document.activeElement;
  return active instanceof HTMLInputElement || active instanceof HTMLSelectElement;
}

async function sendMessage(type, extra = {}) {
  const response = await chrome.runtime.sendMessage({ type, ...extra });
  if (!response?.ok) {
    throw new Error(response?.error || "消息发送失败");
  }
  return response.data;
}
