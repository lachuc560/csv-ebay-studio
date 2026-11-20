"use strict";
(() => {
  // src/connection.ts
  function normalizeToolUrl(input) {
    const raw = input.trim();
    if (!raw) return null;
    let url;
    try {
      url = new URL(/^[a-z]+:\/\//i.test(raw) ? raw : `https://${raw}`);
    } catch {
      return null;
    }
    const local = url.hostname === "localhost" || url.hostname === "127.0.0.1";
    if (url.protocol !== "https:" && !(local && url.protocol === "http:")) return null;
    return url.origin;
  }
  var ERROR_TEXT = {
    invalid_api_key: "Kh\xF3a crawl sai ho\u1EB7c \u0111\xE3 b\u1ECB thu h\u1ED3i. T\u1EA1o kh\xF3a m\u1EDBi trong tool, m\u1EE5c Kh\xF3a crawl.",
    records_required: "Trang n\xE0y kh\xF4ng c\xF3 d\u1EEF li\u1EC7u s\u1EA3n ph\u1EA9m \u0111\u1EC3 g\u1EEDi.",
    invalid_records: "D\u1EEF li\u1EC7u \u0111\u1ECDc \u0111\u01B0\u1EE3c kh\xF4ng \u0111\xFAng m\u1EABu.",
    invalid_products: "D\u1EEF li\u1EC7u \u0111\u1ECDc \u0111\u01B0\u1EE3c kh\xF4ng \u0111\xFAng m\u1EABu.",
    body_too_large: "S\u1EA3n ph\u1EA9m qu\xE1 l\u1EDBn \u0111\u1EC3 g\u1EEDi m\u1ED9t l\u1EA7n.",
    too_many_records: "G\u1EEDi qu\xE1 nhi\u1EC1u s\u1EA3n ph\u1EA9m m\u1ED9t l\u1EA7n.",
    has_real_data: "Tool \u0111ang c\xF3 d\u1EEF li\u1EC7u th\u1EADt, kh\xF4ng ghi \u0111\xE8 \u0111\u01B0\u1EE3c.",
    server_error: "M\xE1y ch\u1EE7 g\u1EB7p l\u1ED7i. Th\u1EED l\u1EA1i sau."
  };
  function describeResult(result, truncated) {
    const p = result.products[0];
    if (!p) return { text: "\u0110\xE3 g\u1EEDi, nh\u01B0ng kh\xF4ng c\xF3 s\u1EA3n ph\u1EA9m n\xE0o \u0111\u01B0\u1EE3c nh\u1EADn.", tone: "info" };
    const verb = result.updated ? "\u0110\xE3 c\u1EADp nh\u1EADt" : "\u0110\xE3 th\xEAm";
    const notes = [
      p.currency !== "USD" ? `Gi\xE1 \u0111ang l\xE0 ${p.currency}: tool s\u1EBD ch\u1EB7n xu\u1EA5t. \u0110\u1ED5i ti\u1EC1n t\u1EC7 trang sang USD r\u1ED3i crawl l\u1EA1i.` : "",
      p.priceEstimated ? "Gi\xE1 c\xE1c bi\u1EBFn th\u1EC3 kh\xE1c l\u1EA5y theo bi\u1EBFn th\u1EC3 \u0111ang ch\u1ECDn, c\u1EA7n ki\u1EC3m l\u1EA1i." : "",
      truncated ? "S\u1EA3n ph\u1EA9m c\xF3 qu\xE1 nhi\u1EC1u l\u1EF1a ch\u1ECDn n\xEAn ch\u01B0a \u0111\u1ECDc h\u1EBFt." : "",
      p.images ? "" : "Kh\xF4ng th\u1EA5y \u1EA3nh, c\u1EA7n b\u1ED5 sung trong tool."
    ].filter(Boolean);
    return {
      text: `${verb} "${p.title}": ${p.variants} bi\u1EBFn th\u1EC3, ${p.inStock} c\xF2n h\xE0ng, ${p.images} \u1EA3nh. ${notes.join(" ")}`.trim(),
      tone: notes.length ? "info" : "ok"
    };
  }

  // src/popup.ts
  var $ = (id) => document.getElementById(id);
  var crawlBtn = $("crawl");
  var crawlLabel = $("crawlLabel");
  var statusBox = $("status");
  var openTool = $("openTool");
  var settingsForm = $("settings");
  var openSettings = $("openSettings");
  var toolUrlInput = $("toolUrl");
  var apiKeyInput = $("apiKey");
  var settingsError = $("settingsError");
  var saveBtn = $("save");
  var dot = $("connectionDot");
  var connectionText = $("connectionText");
  var settings = { toolUrl: "", apiKey: "" };
  var ApiError = class extends Error {
    constructor(code) {
      super(code);
      this.code = code;
    }
  };
  function showStatus(text, tone) {
    statusBox.textContent = text;
    statusBox.className = `status ${tone}`;
    statusBox.hidden = false;
  }
  function setConnection(state, text) {
    dot.className = `status-dot${state === "none" ? "" : ` ${state}`}`;
    connectionText.textContent = text;
  }
  function toggleSettings(open) {
    settingsForm.hidden = !open;
    openSettings.setAttribute("aria-expanded", String(open));
    if (open) toolUrlInput.focus();
  }
  async function api(path, init2 = {}) {
    let res;
    try {
      res = await fetch(`${settings.toolUrl}/api/${path}`, {
        ...init2,
        headers: { ...init2.body ? { "Content-Type": "application/json" } : {}, Authorization: `Bearer ${settings.apiKey}` }
      });
    } catch {
      throw new ApiError("network");
    }
    if (!(res.headers.get("Content-Type") || "").includes("application/json")) throw new ApiError("access_blocked");
    const data = await res.json();
    if (!res.ok) throw new ApiError(data.error || "server_error");
    return data;
  }
  function errorText(error) {
    if (error instanceof ApiError) {
      if (error.code === "network") return "Kh\xF4ng k\u1EBFt n\u1ED1i \u0111\u01B0\u1EE3c tool. Ki\u1EC3m tra \u0111\u1ECBa ch\u1EC9 tool v\xE0 m\u1EA1ng.";
      if (error.code === "access_blocked") return "Tool ch\u1EB7n extension \u1EDF b\u01B0\u1EDBc \u0111\u0103ng nh\u1EADp. Ng\u01B0\u1EDDi qu\u1EA3n tr\u1ECB c\u1EA7n m\u1EDF \u0111\u01B0\u1EDDng /api/ingest/* (xem README).";
      return ERROR_TEXT[error.code] ?? `L\u1ED7i t\u1EEB tool: ${error.code}`;
    }
    return error instanceof Error ? error.message : "C\xF3 l\u1ED7i x\u1EA3y ra.";
  }
  async function checkConnection() {
    if (!settings.toolUrl || !settings.apiKey) {
      setConnection("none", "Ch\u01B0a c\u1EA5u h\xECnh \u0111\u1ECBa ch\u1EC9 tool v\xE0 kh\xF3a");
      return false;
    }
    try {
      const { name } = await api("ingest/ping");
      setConnection("ok", `\u0110\xE3 k\u1EBFt n\u1ED1i, kh\xF3a: ${name}`);
      return true;
    } catch (error) {
      setConnection("error", errorText(error));
      return false;
    }
  }
  async function showPageHost() {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    try {
      $("pageHost").textContent = tab?.url ? new URL(tab.url).hostname : "Trang \u0111ang m\u1EDF";
    } catch {
      $("pageHost").textContent = "Trang \u0111ang m\u1EDF";
    }
  }
  async function crawl() {
    if (!settings.toolUrl || !settings.apiKey) {
      toggleSettings(true);
      showStatus("Nh\u1EADp \u0111\u1ECBa ch\u1EC9 tool v\xE0 kh\xF3a crawl tr\u01B0\u1EDBc.", "error");
      return;
    }
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id || !tab.url || !/^https?:/.test(tab.url)) throw new Error("H\xE3y m\u1EDF trang chi ti\u1EBFt s\u1EA3n ph\u1EA9m r\u1ED3i b\u1EA5m l\u1EA1i.");
    crawlLabel.textContent = "\u0110ang \u0111\u1ECDc bi\u1EBFn th\u1EC3 tr\xEAn trang...";
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["dist/content.js"] });
    const read = await chrome.tabs.sendMessage(tab.id, { type: "EXTRACT_CSV" });
    if (!read?.ok || !read.record) throw new Error(read?.error || "Kh\xF4ng \u0111\u1ECDc \u0111\u01B0\u1EE3c s\u1EA3n ph\u1EA9m tr\xEAn trang n\xE0y.");
    crawlLabel.textContent = "\u0110ang g\u1EEDi v\xE0o tool...";
    const result = await api("ingest/records", { method: "POST", body: JSON.stringify({ records: [read.record] }) });
    const message = describeResult(result, Boolean(read.record.crawl_truncated));
    showStatus(message.text, message.tone);
    openTool.href = settings.toolUrl;
    openTool.hidden = false;
  }
  crawlBtn.addEventListener("click", async () => {
    if (crawlBtn.disabled) return;
    crawlBtn.disabled = true;
    crawlBtn.classList.add("loading");
    statusBox.hidden = true;
    openTool.hidden = true;
    try {
      await crawl();
    } catch (error) {
      showStatus(errorText(error), "error");
    } finally {
      crawlBtn.disabled = false;
      crawlBtn.classList.remove("loading");
      crawlLabel.textContent = "Crawl trang n\xE0y";
    }
  });
  openSettings.addEventListener("click", () => toggleSettings(settingsForm.hidden));
  settingsForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    settingsError.hidden = true;
    toolUrlInput.removeAttribute("aria-invalid");
    apiKeyInput.removeAttribute("aria-invalid");
    const toolUrl = normalizeToolUrl(toolUrlInput.value);
    const apiKey = apiKeyInput.value.trim();
    const fail = (input, text) => {
      input.setAttribute("aria-invalid", "true");
      settingsError.textContent = text;
      settingsError.hidden = false;
      input.focus();
    };
    if (!toolUrl) return fail(toolUrlInput, "\u0110\u1ECBa ch\u1EC9 tool ph\u1EA3i l\xE0 https, v\xED d\u1EE5 https://csv.tencongty.com.");
    if (!apiKey.startsWith("csvk_")) return fail(apiKeyInput, "Kh\xF3a crawl b\u1EAFt \u0111\u1EA7u b\u1EB1ng csvk_. T\u1EA1o kh\xF3a trong tool, m\u1EE5c Kh\xF3a crawl.");
    const granted = await chrome.permissions.request({ origins: [`${toolUrl}/*`] });
    if (!granted) return fail(toolUrlInput, "C\u1EA7n cho ph\xE9p extension g\u1EEDi d\u1EEF li\u1EC7u t\u1EDBi \u0111\u1ECBa ch\u1EC9 tool n\xE0y.");
    saveBtn.disabled = true;
    saveBtn.classList.add("loading");
    settings = { toolUrl, apiKey };
    await chrome.storage.local.set(settings);
    toolUrlInput.value = toolUrl;
    const ok = await checkConnection();
    saveBtn.disabled = false;
    saveBtn.classList.remove("loading");
    if (ok) toggleSettings(false);
    else fail(apiKeyInput, connectionText.textContent || "Kh\xF4ng k\u1EBFt n\u1ED1i \u0111\u01B0\u1EE3c.");
  });
  async function init() {
    const stored = await chrome.storage.local.get(["toolUrl", "apiKey"]);
    settings = { toolUrl: String(stored.toolUrl || ""), apiKey: String(stored.apiKey || "") };
    toolUrlInput.value = settings.toolUrl;
    apiKeyInput.value = settings.apiKey;
    void showPageHost();
    if (!await checkConnection()) toggleSettings(true);
  }
  void init();
})();
