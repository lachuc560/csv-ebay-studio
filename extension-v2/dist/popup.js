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
      if (it.url) {
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
  async function aiCrawl() {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id || !tab.url || !/^https?:/.test(tab.url)) throw new Error("Hãy mở trang chi tiết sản phẩm rồi bấm lại.");
    aiCrawlLabel.textContent = "Đang đọc trang...";
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["dist/content.js"] });
    const read = await chrome.tabs.sendMessage(tab.id, { type: "EXTRACT_AI_PAGE" });
    if (!read?.ok || !read.page) throw new Error(read?.error || "Không đọc được trang này.");
    const page = read.page;
    if (!settings.toolUrl || !settings.apiKey) {
      const stored = await chrome.storage.local.get(["aiPagePending"]);
      const pending = Array.isArray(stored.aiPagePending) ? stored.aiPagePending : [];
      pending.push({ ...page, savedAt: new Date().toISOString() });
      await chrome.storage.local.set({ aiPagePending: pending.slice(-50) });
      showStatus(`Chưa cấu hình tool nên chưa AI trích xuất được — đã lưu bản local của "${page.title ?? page.url}" (${pending.length} trang chờ). Nhập địa chỉ tool + khóa crawl rồi bấm "Crawl AI trang này" lại.`, "info");
      renderCrawledList({ product: page, enrichment: null });
      openTool.hidden = true;
      return;
    }
    aiCrawlLabel.textContent = "Đang nhờ AI trích xuất...";
    const result = await api("ingest/extract-page", { method: "POST", body: JSON.stringify({ url: page.url, sourceSite: page.sourceSite, sourceProductId: page.sourceProductId, raw: page }) });
    const ex = result.extracted ?? {};
    const warnings = (result.warnings ?? []).filter(Boolean);
    // v9.1: web tự tìm listing eBay khớp ngay sau khi lưu sản phẩm (Browse
    // API) — hiện luôn listing đã khớp + số đã bán (ước tính) + số người
    // theo dõi trong popup, không cần dán link hay dán số gì thêm.
    const enr = result.enrichment ?? null;
    let enrichText = "";
    if (enr?.matched) {
      enrichText = ` eBay: "${enr.itemTitle ?? ""}" — đã bán ~${enr.sold ?? "—"}, ${enr.watchers ?? "—"} người theo dõi (khớp ${Number(enr.score ?? 0).toFixed(2)}).`;
    } else if (enr?.warning) {
      enrichText = ` eBay: ${enr.warning}`;
    }
    renderCrawledList(result);
    showStatus(`Đã cào xong "${ex.title ?? page.title ?? ""}" — xem danh sách bên dưới.${result.provider === "rule-based" ? " (dùng dữ liệu đọc trực tiếp; xem lý do ở phần lưu ý)" : ""}${warnings.length ? ` Lưu ý: ${warnings.slice(0, 3).join(" | ")}` : ""}${enrichText}`, warnings.length || !enr?.matched ? "info" : "ok");
    openTool.href = settings.toolUrl;
    openTool.hidden = false;
  }
  aiCrawlBtn.addEventListener("click", async () => {
    if (aiCrawlBtn.disabled) return;
    aiCrawlBtn.disabled = true;
    aiCrawlBtn.classList.add("loading");
    statusBox.hidden = true;
    crawledWrap.hidden = true;
    openTool.hidden = true;
    try {
      await aiCrawl();
    } catch (error) {
      showStatus(errorText(error), "error");
    } finally {
      aiCrawlBtn.disabled = false;
      aiCrawlBtn.classList.remove("loading");
      aiCrawlLabel.textContent = "Crawl AI trang này";
    }
  });

  // v9.1: card "Lấy số đã bán trên eBay" (dán link tay) đã BỎ — web tự tìm
  // listing eBay khớp qua Browse API ngay sau "Crawl AI trang này" rồi
  // hiện số đã bán + người theo dõi trong popup (xem aiCrawl ở trên).
  // content.js vẫn giữ EXTRACT_EBAY_SOLD làm dự phòng khi Browse API không
  // trả số đã bán cho listing đó (đọc "X sold" công khai trên trang eBay).
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
