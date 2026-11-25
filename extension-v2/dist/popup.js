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
  // src/popup.ts
  var $ = (id) => document.getElementById(id);
  var aiCrawlBtn = $("aiCrawl");
  var aiCrawlLabel = $("aiCrawlLabel");
  var statusBox = $("status");
  var crawledWrap = $("crawledWrap");
  var crawledList = $("crawledList");
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
  // Timeout mặc định cho request ngắn (ping); extract-page (AI + eBay) được
  // gọi với timeout dài hơn. Không có timeout thì server treo = spinner quay mãi.
  var API_TIMEOUT_MS = 15e3;
  var EXTRACT_TIMEOUT_MS = 12e4;
  async function api(path, init2 = {}, timeoutMs = API_TIMEOUT_MS) {
    let res;
    try {
      res = await fetch(`${settings.toolUrl}/api/${path}`, {
        ...init2,
        signal: AbortSignal.timeout(timeoutMs),
        headers: { ...init2.body ? { "Content-Type": "application/json" } : {}, Authorization: `Bearer ${settings.apiKey}` }
      });
    } catch (error) {
      if (error?.name === "TimeoutError" || error?.name === "AbortError") throw new ApiError("timeout");
      throw new ApiError("network");
    }
    if (!(res.headers.get("Content-Type") || "").includes("application/json")) throw new ApiError("access_blocked");
    let data;
    try {
      data = await res.json();
    } catch {
      throw new ApiError("server_error");
    }
    if (!res.ok) throw new ApiError(data?.error || "server_error");
    return data;
  }
  function errorText(error) {
    if (error instanceof ApiError) {
      if (error.code === "network") return "Kh\xF4ng k\u1EBFt n\u1ED1i \u0111\u01B0\u1EE3c tool. Ki\u1EC3m tra \u0111\u1ECBa ch\u1EC9 tool v\xE0 m\u1EA1ng.";
      if (error.code === "timeout") return "Tool ph\u1EA3n h\u1ED3i qu\xE1 l\xE2u (timeout). Ki\u1EC3m tra tool c\xF2n ch\u1EA1y r\u1ED3i th\u1EED l\u1EA1i; s\u1EA3n ph\u1EA9m c\xF3 th\u1EC3 \u0111\xE3 \u0111\u01B0\u1EE3c l\u01B0u, xem l\u1EA1i trong tool.";
      if (error.code === "access_blocked") return "Tool ch\u1EB7n extension \u1EDF b\u01B0\u1EDBc \u0111\u0103ng nh\u1EADp. Ng\u01B0\u1EDDi qu\u1EA3n tr\u1ECB c\u1EA7n m\u1EDF \u0111\u01B0\u1EDDng /api/ingest/* (xem README).";
      return ERROR_TEXT[error.code] ?? `L\u1ED7i t\u1EEB tool: ${error.code}`;
    }
    return error instanceof Error ? error.message : "C\xF3 l\u1ED7i x\u1EA3y ra.";
  }
  var lastConnectionError = null;
  async function checkConnection() {
    lastConnectionError = null;
    if (!settings.toolUrl || !settings.apiKey) {
      setConnection("none", "Ch\u01B0a c\u1EA5u h\xECnh \u0111\u1ECBa ch\u1EC9 tool v\xE0 kh\xF3a");
      return false;
    }
    try {
      const { name } = await api("ingest/ping");
      setConnection("ok", `\u0110\xE3 k\u1EBFt n\u1ED1i, kh\xF3a: ${name}`);
      return true;
    } catch (error) {
      lastConnectionError = error;
      setConnection("error", errorText(error));
      return false;
    }
  }
  // ---- Bảng bên cạnh (v1.4.0): theo dõi tab đang xem ----
  // Side panel không đóng khi đổi tab/đổi trang. Mỗi lần tab đổi thì cập
  // nhật tên trang, hiện lại kết quả đã crawl của trang đó (nếu có). Lượt
  // crawl đang chạy vẫn chạy tiếp dù đã chuyển sang trang khác.
  var currentTab = null;
  var crawlingUrl = null;
  var resultsByUrl = new Map();
  function hostOf(url) {
    try { return new URL(url).hostname; } catch { return ""; }
  }
  async function refreshActiveTab() {
    let tab = null;
    try {
      [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    } catch { /* bỏ qua */ }
    const changed = (tab?.url ?? null) !== (currentTab?.url ?? null) || tab?.id !== currentTab?.id;
    currentTab = tab ?? null;
    $("pageHost").textContent = hostOf(currentTab?.url) || "Trang \u0111ang m\u1EDF";
    if (changed) renderForCurrentTab();
  }
  function renderForCurrentTab() {
    if (crawlingUrl) {
      aiCrawlLabel.textContent = currentTab?.url === crawlingUrl ? aiCrawlLabel.textContent : `Đang crawl ${hostOf(crawlingUrl)}...`;
      return;
    }
    const saved = currentTab?.url ? resultsByUrl.get(currentTab.url) : null;
    if (saved) {
      const result = saved.result;
      showStatus(saved.text, saved.tone);
      if (result) renderCrawledList(result); else crawledWrap.hidden = true;
      openTool.hidden = !saved.openTool;
    } else {
      statusBox.hidden = true;
      crawledWrap.hidden = true;
      openTool.hidden = true;
    }
  }
  async function showPageHost() {
    await refreshActiveTab();
  }
  chrome.tabs.onActivated.addListener(() => { void refreshActiveTab(); });
  chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
    if (tabId === currentTab?.id && (changeInfo.url || changeInfo.status === "complete")) void refreshActiveTab();
  });
  chrome.windows?.onFocusChanged?.addListener(() => { void refreshActiveTab(); });
  // Quyền đọc trang theo từng website: bảng bên cạnh vẫn mở khi đổi tab nên
  // quyền activeTab (chỉ cấp cho tab lúc bấm icon) không đủ. Lần đầu crawl
  // một website, Chrome hỏi cho phép đọc site đó; các lần sau không hỏi nữa.
  async function ensureSiteAccess(url) {
    const origin = new URL(url).origin;
    const origins = [`${origin}/*`];
    if (await chrome.permissions.contains({ origins })) return;
    const granted = await chrome.permissions.request({ origins });
    if (!granted) throw new Error(`Cần cho phép extension đọc trang ${hostOf(url)} để crawl.`);
  }
  // ---- Danh sách "Đã cào được" (v9.3) ----
  // 1 danh sách gọn duy nhất sau khi crawl xong, thay cho các dòng trạng
  // thái rời rạc: tiêu đề, giá, ảnh, mô tả, chất liệu, kích thước, biến
  // thể, listing eBay khớp, đã bán (ước tính), người theo dõi, mã danh
  // mục. Trường nào chưa có thì ghi "chưa có", KHÔNG bịa.
  function crawledListItems(result) {
    const p = result.product ?? {};
    const ex = result.extracted ?? {};
    const enr = result.enrichment ?? null;
    // v9.7: giá hiển thị đúng tiền tệ trang gốc (Floria UK là £175, không
    // phải $175) — ký hiệu lấy từ currency của sản phẩm/biến thể, mặc định $.
    const CUR_SYM = { USD: '$', GBP: '£', EUR: '€', VND: '₫', JPY: '¥', CAD: 'C$', AUD: 'A$', NZD: 'NZ$', INR: '₹', KRW: '₩' };
    const money = (n, cur) => {
      if (n == null || Number.isNaN(Number(n))) return null;
      const c = String(cur ?? '').toUpperCase();
      const sym = CUR_SYM[c] ?? (c ? `${c} ` : '$');
      return `${sym}${Number(n).toFixed(2)}`;
    };
    const variants = p.variants ?? ex.variants ?? [];
    const currency = p.currency ?? ex.currency ?? variants[0]?.currency ?? 'USD';
    const desc = String(p.description ?? ex.description ?? '');
    const variantText = variants.length
      ? variants.slice(0, 5).map((v) => `${Object.values(v.options ?? {}).filter(Boolean).join(' / ') || '—'} — ${money(v.price, v.currency ?? currency) ?? '—'}${v.in_stock ? '' : ' (Hết)'}`).join('; ') + (variants.length > 5 ? ` … (+${variants.length - 5})` : '')
      : 'chưa có';
    const categoryId = (p.edits?.ebayCategoryId ?? '').toString().trim();
    return [
      { label: 'Tiêu đề', value: (p.title ?? ex.title ?? '').toString().trim() || 'chưa có' },
      { label: 'Giá', value: money(p.price ?? ex.price, currency) ?? 'chưa có' },
      { label: 'Ảnh', value: `${(p.images ?? ex.images ?? []).length} ảnh` },
      { label: 'Mô tả', value: desc.trim() ? `có — ${desc.trim().length} ký tự` : 'chưa có' },
      { label: 'Chất liệu', value: (p.specs?.Material ?? ex.material ?? null) ?? 'chưa có' },
      { label: 'Kích thước', value: (p.specs?.Dimensions ?? ex.dimensions ?? null) ?? 'chưa có' },
      // Đèn (v9.5, v9.7): loại bóng + công suất, chăm sóc — lấy từ specs đào
      // được ở panel "Details & Dimensions". Floria dùng nhãn 'Bulb
      // required' / 'Bulb style' thay cho 'Bulb type' nên gộp cả 3 nhãn
      // (trùng nhau thì chỉ giữ 1 lần); chưa có thì "chưa có", không bịa.
      { label: 'Bóng đèn', value: (() => { const get = (k) => p.specs?.[k] ?? ex.specs?.[k] ?? null; const parts = [...new Set(['Bulb required', 'Bulb type', 'Bulb style'].map(get).filter(Boolean))]; const w = get('Wattage'); if (w && !parts.includes(w)) parts.push(w); return parts.length ? parts.join(' — ') : 'chưa có'; })() },
      { label: 'Chăm sóc', value: (p.specs?.['Care instructions'] ?? ex.specs?.['Care instructions'] ?? null) ?? 'chưa có' },
      { label: 'Biến thể', value: variantText },
      { label: 'Listing eBay khớp', value: enr?.matched ? (enr.itemTitle ?? '—') : 'chưa có', url: enr?.matched ? (p.ebayItemUrl ?? null) : null },
      { label: 'Đã bán (eBay)', value: enr?.matched && enr.sold != null ? `~${enr.sold} (ước tính)` : 'chưa có' },
      { label: 'Người theo dõi', value: enr?.matched && enr.watchers != null ? String(enr.watchers) : 'chưa có' },
      { label: 'Mã danh mục', value: categoryId ? `${categoryId}${(p.edits?.ebayCategoryName ?? '').toString().trim() ? ` — ${p.edits.ebayCategoryName}` : ''} (tự áp từ eBay)` : 'chưa có' },
    ];
  }
  function renderCrawledList(result) {
    crawledList.innerHTML = '';
    for (const it of crawledListItems(result)) {
      const li = document.createElement('li');
      const strong = document.createElement('strong');
      strong.textContent = `${it.label}: `;
      li.appendChild(strong);
      if (it.url && /^https?:\/\//i.test(String(it.url))) {
        const a = document.createElement('a');
        a.href = it.url;
        a.target = '_blank';
        a.rel = 'noopener';
        a.textContent = it.value;
        li.appendChild(a);
      } else {
        li.appendChild(document.createTextNode(it.value));
      }
      crawledList.appendChild(li);
    }
    crawledWrap.hidden = false;
  }

  // ---- Crawl AI 1 trang (v9) ----
  // Doc du lieu tho cua trang (JSON-LD + bien the + text hien thi) roi
  // gui ve POST /api/ingest/extract-page bang khoa crawl de trich xuat.
  // Chua cau hinh tool thi giu ban copy local: luu du lieu trang
  // tho vao chrome.storage.local, cau hinh xong bam lai.
  // Trả về { text, tone, result, openTool } để bảng bên cạnh hiện lại đúng
  // kết quả khi người dùng quay về trang này sau khi đã chuyển tab.
  async function aiCrawl(tab) {
    if (!tab?.id || !tab.url || !/^https?:/.test(tab.url)) throw new Error("Hãy mở trang chi tiết sản phẩm rồi bấm lại.");
    await ensureSiteAccess(tab.url);
    aiCrawlLabel.textContent = "Đang đọc trang...";
    let read;
    try {
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["dist/content.js"] });
      read = await chrome.tabs.sendMessage(tab.id, { type: "EXTRACT_AI_PAGE" });
    } catch {
      // Chrome báo lỗi tiếng Anh ("Cannot access contents of the page",
      // "Receiving end does not exist") với trang hệ thống/Web Store/PDF.
      throw new Error("Extension không đọc được trang này (trang hệ thống, Chrome Web Store, PDF hoặc trang chưa tải xong). Tải lại trang sản phẩm rồi bấm lại.");
    }
    if (!read?.ok || !read.page) throw new Error(read?.error || "Không đọc được trang này.");
    const page = read.page;
    if (!settings.toolUrl || !settings.apiKey) {
      const stored = await chrome.storage.local.get(["aiPagePending"]);
      const pending = (Array.isArray(stored.aiPagePending) ? stored.aiPagePending : []).filter((p) => p?.url !== page.url);
      pending.push({ ...page, savedAt: new Date().toISOString() });
      const kept = pending.slice(-MAX_PENDING_PAGES);
      await chrome.storage.local.set({ aiPagePending: kept });
      return {
        text: `Chưa cấu hình tool nên chưa AI trích xuất được — đã lưu bản local của "${page.title ?? page.url}" (${kept.length} trang chờ). Nhập địa chỉ tool + khóa crawl rồi bấm Lưu: các trang chờ sẽ tự gửi vào tool.`,
        tone: "info", result: { product: page, enrichment: null }, openTool: false,
      };
    }
    aiCrawlLabel.textContent = "Đang nhờ AI trích xuất...";
    const result = await api("ingest/extract-page", { method: "POST", body: JSON.stringify({ url: page.url, sourceSite: page.sourceSite, sourceProductId: page.sourceProductId, raw: page }) }, EXTRACT_TIMEOUT_MS);
    const ex = result.extracted ?? {};
    const warnings = (result.warnings ?? []).filter(Boolean);
    // v9.1: web tự tìm listing eBay khớp ngay sau khi lưu sản phẩm (Browse
    // API) — hiện luôn listing đã khớp + số đã bán (ước tính) + số người
    // theo dõi, không cần dán link hay dán số gì thêm.
    const enr = result.enrichment ?? null;
    let enrichText = "";
    if (enr?.matched) {
      enrichText = ` eBay: "${enr.itemTitle ?? ""}" — đã bán ~${enr.sold ?? "—"}, ${enr.watchers ?? "—"} người theo dõi (khớp ${Number(enr.score ?? 0).toFixed(2)}).`;
    } else if (enr?.warning) {
      enrichText = ` eBay: ${enr.warning}`;
    }
    return {
      text: `Đã cào xong "${ex.title ?? page.title ?? ""}" — xem danh sách bên dưới.${result.provider === "rule-based" ? " (dùng dữ liệu đọc trực tiếp; xem lý do ở phần lưu ý)" : ""}${warnings.length ? ` Lưu ý: ${warnings.slice(0, 3).join(" | ")}` : ""}${enrichText}`,
      tone: warnings.length || !enr?.matched ? "info" : "ok", result, openTool: true,
    };
  }
  aiCrawlBtn.addEventListener("click", async () => {
    if (aiCrawlBtn.disabled) return;
    const tab = currentTab;
    aiCrawlBtn.disabled = true;
    aiCrawlBtn.classList.add("loading");
    statusBox.hidden = true;
    crawledWrap.hidden = true;
    openTool.hidden = true;
    crawlingUrl = tab?.url ?? null;
    let outcome;
    try {
      outcome = await aiCrawl(tab);
    } catch (error) {
      outcome = { text: errorText(error), tone: "error", result: null, openTool: false };
    } finally {
      crawlingUrl = null;
      aiCrawlBtn.disabled = false;
      aiCrawlBtn.classList.remove("loading");
      aiCrawlLabel.textContent = "Crawl AI trang này";
    }
    if (tab?.url) resultsByUrl.set(tab.url, outcome);
    if (resultsByUrl.size > 30) resultsByUrl.delete(resultsByUrl.keys().next().value);
    openTool.href = settings.toolUrl;
    if (currentTab?.url === tab?.url) {
      renderForCurrentTab();
    } else {
      // Đã chuyển sang trang khác trong lúc crawl: báo kết quả, không đè trang mới.
      showStatus(`${outcome.tone === "error" ? "Crawl trang trước lỗi" : "Đã crawl xong trang trước"} (${hostOf(tab?.url)}): ${outcome.text} Quay lại tab đó để xem chi tiết.`, outcome.tone);
      crawledWrap.hidden = true;
    }
  });

  // v9.1: card "Lấy số đã bán trên eBay" (dán link tay) đã BỎ — web tự tìm
  // listing eBay khớp qua Browse API ngay sau "Crawl AI trang này" rồi
  // hiện số đã bán + người theo dõi trong popup (xem aiCrawl ở trên).
  // content.js vẫn giữ EXTRACT_EBAY_SOLD làm dự phòng khi Browse API không
  // trả số đã bán cho listing đó (đọc "X sold" công khai trên trang eBay).
  // Tối đa 20 trang chờ: mỗi trang kèm ~12.000 ký tự text + JSON-LD, giữ
  // chrome.storage.local (giới hạn 10MB) gọn.
  var MAX_PENDING_PAGES = 20;
  // Gửi các trang đã lưu local (lúc chưa cấu hình tool) vào tool sau khi kết
  // nối thành công. Trang gửi lỗi được giữ lại để lần sau gửi tiếp.
  async function flushPendingPages() {
    const stored = await chrome.storage.local.get(["aiPagePending"]);
    const pending = Array.isArray(stored.aiPagePending) ? stored.aiPagePending : [];
    if (!pending.length) return;
    const failed = [];
    let sent = 0;
    for (const page of pending) {
      showStatus(`Đang gửi trang đã lưu ${sent + failed.length + 1}/${pending.length}: "${page.title ?? page.url}"...`, "info");
      try {
        await api("ingest/extract-page", { method: "POST", body: JSON.stringify({ url: page.url, sourceSite: page.sourceSite, sourceProductId: page.sourceProductId, raw: page }) }, EXTRACT_TIMEOUT_MS);
        sent++;
      } catch (error) {
        failed.push(page);
        if (error instanceof ApiError && ["network", "timeout", "invalid_api_key", "access_blocked"].includes(error.code)) {
          failed.push(...pending.slice(pending.indexOf(page) + 1));
          break;
        }
      }
    }
    await chrome.storage.local.set({ aiPagePending: failed });
    showStatus(failed.length
      ? `Đã gửi ${sent}/${pending.length} trang đã lưu vào tool; còn ${failed.length} trang chờ (sẽ gửi lại lần sau khi bấm Lưu).`
      : `Đã gửi ${sent} trang đã lưu vào tool.`, failed.length ? "info" : "ok");
  }
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
    saveBtn.disabled = true;
    saveBtn.classList.add("loading");
    const previous = settings;
    try {
      const granted = await chrome.permissions.request({ origins: [`${toolUrl}/*`] });
      if (!granted) return fail(toolUrlInput, "C\u1EA7n cho ph\xE9p extension g\u1EEDi d\u1EEF li\u1EC7u t\u1EDBi \u0111\u1ECBa ch\u1EC9 tool n\xE0y.");
      settings = { toolUrl, apiKey };
      toolUrlInput.value = toolUrl;
      const ok = await checkConnection();
      if (!ok) {
        // Chỉ lưu cấu hình đã kiểm tra được; lỗi mạng/timeout là do địa chỉ tool.
        settings = previous;
        const code = lastConnectionError instanceof ApiError ? lastConnectionError.code : null;
        const field = code === "network" || code === "timeout" || code === "access_blocked" ? toolUrlInput : apiKeyInput;
        return fail(field, connectionText.textContent || "Kh\xF4ng k\u1EBFt n\u1ED1i \u0111\u01B0\u1EE3c.");
      }
      await chrome.storage.local.set(settings);
      toggleSettings(false);
      await flushPendingPages();
    } catch (error) {
      fail(toolUrlInput, errorText(error));
    } finally {
      saveBtn.disabled = false;
      saveBtn.classList.remove("loading");
    }
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
