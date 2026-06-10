const fields = {
  loopCount: document.querySelector("#loopCount"),
  fixedPassword: document.querySelector("#fixedPassword"),
  countFailedAttempt: document.querySelector("#countFailedAttempt"),
  maxRetryPerRound: document.querySelector("#maxRetryPerRound"),
  codeTimeoutMs: document.querySelector("#codeTimeoutMs"),
  pollIntervalMs: document.querySelector("#pollIntervalMs"),
  exportFileName: document.querySelector("#exportFileName")
};

const statusText = document.querySelector("#statusText");
const queueBody = document.querySelector("#queueBody");
const queueCount = document.querySelector("#queueCount");

document.querySelector("#saveBtn").addEventListener("click", async () => {
  await sendMessage("popup:saveConfig", { config: readConfigFromForm() });
  await refresh();
});

document.querySelector("#startBtn").addEventListener("click", async () => {
  await sendMessage("popup:saveConfig", { config: readConfigFromForm() });
  await sendMessage("popup:start", { config: readConfigFromForm() });
  await refresh();
});

document.querySelector("#stopBtn").addEventListener("click", async () => {
  await sendMessage("popup:stop");
  await refresh();
});

document.querySelector("#exportBtn").addEventListener("click", async () => {
  const result = await sendMessage("popup:exportNow");
  await refresh();
  if (result.exported === false) {
    statusText.textContent += "\n\n没有可导出的 key。";
  }
});

setInterval(refresh, 1500);
refresh();

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
  fields.loopCount.value = config.loopCount ?? "";
  fields.fixedPassword.value = config.fixedPassword ?? "";
  fields.countFailedAttempt.value = String(config.countFailedAttempt);
  fields.maxRetryPerRound.value = config.maxRetryPerRound ?? "";
  fields.codeTimeoutMs.value = config.codeTimeoutMs ?? "";
  fields.pollIntervalMs.value = config.pollIntervalMs ?? "";
  fields.exportFileName.value = config.exportFileName ?? "";
}

function renderState(state) {
  statusText.textContent = [
    `运行中: ${state.running ? "是" : "否"}`,
    `停止中: ${state.stopping ? "是" : "否"}`,
    `开始时间: ${state.startedAt || "-"}`,
    `当前轮次: ${state.currentRound}/${state.totalRounds}`,
    `成功: ${state.successCount}`,
    `失败: ${state.failCount}`,
    `最近邮箱: ${state.lastEmail || "-"}`,
    `最近验证码: ${state.lastCode || "-"}`,
    `待导出: ${(state.pendingExports || []).length}`,
    `最后错误: ${state.lastError || "-"}`,
    "",
    "最近结果:",
    JSON.stringify((state.results || []).slice(-3), null, 2)
  ].join("\n");
}

function renderQueue(items) {
  queueCount.textContent = String(items.length);

  if (!items.length) {
    queueBody.innerHTML = `
      <tr>
        <td colspan="4" class="empty">暂无待导出数据</td>
      </tr>
    `;
    return;
  }

  queueBody.innerHTML = items
    .map(
      (item) => `
        <tr>
          <td>${escapeHtml(String(item.round ?? "-"))}</td>
          <td class="mono">${escapeHtml(item.email || "-")}</td>
          <td class="mono key-cell" title="${escapeHtml(item.apiKey || "-")}">${escapeHtml(item.apiKey || "-")}</td>
          <td>${escapeHtml(formatLocalTime(item.createdAt))}</td>
        </tr>
      `
    )
    .join("");
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
