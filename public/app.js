// public/app.js — WEB THAM CHIẾU tối thiểu cho CSV Listing eBay.
// ES module, dùng luật dùng chung trong ./core.js (buildCsv, optionNamesFor...).
// Chỉ gọi các endpoint đã định: /api/bootstrap, /api/products, /api/config,
// /api/keys, /api/ingest/*, /api/ai/suggest, /api/ai/group,
// /api/ai/draft-categories, /api/ai/extract-page, /api/ebay/status,
// /api/ebay/config, /api/ebay/check, /api/ebay/category-suggestions,
// /api/ebay/resolve-groups, /api/ebay/enrich, /api/ebay/enrich-all.
// Không framework.
// Lưu ý: shape response dưới đây được viết phòng thủ: chấp nhận cả dạng
// { products: [...] } lẫn [...] và cả { config: {...} } lẫn {...}.
// Contract chính xác nằm trong server/api.mjs — đã đối chiếu ngày 13/11/2026
// (bootstrap trả { products, config, crawlErrors, keys }; keys dùng
// createdAt/lastUsedAt camelCase; ai/suggest nhận { productId }).

import { buildCsv, optionNamesFor, applyEdits, calcSellPrice, groupProductsByTheme, groupProductsByAiAssignments, buildGroupedEbayCsvs, buildDraftGroupedCsvs, parseEbayTemplate, buildEbayTemplateCsv, buildResearchGroupedCsvs, parseEbayItemId, parseEbayWatchers, autoApplyEbayResolutions, crawledSummaryItems } from './core.js';
import { parseCsvText, templateColumnIndex } from './core.js';
import { sellerExportConfig } from './export-settings.js';

const $ = (id) => document.getElementById(id);
const statusEl = $('status');

const state = {
  products: [],
  config: { markupPct: 0.35, ebayFeePct: 0.13, shippingCost: 0, taxPct: 0 },
  template: null,
  templateName: '',
  aiStatus: null,
  aiSuggestions: new Map(), // productId -> {suggestion, warnings, provider}
  ebayStatus: null,
  lastAiGroups: null, // nhóm từ lần AI phân loại gần nhất (để tra mã eBay)
  lastAiAssignments: null, // assignments của lần AI phân loại gần nhất
  lastAiFiles: null, // file CSV upload được của lần AI phân loại gần nhất
  lastAiGrouped: null, // kết quả POST /api/ai/group gần nhất (provider/warnings)
};

function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function money(n) {
  return n == null || Number.isNaN(Number(n)) ? '—' : `$${Number(n).toFixed(2)}`;
}
function setStatus(text, kind = '') {
  statusEl.textContent = text;
  statusEl.className = kind === 'error' ? 'error' : kind === 'ok' ? 'ok' : 'muted';
}
async function api(path, init = {}) {
  const res = await fetch(path, { ...init, headers: { 'Content-Type': 'application/json', ...(init.headers || {}) } });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error || data.message || `HTTP ${res.status}`);
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}
const asArray = (v) => (Array.isArray(v) ? v : []);

// ---- Tabs ---------------------------------------------------------------
document.querySelectorAll('nav button[data-tab]').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('nav button[data-tab]').forEach((b) => b.setAttribute('aria-selected', String(b === btn)));
    document.querySelectorAll('main > section').forEach((s) => { s.hidden = s.id !== `tab-${btn.dataset.tab}`; });
    if (btn.dataset.tab === 'keys') loadKeys();
  });
});

// ---- Bootstrap: GET /api/bootstrap --------------------------------------
async function loadBootstrap() {
  try {
    const data = await api('/api/bootstrap');
    const products = asArray(data.products ?? data);
    const config = data.config ?? data;
    state.products = products;
    state.config = {
      ...config,
      markupPct: Number(config.markupPct ?? 0.35),
      ebayFeePct: Number(config.ebayFeePct ?? 0.13),
      shippingCost: Number(config.shippingCost ?? 0),
      taxPct: Number(config.taxPct ?? 0),
    };
    fillConfigForm();
    renderBrowse();
    renderGroupList();
    $('exportCount').textContent = `${products.length} sản phẩm, ${products.reduce((n, p) => n + (p.variants ?? []).filter((v) => v.in_stock).length, 0)} biến thể còn hàng.`;
    setStatus(`Đã tải ${products.length} sản phẩm.`, 'ok');
  } catch (e) {
    setStatus(`Không tải được /api/bootstrap: ${e.message}`, 'error');
  }
}

// ---- Tab Duyệt ----------------------------------------------------------
// Cột biến thể động theo option_names hợp nhất — PHẢI hiện tuỳ chọn thứ ba
// (Height / Size Type / ...) chứ không chỉ Size + Color.
function allOptionNames() {
  const names = [];
  for (const p of state.products) {
    for (const n of p.option_names ?? optionNamesFor(p.variants ?? [])) if (!names.includes(n)) names.push(n);
  }
  return names;
}
function variantOptionSummary(p) {
  const names = p.option_names ?? optionNamesFor(p.variants ?? []);
  return names.map((n) => {
    const values = [...new Set((p.variants ?? []).map((v) => v.options?.[n]).filter(Boolean))];
    return values.length ? `${n}: ${values.join(', ')}` : null;
  }).filter(Boolean).join(' · ');
}
function renderBrowse() {
  const names = allOptionNames();
  const rows = state.products.map((p) => {
    const inStock = (p.variants ?? []).filter((v) => v.in_stock).length;
    const sell = calcSellPrice(p.price, state.config);
    return `<tr data-id="${esc(p.id)}">
      <td>${esc(p.title)}${p.price_estimated ? ' <span title="Giá ước tính">~</span>' : ''}${p.truncated ? ' <span title="Crawl bị cắt, chưa đủ biến thể">[cắt]</span>' : ''}</td>
      <td>${esc(p.source_site)}</td>
      <td>${money(p.price)}${sell != null ? `<br><span class="muted">bán ${money(sell)}</span>` : ''}</td>
      <td>${inStock}/${p.variant_count ?? (p.variants ?? []).length}</td>
      <td>${p.ebaySold != null ? esc(p.ebaySold) : '—'}</td>
      <td>${p.ebayWatchers != null ? esc(p.ebayWatchers) : '—'}</td>
      <td>${p.ebayItemUrl ? `<a href="${esc(p.ebayItemUrl)}" target="_blank" rel="noopener">${esc(p.ebayItemTitle ?? p.ebayItemId ?? '')}</a>${p.ebayMatchScore != null ? ` (${Number(p.ebayMatchScore).toFixed(2)})` : ''}` : '—'}</td>
      ${names.map((n) => `<td>${esc([...new Set((p.variants ?? []).map((v) => v.options?.[n]).filter(Boolean))].join(', '))}</td>`).join('')}
    </tr>`;
  }).join('');
  $('browseTable').innerHTML = `<thead><tr><th>Tiêu đề</th><th>Site</th><th>Giá nguồn / Giá bán</th><th>Còn hàng / Tổng biến thể</th><th>Đã bán (eBay)</th><th>Người theo dõi</th><th>Listing eBay khớp</th>${names.map((n) => `<th>${esc(n)}</th>`).join('')}</tr></thead><tbody>${rows || '<tr><td colspan="99">Chưa có sản phẩm nào.</td></tr>'}</tbody>`;
  $('count').textContent = `${state.products.length} sản phẩm`;
  $('browseTable').querySelectorAll('tr[data-id]').forEach((tr) => tr.addEventListener('click', () => showDetail(tr.dataset.id)));
}

function showDetail(id) {
  const p = state.products.find((x) => x.id === id);
  if (!p) return;
  const eff = applyEdits(p, state.config);
  const names = p.option_names ?? optionNamesFor(p.variants ?? []);
  const variantRows = (p.variants ?? []).map((v, i) => `<tr>
    <td>${i + 1}</td>
    ${names.map((n) => `<td>${esc(v.options?.[n] ?? '')}</td>`).join('')}
    <td>${money(v.price)}</td><td>${money(v.compare_at_price)}</td>
    <td>${v.in_stock ? 'Còn' : 'Hết'}</td>
    <td>${esc(v.sku ?? '')}</td><td>${esc(v.upc ?? '')}</td>
    <td>${esc(v.image ?? '')}</td>
  </tr>`).join('');
  $('detail').hidden = false;
  // Danh sách "Đã cào được" (v9.3): 1 danh sách gọn duy nhất liệt kê đã
  // cào được những thông tin gì — trường nào chưa có thì ghi "chưa có",
  // không bịa.
  const summaryHtml = `<h4>Đã cào được</h4><ul>${crawledSummaryItems(p, state.config).map((it) => `<li><strong>${esc(it.label)}:</strong> ${it.url ? `<a href="${esc(it.url)}" target="_blank" rel="noopener">${esc(it.value)}</a>` : esc(it.value)}</li>`).join('')}</ul>`;
  $('detail').innerHTML = `
    <h3>${esc(p.title)}</h3>
    ${summaryHtml}
    <p class="muted">${esc(p.source_site)} · <a href="${esc(p.source_url ?? '')}" target="_blank" rel="noopener">${esc(p.source_url ?? '')}</a></p>
    <p><strong>Giá nguồn:</strong> ${money(p.price)} ${esc(p.currency ?? '')} ·
    <strong>Giá bán gợi ý:</strong> ${money(eff.sell_price)} ·
    <strong>Giá ước tính:</strong> ${p.price_estimated ? 'Có — kiểm lại trước khi xuất' : 'Không'} ·
    <strong>Crawl bị cắt:</strong> ${p.truncated ? 'Có — chưa đủ biến thể' : 'Không'}</p>
    <p><strong>Thương hiệu:</strong> ${esc(p.brand ?? '—')} · <strong>Danh mục:</strong> ${esc(p.category ?? p.suggested_category ?? '—')}
    (gợi ý: ${esc(p.suggested_category ?? '—')}) · <strong>Department:</strong> ${esc(p.department ?? '—')} ·
    <strong>Breadcrumb:</strong> ${esc((p.breadcrumb ?? []).join(' › '))} · <strong>UPC:</strong> ${esc(p.upc ?? '—')}</p>
    <p><strong>Tuỳ chọn:</strong> ${esc(names.join(', ') || '—')} (${esc(variantOptionSummary(p) || '—')})</p>
    <p><strong>Thuộc tính:</strong> ${esc(Object.entries(p.attributes ?? {}).filter(([, v]) => v).map(([k, v]) => `${k}=${v}`).join('; ') || '—')}</p>
    <p><strong>Mô tả:</strong> ${esc(p.description ?? '—')}</p>
    <p class="muted">Ảnh: ${(p.images ?? []).length} · Biến thể: ${p.variant_count ?? (p.variants ?? []).length} (còn hàng ${p.in_stock_count ?? (p.variants ?? []).filter((v) => v.in_stock).length}) · Version: ${p.version ?? 1} · Crawl: ${esc(p.crawled_at ?? '')}</p>
    <table><thead><tr><th>#</th>${names.map((n) => `<th>${esc(n)}</th>`).join('')}<th>Giá</th><th>Giá gốc</th><th>Tồn</th><th>SKU</th><th>UPC</th><th>Ảnh variant</th></tr></thead><tbody>${variantRows || '<tr><td colspan="99">Không có biến thể.</td></tr>'}</tbody></table>
    <form id="editForm">
      <h4>Sửa (team)</h4>
      <label for="editTitle">Tiêu đề</label>
      <input id="editTitle" name="title" type="text" value="${esc(p.edits?.title ?? p.title)}" />
      <label for="editCategory">Danh mục eBay</label>
      <input id="editCategory" name="category" type="text" value="${esc(p.edits?.category ?? p.category ?? '')}" placeholder="${esc(p.suggested_category ?? '')}" />
      <label for="editPrice">Giá bán chốt (để trống = tính theo cấu hình giá)</label>
      <input id="editPrice" name="price" type="number" step="0.01" min="0" value="${esc(p.edits?.price ?? '')}" />
      <button type="submit">Lưu sửa đổi</button>
      <button type="button" id="aiSuggestBtn">Gợi ý AI (tiêu đề/danh mục)</button>
    </form>
    <p id="editMsg" role="status"></p>
    <div id="aiSuggestBox"></div>
    <form id="ebayForm">
      <h4>Số liệu eBay (tham khảo — không vào file CSV upload)</h4>
      <p class="muted">Đã bán: ${p.ebaySold != null ? `${esc(p.ebaySold)} (ước tính theo eBay, tổng cả listing)` : 'chưa có — tool tự tìm listing khớp sau khi crawl AI, hoặc bấm "Tìm lại" bên dưới'} · Người theo dõi: ${p.ebayWatchers != null ? esc(p.ebayWatchers) : '—'} · Listing khớp: ${p.ebayItemUrl ? `<a href="${esc(p.ebayItemUrl)}" target="_blank" rel="noopener">${esc(p.ebayItemTitle ?? p.ebayItemId ?? '')}</a>${p.ebayMatchScore != null ? ` (khớp ${Number(p.ebayMatchScore).toFixed(2)})` : ''}` : 'chưa khớp'}</p>
      <label for="ebayLink">Link listing eBay (tùy chọn — chỉ điền khi muốn sửa listing đã khớp tự động)</label>
      <input id="ebayLink" name="ebayLink" type="text" value="${esc(p.ebayItemId ?? '')}" placeholder="https://www.ebay.com/itm/... hoặc 123456789012" />
      <label for="ebayWatchers">Số người theo dõi (sửa tay khi cần)</label>
      <input id="ebayWatchers" name="ebayWatchers" type="number" step="1" min="0" value="${esc(p.ebayWatchers ?? '')}" />
      <p class="muted">Tool tự tìm listing eBay khớp qua Browse API (số đã bán là ước tính của eBay, tổng cả listing, không chia màu/size). Không cần dán gì thêm — form này chỉ để sửa khi khớp sai.</p>
      <button type="submit">Lưu số liệu eBay</button>
      <button type="button" id="ebayRefindBtn">Tìm lại</button>
    </form>
    <p id="ebayMsg" role="status"></p>`;
  $('detail').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  $('editForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const edits = {};
    if (fd.get('title')?.trim()) edits.title = fd.get('title').trim();
    if (fd.get('category')?.trim()) edits.category = fd.get('category').trim();
    if (fd.get('price') !== '' && fd.get('price') != null) edits.price = Number(fd.get('price'));
    try {
      // PUT /api/products/:id — version để chống ghi đè (server trả 409 khi lệch).
      const updated = await api(`/api/products/${encodeURIComponent(p.id)}`, {
        method: 'PUT',
        body: JSON.stringify({ edits, version: p.version ?? 1 }),
      });
      const fresh = updated.product ?? updated;
      Object.assign(p, fresh);
      $('editMsg').textContent = 'Đã lưu sửa đổi.';
      $('editMsg').className = 'ok';
      renderBrowse();
    } catch (err) {
      $('editMsg').textContent = err.status === 409
        ? 'Sản phẩm đã bị người khác sửa (version lệch, HTTP 409). Tải lại trang rồi sửa lại.'
        : `Không lưu được: ${err.message}`;
      $('editMsg').className = 'error';
    }
  });
  $('aiSuggestBtn').addEventListener('click', async () => {
    const msg = $('editMsg');
    const box = $('aiSuggestBox');
    msg.textContent = 'Đang gọi AI…';
    msg.className = '';
    box.innerHTML = '';
    try {
      // POST /api/ai/suggest nhận { productId } (hoặc { product }) và trả
      // { ok, suggestion: { title, category, ebayType, specifics }, warnings, provider }.
      // Gợi ý CHỈ HIỆN để duyệt — không tự điền vào form, không tự lưu.
      const result = await api('/api/ai/suggest', { method: 'POST', body: JSON.stringify({ productId: p.id }) });
      state.aiSuggestions.set(p.id, result);
      renderAiSuggestionBox(p, result);
      msg.textContent = result.provider === 'rule-based'
        ? 'Đã có gợi ý theo luật (chưa có key AI — xem tab "AI gợi ý" để cấu hình key). Kiểm lại rồi bấm Áp dụng.'
        : `Đã có gợi ý từ AI (${result.provider}). Kiểm lại rồi bấm Áp dụng.`;
      msg.className = 'ok';
    } catch (err) {
      msg.textContent = `Không gọi được AI: ${err.message}`;
      msg.className = 'error';
    }
  });
  // Lưu số liệu eBay (v9.1): form này chỉ là tuỳ chọn nâng cao để sửa khi
  // khớp tự động sai. Có dán link/mã item thì gọi POST /api/ebay/enrich để
  // server lấy thẳng chi tiết listing đó qua Browse API (getItemByLegacyId
  // getItem) — không cần seller dán số. Không dán link thì chỉ lưu số người
  // theo dõi sửa tay (nếu có).
  $('ebayForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const link = String(fd.get('ebayLink') ?? '').trim();
    const watchersRaw = fd.get('ebayWatchers');
    const msg = $('ebayMsg');
    const ebayItemId = link ? parseEbayItemId(link) : null;
    const ebayWatchers = parseEbayWatchers(watchersRaw);
    if (link && !ebayItemId) {
      msg.textContent = 'Link eBay không nhận ra mã item — dán link dạng https://www.ebay.com/itm/... hoặc mã số item (9 số trở lên).';
      msg.className = 'error';
      return;
    }
    if (watchersRaw !== '' && watchersRaw != null && ebayWatchers == null) {
      msg.textContent = 'Số người theo dõi phải là số nguyên >= 0.';
      msg.className = 'error';
      return;
    }
    try {
      if (ebayItemId) {
        // Seller chỉ định thẳng 1 listing: server lấy chi tiết qua Browse API.
        const result = await api('/api/ebay/enrich', { method: 'POST', body: JSON.stringify({ productId: p.id, ebayItemId }) });
        Object.assign(p, result.product ?? result);
        msg.textContent = result.enrichment?.matched
          ? `Đã khớp listing "${result.enrichment.itemTitle ?? ebayItemId}" — đã bán ~${result.enrichment.sold ?? '—'}, ${result.enrichment.watchers ?? '—'} người theo dõi.`
          : `Không lấy được chi tiết listing này: ${result.enrichment?.warning ?? 'lỗi không rõ'}`;
        msg.className = result.enrichment?.matched ? 'ok' : 'error';
      } else {
        // Chỉ sửa tay số người theo dõi.
        const updated = await api(`/api/products/${encodeURIComponent(p.id)}`, {
          method: 'PUT',
          body: JSON.stringify({ ebayWatchers, ebayWatchersSource: ebayWatchers != null ? 'nhập tay (seller sửa)' : null, version: p.version ?? 1 }),
        });
        Object.assign(p, updated.product ?? updated);
        msg.textContent = 'Đã lưu số liệu eBay.';
        msg.className = 'ok';
      }
      renderBrowse();
      showDetail(p.id);
    } catch (err) {
      msg.textContent = err.status === 409
        ? 'Sản phẩm đã bị người khác sửa (version lệch, HTTP 409). Tải lại trang rồi sửa lại.'
        : `Không lưu được: ${err.message}`;
      msg.className = 'error';
    }
  });
  // "Tìm lại" (v9.1): chạy lại search + getItem cho sản phẩm này, không cần gõ gì.
  $('ebayRefindBtn').addEventListener('click', async () => {
    const msg = $('ebayMsg');
    msg.textContent = 'Đang tìm listing eBay khớp…';
    msg.className = '';
    try {
      const result = await api('/api/ebay/enrich', { method: 'POST', body: JSON.stringify({ productId: p.id }) });
      Object.assign(p, result.product ?? result);
      const enr = result.enrichment ?? {};
      msg.textContent = enr.matched
        ? `Đã khớp "${enr.itemTitle ?? ''}" — đã bán ~${enr.sold ?? '—'}, ${enr.watchers ?? '—'} người theo dõi (khớp ${Number(enr.score ?? 0).toFixed(2)}).`
        : (enr.warning ?? 'Không tìm thấy listing eBay khớp.');
      msg.className = enr.matched ? 'ok' : 'error';
      renderBrowse();
      showDetail(p.id);
    } catch (err) {
      msg.textContent = `Không tìm được: ${err.message}`;
      msg.className = 'error';
    }
  });
}

// ---- AI gợi ý: panel duyệt (Áp dụng / Bỏ qua) ----------------------------
// Áp dụng = ghi vào edits qua PUT /api/products/:id (kèm version check 409).
// Title -> edits.title, Type eBay -> edits.ebayType, specifics -> edits.aiSpecifics
// (buildEbayTemplateCsv ưu tiên dùng các giá trị này khi xuất).
// Category chỉ áp khi sản phẩm chưa có category chốt — không ghi đè quyết
// định của team bằng gợi ý. Giá bán KHÔNG bao giờ lấy từ AI.
function aiSuggestionHtml(result) {
  const s = result.suggestion ?? {};
  const specifics = Object.entries(s.specifics ?? {}).map(([k, v]) => `${k}=${v}`).join('; ') || '—';
  const warnings = asArray(result.warnings);
  const providerLabel = result.provider === 'rule-based'
    ? 'rule-based — chưa có key AI, gợi ý theo luật'
    : `LLM ${result.provider ?? ''}`;
  return `<h4>Gợi ý AI <span class="muted">(${esc(providerLabel)})</span></h4>
    <p><strong>Title:</strong> ${esc(s.title ?? '—')}</p>
    <p><strong>Type eBay (20563):</strong> ${esc(s.ebayType ?? '— (để trống, team tự điền)')}</p>
    <p><strong>Danh mục:</strong> ${esc(s.category ?? '—')}</p>
    <p><strong>Item specifics:</strong> ${esc(specifics)}</p>
    ${warnings.length ? `<p class="error">Lưu ý: ${esc(warnings.join('; '))}</p>` : ''}
    <button type="button" id="aiApplyBtn">Áp dụng</button>
    <button type="button" id="aiSkipBtn">Bỏ qua</button>`;
}

function renderAiSuggestionBox(p, result) {
  const box = $('aiSuggestBox');
  if (!box) return;
  box.innerHTML = aiSuggestionHtml(result);
  $('aiApplyBtn').addEventListener('click', async () => {
    const msg = $('editMsg');
    try {
      const applied = await applyAiSuggestion(p, result.suggestion ?? {});
      if (!applied) {
        msg.textContent = 'Không có gì mới để áp — gợi ý trùng với dữ liệu hiện tại.';
        msg.className = '';
      } else {
        showDetail(p.id);
        $('editMsg').textContent = 'Đã áp dụng gợi ý AI (title / Type / item specifics) — kiểm lại trong form rồi bấm Lưu sửa đổi nếu cần chỉnh thêm.';
        $('editMsg').className = 'ok';
      }
      box.innerHTML = '';
    } catch (err) {
      msg.textContent = err.status === 409
        ? 'Sản phẩm đã bị người khác sửa (version lệch, HTTP 409). Tải lại trang rồi thử lại.'
        : `Không áp dụng được: ${err.message}`;
      msg.className = 'error';
    }
  });
  $('aiSkipBtn').addEventListener('click', () => {
    state.aiSuggestions.delete(p.id);
    box.innerHTML = '';
    $('editMsg').textContent = 'Đã bỏ qua gợi ý AI.';
    $('editMsg').className = '';
  });
}

async function applyAiSuggestion(p, suggestion) {
  const edits = {};
  if (suggestion.title && suggestion.title !== p.title) edits.title = suggestion.title;
  if (suggestion.ebayType) edits.ebayType = suggestion.ebayType;
  const specifics = { ...(suggestion.specifics ?? {}) };
  delete specifics.Brand; // Brand lấy từ sản phẩm/sheet, không ghi Brand do AI gợi ý.
  if (Object.keys(specifics).length) edits.aiSpecifics = specifics;
  if (suggestion.category && !(p.edits?.category ?? p.category)) edits.category = suggestion.category;
  if (!Object.keys(edits).length) return false;
  // PUT /api/products/:id — version để chống ghi đè (server trả 409 khi lệch).
  const updated = await api(`/api/products/${encodeURIComponent(p.id)}`, {
    method: 'PUT',
    body: JSON.stringify({ edits, version: p.version ?? 1 }),
  });
  Object.assign(p, updated.product ?? updated);
  renderBrowse();
  return true;
}

// ---- Lưu nhóm AI vào sản phẩm (v6) ----------------------------------------
// PUT /api/products/:id — version để chống ghi đè (server trả 409 khi lệch),
// như applyAiSuggestion. Chỉ ghi ebayType khi sản phẩm chưa có Type đã
// duyệt. PUT 404 khi sản phẩm không có trong tool — bên gọi bỏ qua lỗi đó.
async function applyAiGroup(p, assignment) {
  const edits = {};
  if (assignment.groupKey) edits.aiGroup = assignment.groupKey;
  if (assignment.groupLabel) edits.aiGroupLabel = assignment.groupLabel;
  if (assignment.ebayType && !(p.edits?.ebayType)) edits.ebayType = assignment.ebayType;
  if (!Object.keys(edits).length) return false;
  const updated = await api(`/api/products/${encodeURIComponent(p.id)}`, {
    method: 'PUT',
    body: JSON.stringify({ edits, version: p.version ?? 1 }),
  });
  Object.assign(p, updated.product ?? updated);
  return true;
}

async function saveAiGroups(productsInStore, assignments) {
  const byId = new Map((assignments ?? []).map((a) => [a.productId, a]));
  let saved = 0;
  let failed = 0;
  for (const p of productsInStore ?? []) {
    const a = byId.get(p.id);
    if (!a) continue;
    try {
      if (await applyAiGroup(p, a)) saved++;
    } catch {
      failed++;
    }
  }
  return { saved, failed };
}

// ---- Lưu gợi ý danh mục cho file nháp vào sản phẩm (v7) --------------------
// PUT /api/products/:id, ghi edits.draftCategorySuggestion kèm cờ
// unverified: true — chỉ để hiển thị, KHÔNG ghi vào cột Category của CSV.
async function saveDraftCategorySuggestions(productsInStore, assignments, suggestions) {
  const byGroup = new Map((suggestions ?? []).map((s) => [s.groupKey, s]));
  const byId = new Map((assignments ?? []).map((a) => [a.productId, a]));
  let saved = 0;
  let failed = 0;
  for (const p of productsInStore ?? []) {
    const a = byId.get(p.id);
    const s = a ? byGroup.get(a.groupKey) : null;
    if (!s) continue;
    try {
      const updated = await api(`/api/products/${encodeURIComponent(p.id)}`, {
        method: 'PUT',
        body: JSON.stringify({
          edits: { draftCategorySuggestion: { suggestedCategory: s.suggestedCategory, suggestedAspects: s.suggestedAspects ?? [], unverified: true } },
          version: p.version ?? 1,
        }),
      });
      Object.assign(p, updated.product ?? updated);
      saved++;
    } catch {
      failed++;
    }
  }
  return { saved, failed };
}

// ---- Mục File nháp trong tab Duyệt (v7) ------------------------------------
// Mỗi nhóm chưa có template có 1 nút tải file nháp + danh sách cột còn
// trống + gợi ý danh mục của AI (ghi rõ "chưa xác minh"). Cảnh báo hiện
// ngay chỗ nút tải: file nháp chưa điền Category nên Seller Hub sẽ từ chối.
function renderDraftSection(wrap, drafts, note) {
  if (!drafts.length) return;
  const div = document.createElement('div');
  div.innerHTML = `<h3>File nháp — chưa upload được, cần điền Category</h3>
    <p class="error">File nháp — chưa điền Category nên Seller Hub sẽ từ chối, chỉ dùng để xem trước và điền nốt. Gợi ý danh mục của AI (nếu có) là phỏng đoán chưa xác minh — kiểm chứng tên danh mục ở Seller Hub trước khi dùng.</p>` +
    (note ? `<p class="muted">${esc(note)}</p>` : '') +
    `<table><thead><tr><th>Nhóm</th><th>Số sản phẩm</th><th>Còn trống (cần điền)</th><th>Gợi ý danh mục của AI (chưa xác minh)</th><th>Tải file nháp</th></tr></thead><tbody>${
      drafts.map((d) => `<tr><td>${esc(d.label)}</td><td>${d.productCount}</td><td>${esc(d.missingColumns.slice(0, 8).join(', '))}${d.missingColumns.length > 8 ? ` … (+${d.missingColumns.length - 8} cột)` : ''}</td><td>${d.draftCategorySuggestion ? `${esc(d.draftCategorySuggestion.suggestedCategory)}${d.draftCategorySuggestion.suggestedAspects?.length ? ` — thường cần: ${esc(d.draftCategorySuggestion.suggestedAspects.join(', '))}` : ''}` : '—'}</td><td><button type="button" data-draft-file="${esc(d.groupKey)}">${esc(d.filename)}</button></td></tr>`).join('')}</tbody></table>`;
  div.querySelectorAll('[data-draft-file]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const d = drafts.find((x) => x.groupKey === btn.getAttribute('data-draft-file'));
      if (d) downloadText(d.filename, d.csv);
    });
  });
  wrap.appendChild(div);
}

// ---- Tab Cấu hình giá: GET/PUT /api/config ------------------------------
function fillConfigForm() {
  $('markupPct').value = state.config.markupPct;
  $('ebayFeePct').value = state.config.ebayFeePct;
  $('shippingCost').value = state.config.shippingCost;
  $('taxPct').value = state.config.taxPct;
}
$('configForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const config = {
    markupPct: Number($('markupPct').value),
    ebayFeePct: Number($('ebayFeePct').value),
    shippingCost: Number($('shippingCost').value),
    taxPct: Number($('taxPct').value),
  };
  try {
    await api('/api/config', { method: 'PUT', body: JSON.stringify(config) });
    state.config = { ...state.config, ...config };
    invalidateCategoryCsv();
    $('configMsg').textContent = 'Đã lưu cấu hình giá.';
    $('configMsg').className = 'ok';
    renderBrowse();
  } catch (err) {
    $('configMsg').textContent = `Không lưu được cấu hình: ${err.message}`;
    $('configMsg').className = 'error';
  }
});

// ---- Tab Xuất CSV ---------------------------------------------------------
let categoryPreviewRevision = 0;
let preparedCategoryCsv = null;
function currentExportConfig() {
  // Tool prepares product data. Shop-specific fields are left for each seller.
  return sellerExportConfig(state.config);
}
function invalidateCategoryCsv() {
  categoryPreviewRevision++;
  preparedCategoryCsv = null;
  $('downloadCategoryCsvBtn').disabled = true;
  const preview = $('categoryTemplatePreview');
  if (preview.innerHTML || $('categoryPrepareBtn').disabled) {
    preview.innerHTML = '';
    $('categoryPrepareStatus').textContent = 'Dữ liệu đã đổi. Bấm Tra mã & tải CSV để tạo lại file.';
    $('categoryPrepareStatus').className = 'warn';
  }
}
$('categoryProductSelect').addEventListener('change', invalidateCategoryCsv);
$('categoryIdInput').addEventListener('input', invalidateCategoryCsv);
$('downloadCategoryCsvBtn').addEventListener('click', () => {
  if (preparedCategoryCsv) downloadText(preparedCategoryCsv.filename, preparedCategoryCsv.csv);
});

function downloadText(filename, text) {
  const blob = new Blob([text], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a');
  const url = URL.createObjectURL(blob);
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  try { a.click(); } finally {
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
}

function renderGroupList() {
  const selected = $('categoryProductSelect').value;
  $('categoryProductSelect').innerHTML = '<option value="">Chọn sản phẩm</option>' + state.products.map((p) => `<option value="${esc(p.id)}">${esc(p.edits?.title ?? p.title)}</option>`).join('');
  if (state.products.some((p) => p.id === selected)) $('categoryProductSelect').value = selected;
  else if (state.products.length === 1) $('categoryProductSelect').value = state.products[0].id;
  const groups = groupProductsByTheme(state.products);
  $('groupList').innerHTML = groups.length
    ? `<ul>${groups.map((g) => `<li><strong>${esc(g.label)}</strong> — ${g.products.length} sản phẩm` +
      (g.categoryId ? ` · category eBay ${esc(g.categoryId)}${g.resolvedCategory?.verifiedFromEbay ? ` (${esc(g.resolvedCategory.categoryName ?? '')} — đã xác minh từ eBay)` : ''}` : ' · chưa có categoryId') +
      ` · file gợi ý: <code>${g.categoryId ? `ebay-${g.categoryId}-${esc(g.key)}.csv` : `ebay-DRAFT-${esc(g.key)}.csv (nháp — chưa upload được)`}</code></li>`).join('')}</ul>`
    : '<p class="muted">Chưa có sản phẩm nào để nhóm.</p>';
  return groups;
}

$('categoryTemplateForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  const status = $('categoryPrepareStatus');
  const preview = $('categoryTemplatePreview');
  const button = $('categoryPrepareBtn');
  const product = state.products.find((p) => p.id === $('categoryProductSelect').value);
  const categoryId = $('categoryIdInput').value.trim();
  if (!product || !/^\d+$/.test(categoryId)) {
    status.textContent = 'Chọn sản phẩm và nhập Category ID chỉ gồm chữ số trước khi tải CSV.';
    status.className = 'error';
    return;
  }
  const revision = ++categoryPreviewRevision;
  button.disabled = true;
  preparedCategoryCsv = null;
  $('downloadCategoryCsvBtn').disabled = true;
  preview.innerHTML = '';
  status.textContent = 'Đang tra danh mục và các trường của eBay…';
  status.className = '';
  try {
    const { category } = await api(`/api/ebay/categories/${encodeURIComponent(categoryId)}`);
    if (revision !== categoryPreviewRevision) return;
    const edits = { ebayCategoryId: category.categoryId, ebayCategoryName: category.categoryName,
      ebayCategoryPath: category.categoryPath, ebayRequiredAspects: category.requiredAspects,
      ebayRecommendedAspects: category.recommendedAspects };
    const { product: saved } = await api(`/api/products/${encodeURIComponent(product.id)}`, {
      method: 'PUT', body: JSON.stringify({ version: product.version, edits }),
    });
    state.products = state.products.map((p) => p.id === saved.id ? saved : p);
    const template = await loadEmbeddedTemplate();
    if (revision !== categoryPreviewRevision) return;
    const groups = [{ key: `cat-${category.categoryId}`, label: category.categoryName, categoryId: category.categoryId,
      resolvedCategory: category, products: [saved] }];
    const { files, skipped } = buildGroupedEbayCsvs([saved], template, currentExportConfig(), groups);
    renderBrowse();
    renderGroupList();
    const file = files[0];
    if (!file) throw new Error(skipped.map((item) => item.reason).join(' ') || 'Chưa tạo được CSV.');
    const rows = parseCsvText(file.csv);
    const headers = rows.find((row) => row.some((cell) => /^\*?Action(?:\(|$)/i.test(cell))) ?? [];
    const columns = headers.map((name, index) => ({ name: name.replace(/^\*/, ''), index }))
      .filter(({ name }) => ['CustomLabel', 'Title', 'StartPrice', 'Category'].includes(name) || name.startsWith('C:'));
    const data = rows.filter((row) => row[templateColumnIndex(headers, 'Action')] === 'Add');
    const productIssues = file.validationIssues.filter((issue) => !/seller_setting|policy_name/.test(issue.code));
    const sellerFields = [...new Set(file.validationIssues.filter((issue) => /seller_setting|policy_name/.test(issue.code)).map((issue) => issue.field))];
    status.textContent = `Đã tạo và gửi tải CSV theo danh mục ${category.categoryId} — ${category.categoryName}, ${data.length} dòng SKU. ` +
      (productIssues.length ? `Có ${productIssues.length} mục dữ liệu sản phẩm cần kiểm tra.` : 'Đã qua kiểm tra trường sản phẩm bắt buộc trong dữ liệu hiện có.');
    status.className = productIssues.length ? 'warn' : 'ok';
    preview.innerHTML = (productIssues.length ? `<ul>${productIssues.map((issue) => `<li>${esc(issue.sku ?? issue.productId)} — ${esc(issue.message)}</li>`).join('')}</ul>` : '') +
      (sellerFields.length ? `<p class="muted">Dành cho seller điền sau: ${sellerFields.map(esc).join(', ')}. Các mục này không lấy từ trang sản phẩm.</p>` : '') +
      `<div style="overflow:auto"><table><thead><tr>${columns.map((c) => `<th>${esc(c.name)}</th>`).join('')}</tr></thead><tbody>${data.slice(0, 10).map((row) => `<tr>${columns.map((c) => `<td>${esc(row[c.index] || '—')}</td>`).join('')}</tr>`).join('')}</tbody></table></div>` +
      (data.length > 10 ? `<p>Hiển thị 10/${data.length} dòng; file CSV chứa tất cả.</p>` : '');
    preparedCategoryCsv = file;
    $('downloadCategoryCsvBtn').disabled = false;
    downloadText(file.filename, file.csv);
  } catch (error) {
    if (revision !== categoryPreviewRevision) return;
    status.textContent = `Chưa chuẩn bị được template: ${error.data?.message ?? error.message}`;
    status.className = 'error';
  } finally { button.disabled = false; }
});

// ---- Template eBay nhúng sẵn (v4) --------------------------------------
// Template gối 20563 nằm sẵn ở ./templates/ebay-20563.csv, tự tải mặc định
// khi mở trang — không bắt nạp tay. Người dùng vẫn đổi được template khác
// bằng nút chọn file bên dưới (ghi đè state.template).
async function loadEmbeddedTemplate() {
  if (state.template) return state.template;
  try {
    const res = await fetch('./templates/ebay-20563.csv');
    if (!res.ok) return null;
    state.template = parseEbayTemplate(await res.text());
    state.templateName = 'ebay-20563.csv (nhúng sẵn)';
    const msg = $('templateMsg');
    if (msg) msg.textContent = `Mẫu cơ sở: ${state.templateName} — ${state.template.headers.length} cột. Tra Category ID để lấy trường của danh mục cần xuất; hoặc nạp mẫu CSV Seller Hub bên dưới.`;
    return state.template;
  } catch {
    return null;
  }
}
void loadEmbeddedTemplate();

$('templateFile').addEventListener('change', async (event) => {
  const file = event.target.files?.[0];
  const msg = $('templateMsg');
  if (!file) return;
  invalidateCategoryCsv();
  try {
    const text = await file.text();
    state.template = parseEbayTemplate(text);
    state.templateName = file.name;
    msg.textContent = `Đã nạp template ${file.name}: category ${state.template.categoryId ?? '(không rõ)'}, ${state.template.headers.length} cột, required: ${state.template.requiredAspects.join('; ') || '—'}.`;
    msg.className = 'ok';
  } catch (err) {
    state.template = null;
    msg.textContent = `Template không hợp lệ: ${err.message}`;
    msg.className = 'error';
  }
  renderGroupList();
});

$('downloadGroupedBtn').addEventListener('click', () => {
  const msg = $('exportMsg');
  if (!state.template) {
    msg.textContent = 'Chưa nạp template eBay: chọn file template (.csv) của danh mục rồi bấm lại.';
    msg.className = 'error';
    return;
  }
  // buildGroupedEbayCsvs (core.js): CHỈ xuất nhóm có categoryId khớp
  // template (gối 20563) HOẶC nhóm đã có mã xác minh từ eBay Taxonomy
  // (đã tự áp trong tab Duyệt). Nhóm chưa có mã thì KHÔNG
  // xuất chung — xuất bàn dưới template gối (20563) thì eBay sẽ từ chối
  // vì thiếu Type. Cần tra mã eBay cho nhóm đó rồi xuất riêng.
  const groups = groupProductsByTheme(state.products);
  const { files, skipped } = buildGroupedEbayCsvs(state.products, state.template, currentExportConfig(), groups);
  let done = 0;
  for (const file of files) {
    downloadText(file.filename, file.csv);
    done++;
  }
  msg.textContent = `Đã tải ${done} file CSV theo nhóm.` +
    (files.some((f) => f.verifiedFromEbay) ? ` Trong đó có file dùng mã đã xác minh từ eBay Taxonomy: ${files.filter((f) => f.verifiedFromEbay).map((f) => f.filename).join(', ')}.` : '') +
    (skipped.length ? ` Bỏ qua: ${skipped.map((s) => `${s.label} (${s.productCount} sp): ${s.reason}`).join('; ')}.` : '') +
    (files.flatMap((f) => f.warnings ?? []).length ? ` Lưu ý: ${files.flatMap((f) => f.warnings ?? []).join(' ')}` : '');
  msg.className = done ? (files.some((file) => file.needsReview) ? 'warn' : 'ok') : 'error';
});

$('downloadCsv').addEventListener('click', () => {
  try {
    const csv = buildCsv(state.products, currentExportConfig());
    downloadText(`ebay-listing-${new Date().toISOString().slice(0, 10)}.csv`, csv);
    $('exportMsg').textContent = 'Đã tải CSV cơ bản để đối chiếu. Chưa kiểm tra đầy đủ trường danh mục; dùng Tra mã & điền template để chuẩn bị listing.';
    $('exportMsg').className = 'warn';
  } catch (error) {
    $('exportMsg').textContent = error.message;
    $('exportMsg').className = 'error';
  }
});

// ---- Tìm listing eBay cho tất cả sản phẩm chưa có số liệu (v9.1) --------
 // POST /api/ebay/enrich-all: server tự search + getItem từng sản phẩm qua
// Browse API, điền số đã bán (ước tính) + người theo dõi. Gặp 429 thì dừng,
// đợi 1 phút rồi bấm lại (sản phẩm đã khớp xong sẽ được bỏ qua).
$('ebayEnrichAllBtn').addEventListener('click', async () => {
  const status = $('ebayEnrichStatus');
  const btn = $('ebayEnrichAllBtn');
  if (!state.products.length) {
    status.textContent = 'Chưa có sản phẩm nào để tìm listing eBay.';
    status.className = 'error';
    return;
  }
  btn.disabled = true;
  status.textContent = `Đang tìm listing eBay khớp cho ${state.products.length} sản phẩm…`;
  status.className = '';
  try {
    const result = await api('/api/ebay/enrich-all', { method: 'POST', body: JSON.stringify({}) });
    const matched = (result.results ?? []).filter((r) => r.matched).length;
    const total = (result.results ?? []).length;
    // Tải lại sản phẩm từ server để bảng Duyệt hiện số liệu mới.
    const fresh = await api('/api/products');
    state.products = asArray(fresh.products ?? fresh);
    renderBrowse();
    renderGroupList();
    status.textContent = `Đã tra xong ${total} sản phẩm: ${matched} sản phẩm khớp listing eBay, ${total - matched} sản phẩm chưa khớp (xem cột "Listing eBay khớp", bấm vào từng dòng rồi bấm "Tìm lại" để thử lại).` +
      (result.stopped429 ? ' Đã chạm giới hạn request (429) giữa chừng — đợi 1 phút rồi bấm lại, sản phẩm đã khớp xong sẽ được bỏ qua.' : '');
    status.className = 'ok';
  } catch (err) {
    status.textContent = `Không tìm được listing eBay: ${err.message}`;
    status.className = 'error';
  } finally {
    btn.disabled = false;
  }
});

// ---- File research (v9.1): số liệu tham khảo, KHÔNG upload Seller Hub ------
// 1 file riêng cho mỗi nhóm (research-<nhóm>.csv): Title, URL gốc, Giá bán
// lẻ, Giá bán eBay (GIÁ BÁN), Đã bán, Người theo dõi, CategoryId, Link
// listing eBay, Điểm khớp. Đã bán (ước tính) / Người theo dõi là TỔNG cả
// listing eBay, không chia màu/size.
$('downloadResearchBtn').addEventListener('click', () => {
  const msg = $('researchMsg');
  if (!state.products.length) {
    msg.textContent = 'Chưa có sản phẩm nào để xuất file research.';
    msg.className = 'error';
    return;
  }
  const groups = groupProductsByTheme(state.products);
  const { files, skipped } = buildResearchGroupedCsvs(state.products, state.config, groups);
  let done = 0;
  for (const file of files) {
    downloadText(file.filename, file.csv);
    done++;
  }
  msg.textContent = `Đã tải ${done} file research (${files.reduce((n, f) => n + f.productCount, 0)} sản phẩm). File research chỉ để xem số liệu tham khảo, không upload Seller Hub.` +
    (skipped.length ? ` Bỏ qua: ${skipped.map((s) => s.label).join('; ')}.` : '');
  msg.className = done ? 'ok' : 'error';
});

// ---- Tab Khóa crawl: GET/POST /api/keys ----------------------------------
async function loadKeys() {
  try {
    const data = await api('/api/keys');
    const keys = asArray(data.keys ?? data);
    $('keyList').innerHTML = keys.length
      ? keys.map((k) => `<li>${esc(k.name)} <span class="muted">— tạo ${esc(k.createdAt ?? k.created_at ?? '')}${(k.lastUsedAt ?? k.last_used_at) ? ` · dùng lần cuối ${esc(k.lastUsedAt ?? k.last_used_at)}` : ' · chưa dùng'}</span></li>`).join('')
      : '<li>Chưa có khóa nào.</li>';
  } catch (err) {
    $('keyList').innerHTML = `<li class="error">Không tải được danh sách khóa: ${esc(err.message)}</li>`;
  }
}
$('keyForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const name = $('keyName').value.trim();
  const msg = $('keyMsg');
  $('keyOnce').hidden = true;
  if (!name) {
    msg.textContent = 'Nhập tên khóa trước khi tạo (vd tên người dùng hoặc tên crawler).';
    msg.className = 'error';
    $('keyName').focus();
    return;
  }
  try {
    const data = await api('/api/keys', { method: 'POST', body: JSON.stringify({ name }) });
    const key = data.key ?? data.api_key ?? data.apiKey;
    if (!key) throw new Error('Server không trả khóa mới.');
    $('keyOnceValue').textContent = key;
    $('keyOnce').hidden = false;
    msg.textContent = 'Đã tạo khóa. Khóa chỉ hiện một lần — copy và lưu lại ngay.';
    msg.className = 'ok';
    $('keyName').value = '';
    loadKeys();
  } catch (err) {
    msg.textContent = `Không tạo được khóa: ${err.message}`;
    msg.className = 'error';
  }
});

// ---- Tab Nhập: POST /api/ingest/records -----------------------------------
$('pingBtn').addEventListener('click', async () => {
  const key = $('ingestKey').value.trim();
  if (!key) { $('pingMsg').textContent = 'Nhập khóa crawl trước.'; return; }
  try {
    const data = await api('/api/ingest/ping', { headers: { Authorization: `Bearer ${key}` } });
    $('pingMsg').textContent = `Ping OK — khóa: ${data.name ?? '(không rõ tên)'}.`;
  } catch (err) {
    $('pingMsg').textContent = `Ping lỗi: ${err.message}`;
  }
});
$('importBtn').addEventListener('click', async () => {
  const msg = $('importMsg');
  const key = $('ingestKey').value.trim();
  if (!key) { msg.textContent = 'Nhập khóa crawl (csvk_…) trước khi gửi.'; msg.className = 'error'; return; }
  let records;
  try {
    records = JSON.parse($('recordsJson').value);
    if (!Array.isArray(records)) throw new Error('JSON phải là một mảng records.');
  } catch (err) {
    msg.textContent = `JSON không hợp lệ: ${err.message}`;
    msg.className = 'error';
    return;
  }
  try {
    const data = await api('/api/ingest/records', {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}` },
      body: JSON.stringify({ records }),
    });
    const products = asArray(data.products);
    const errors = asArray(data.errors);
    msg.textContent = `Đã nhập: ${products.length} sản phẩm${data.stats ? ` (tổng ${data.stats.total}, gộp trùng ${data.stats.mergedDuplicates ?? 0}, lỗi ${data.stats.errors ?? errors.length})` : ''}.` +
      (errors.length ? ` Lỗi: ${errors.map((x) => `${x.source_site}/${x.source_product_id}: ${x.message}`).join(' | ')}` : '');
    msg.className = errors.length ? '' : 'ok';
        loadBootstrap();

  } catch (err) {
    msg.textContent = `Không gửi được: ${err.message}`;
    msg.className = 'error';
  }
});

// ---- Tab AI gợi ý: GET /api/ai/status, POST/DELETE /api/ai/config ------
// Key AI chỉ gửi lên server (POST /api/ai/config), lưu trong RAM, mất khi
// restart server. Không lưu localStorage, không đưa key vào extension.
// Nếu server đã đặt AI_API_KEY trong env thì key đó được ưu tiên hơn key
// dán ở đây (xem trạng thái "nguồn: env / web").
function aiStatusText(status) {
  if (!status) return 'Không kiểm tra được trạng thái AI.';
  if (!status.configured) {
    return 'Chưa có key AI — đang gợi ý theo luật (rule-based). Dán key bên dưới, hoặc đặt AI_API_KEY trong file .env (dev local) / wrangler secret (khi deploy).';
  }
  return `Đã có key AI — provider ${status.provider}, model ${status.model}, nguồn key: ${status.source === 'env' ? 'biến môi trường (ưu tiên hơn key dán trong web)' : 'đã dán trong web (RAM, mất khi restart server)'}.`;
}

async function loadAiStatus() {
  const el = $('aiStatus');
  try {
    const status = await api('/api/ai/status');
    state.aiStatus = status;
    el.textContent = aiStatusText(status);
    el.className = status.configured ? 'ok' : 'muted';
    if (status.provider) $('aiProvider').value = status.provider;
  } catch (err) {
    el.textContent = `Không kiểm tra được trạng thái AI: ${err.message}`;
    el.className = 'error';
  }
}

$('aiConfigForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const msg = $('aiConfigMsg');
  const fd = new FormData(e.target);
  const payload = {
    provider: fd.get('provider')?.trim() || undefined,
    model: fd.get('model')?.trim() || undefined,
    baseUrl: fd.get('baseUrl')?.trim() || undefined,
    apiKey: fd.get('apiKey')?.trim() || undefined,
  };
  if (!payload.apiKey && !payload.provider && !payload.model && !payload.baseUrl) {
    msg.textContent = 'Chưa nhập gì — nhập khóa API (và chọn provider/model nếu cần) rồi bấm Lưu key.';
    msg.className = 'error';
    return;
  }
  try {
    const status = await api('/api/ai/config', { method: 'POST', body: JSON.stringify(payload) });
    state.aiStatus = status;
    $('aiStatus').textContent = aiStatusText(status);
    $('aiStatus').className = status.configured ? 'ok' : 'muted';
    $('aiKey').value = '';
    msg.textContent = status.configured
      ? `Đã lưu key AI trên server (${status.provider}/${status.model}). Key chỉ nằm trong RAM server, không lưu trên trình duyệt.`
      : 'Đã lưu cấu hình (provider/model) nhưng chưa có key — dán key rồi bấm Lưu key.';
    msg.className = status.configured ? 'ok' : '';
  } catch (err) {
    msg.textContent = `Không lưu được: ${err.message}`;
    msg.className = 'error';
  }
});

$('aiClearBtn').addEventListener('click', async () => {
  const msg = $('aiConfigMsg');
  try {
    const status = await api('/api/ai/config', { method: 'DELETE' });
    state.aiStatus = status;
    $('aiStatus').textContent = aiStatusText(status);
    $('aiStatus').className = status.configured ? 'ok' : 'muted';
    msg.textContent = status.configured
      ? 'Đã xoá key dán trong web — nhưng server vẫn dùng key trong biến môi trường AI_API_KEY (xem trạng thái phía trên). Muốn tắt hẳn AI thì xoá AI_API_KEY khỏi .env / secret rồi restart server.'
      : 'Đã xoá key đã dán trong web. AI quay về gợi ý theo luật.';
    msg.className = 'ok';
  } catch (err) {
    msg.textContent = `Không xoá được: ${err.message}`;
    msg.className = 'error';
  }
});

// ---- eBay Taxonomy (v8) — tra mã danh mục thật từ eBay ---------------
async function loadEbayStatus() {
  try {
    const res = await fetch('/api/ebay/status');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    state.ebayStatus = await res.json();
  } catch {
    state.ebayStatus = null;
  }
  $('ebayStatus').textContent = ebayStatusText();
  $('ebayEnvironment').value = state.ebayStatus?.environment ?? 'production';
}

function ebayStatusText() {
  const s = state.ebayStatus;
  if (!s) return 'Không kiểm tra được trạng thái eBay Taxonomy — server có đang chạy không?';
  if (!s.configured) return 'eBay Taxonomy: CHƯA có khóa — nhóm chưa có template vẫn chỉ ra file nháp (v7). Dán App ID + Cert ID bên dưới, hoặc đặt EBAY_APP_ID / EBAY_CERT_ID trong .env.';
  return `eBay Taxonomy: đã có khóa (${s.environment === 'sandbox' ? 'Sandbox' : 'Production'}, thị trường ${s.marketplace}) — nguồn: ${s.source === 'env' ? 'biến môi trường (.env)' : 'đã dán trong web'}.`;
}

$('ebayConfigForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  const msg = $('ebayConfigMsg');
  const appId = $('ebayAppId').value.trim();
  const certId = $('ebayCertId').value.trim();
  const environment = $('ebayEnvironment').value;
  if (!appId || !certId) {
    msg.textContent = 'Cần cả App ID và Cert ID (lấy ở developer.ebay.com → tạo app). Không gửi khóa trong chat — chỉ dán vào ô nhập trong web.';
    msg.className = 'error';
    return;
  }
  msg.textContent = 'Đang lưu khóa eBay (chỉ trong RAM của server)…';
  msg.className = '';
  try {
    const res = await fetch('/api/ebay/config', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ appId, certId, environment }),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
    $('ebayAppId').value = '';
    $('ebayCertId').value = '';
    await loadEbayStatus();
    msg.textContent = `Đã lưu khóa eBay (${json.environment === 'sandbox' ? 'Sandbox' : 'Production'}) — chỉ ở RAM, tắt server là mất. Bấm "Kiểm tra kết nối" để chắc eBay nhận khóa.`;
    msg.className = 'ok';
  } catch (err) {
    msg.textContent = `Không lưu được khóa eBay: ${err.message}`;
    msg.className = 'error';
  }
});

$('ebayClearBtn').addEventListener('click', async () => {
  const msg = $('ebayConfigMsg');
  try {
    await fetch('/api/ebay/config', { method: 'DELETE' });
    await loadEbayStatus();
    msg.textContent = 'Đã xoá khóa eBay dán trong web. Nếu khóa còn trong .env thì server vẫn dùng khóa đó.';
    msg.className = 'ok';
  } catch (err) {
    msg.textContent = `Không xoá được: ${err.message}`;
    msg.className = 'error';
  }
});

$('ebayCheckBtn').addEventListener('click', async () => {
  const msg = $('ebayConfigMsg');
  msg.textContent = 'Đang gọi thử Taxonomy API của eBay (lấy mã cây danh mục US)…';
  msg.className = '';
  try {
    const res = await fetch('/api/ebay/check');
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
    msg.textContent = `Kết nối eBay OK — cây danh mục ${json.marketplace} có id ${json.categoryTreeId} (tree id 0 là cây US). Mở tab Duyệt rồi bấm "AI phân loại + xuất CSV theo nhóm" — mã tra được tự áp luôn, không cần bấm gì thêm.`;
    msg.className = 'ok';
  } catch (err) {
    msg.textContent = `Kết nối eBay thất bại: ${err.message}. Kiểm tra lại App ID / Cert ID và môi trường (production dùng khóa production, sandbox dùng khóa sandbox riêng).`;
    msg.className = 'error';
  }
});

/** Tra mã eBay cho các nhóm (POST /api/ebay/resolve-groups) rồi TỰ ÁP mã
 *  đã xác minh vào sản phẩm (v9.3 — không còn bước bấm tay nào nữa).
 *  Mã chỉ tự áp khi verifiedFromEbay === true (lấy từ Taxonomy API);
 *  mã do AI đoán KHÔNG BAO GIỜ được tự áp (xem autoApplyEbayResolutions
 *  trong core.js). Lỗi 409 ở 1 sản phẩm thì bỏ qua sản phẩm đó + ghi
 *  warning, không dừng cả nhóm. Trả {resolved, perGroup, applied, failed}.
 *  opts.refreshSummary=false khi gọi từ trong luồng "AI phân loại + xuất
 *  CSV" (bảng tóm tắt sẽ vẽ lại sau khi đã tải file xong). */
async function resolveEbayGroups(groups, { refreshSummary = true } = {}) {
  const statusEl = $('aiGroupStatus');
  const box = $('ebayResolveResults');
  if (!state.ebayStatus?.configured) {
    statusEl.textContent = 'Chưa có khóa eBay — dán App ID + Cert ID trong tab "AI gợi ý" (mục eBay Taxonomy) rồi bấm lại.';
    statusEl.className = 'error';
    return { resolved: false };
  }
  const todo = (groups ?? []).filter((g) => g.key !== 'chua-phan-loai' && !g.resolvedCategory?.verifiedFromEbay);
  if (!todo.length) {
    statusEl.textContent = 'Tất cả nhóm đã có mã danh mục xác minh từ eBay rồi — không còn nhóm nào để tra.';
    statusEl.className = 'ok';
    return { resolved: true, perGroup: [], applied: 0, failed: 0 };
  }
  statusEl.textContent = `Đang tra mã eBay cho ${todo.length} nhóm…`;
  statusEl.className = '';
  try {
    const res = await fetch('/api/ebay/resolve-groups', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ groups: todo.map((g) => ({ groupKey: g.key, label: g.label, sampleTitles: g.products.slice(0, 3).map((p) => p.title) })) }),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
    const results = json.results ?? [];
    // Tự áp mã đã xác minh vào sản phẩm (PUT từng sản phẩm, kèm version
    // check 409 — lỗi 409 thì bỏ qua sản phẩm đó, xem core.js).
    const apply = await autoApplyEbayResolutions(results, todo, async (p, edits) => {
      const updated = await api(`/api/products/${encodeURIComponent(p.id)}`, {
        method: 'PUT',
        body: JSON.stringify({ edits, version: p.version ?? 1 }),
      });
      return updated.product ?? updated;
    });
    // Bảng kết quả chỉ-đọc (không có nút bấm nào).
    const rows = results.map((r) => {
      const a = apply.perGroup.find((x) => x.groupKey === r.groupKey);
      if (!r.categoryId) {
        return `<tr><td>${esc(r.groupKey)}</td><td>—</td><td class="warn">${esc(r.warning ?? 'eBay không gợi ý được mã cho nhóm này — giữ file nháp.')}</td></tr>`;
      }
      return `<tr><td>${esc(r.groupKey)}</td><td>${esc(r.categoryId)}</td><td>${esc(r.categoryPath ?? r.categoryName ?? '')}<br><span class="ok">đã xác minh từ eBay — đã tự áp vào ${a?.applied ?? 0} sản phẩm${a?.failed ? ` (lỗi ${a.failed})` : ''}</span>${r.requiredAspects?.length ? `<br>Trường bắt buộc: ${esc(r.requiredAspects.map((x) => x.name ?? x).join(', '))}` : ''}${a?.warning ? `<br><span class="warn">${esc(a.warning)}</span>` : ''}</td></tr>`;
    }).join('');
    box.innerHTML = `<h3>Mã danh mục eBay — đã tự áp vào sản phẩm</h3>
      <table><thead><tr><th>Nhóm</th><th>Mã eBay</th><th>Đường dẫn / trường bắt buộc</th></tr></thead><tbody>${rows}</tbody></table>
      <p class="muted">Mã này lấy từ Taxonomy API của eBay, không phải AI đoán. Nhóm nào chưa có mã thì vẫn ra file nháp (DRAFT), không xuất nhầm.</p>`;
    const withCode = results.filter((r) => r.categoryId).length;
    statusEl.textContent = `Đã tra xong ${todo.length} nhóm: ${withCode} nhóm có mã, đã tự áp cho ${apply.applied} sản phẩm${apply.failed ? ` (lỗi ${apply.failed} sản phẩm — version lệch, bấm "Tìm lại" để thử lại)` : ''}; ${results.length - withCode} nhóm chưa tra được (giữ file nháp).`;
    statusEl.className = 'ok';
    // Refresh bảng nhóm để cột Mã eBay hiện mã vừa tự áp.
    if (refreshSummary && state.lastAiAssignments) {
      state.lastAiGroups = groupProductsByAiAssignments(state.products, state.lastAiAssignments);
      renderGroupSummary();
    }
    renderBrowse();
    renderGroupList();
    return { resolved: true, perGroup: apply.perGroup, applied: apply.applied, failed: apply.failed };
  } catch (err) {
    statusEl.textContent = `Tra mã eBay thất bại: ${err.message}`;
    statusEl.className = 'error';
    return { resolved: false, error: err.message };
  }
}

// ---- Gợi ý AI hàng loạt (tab Duyệt) ---------------------------------------
// Gọi lần lượt từng sản phẩm đang hiển thị; mỗi dòng có nút Áp dụng / Bỏ qua
// riêng — KHÔNG tự áp dụng.
$('aiBulkBtn').addEventListener('click', async () => {
  const status = $('aiBulkStatus');
  const wrap = $('aiBulkResults');
  const btn = $('aiBulkBtn');
  if (!state.products.length) {
    status.textContent = 'Chưa có sản phẩm nào để gợi ý.';
    status.className = 'error';
    return;
  }
  // Bấm lại để làm tiếp: bỏ qua sản phẩm đã có gợi ý (chưa Áp dụng cũng
  // tính là đã gợi ý — muốn gợi ý lại thì Bỏ qua dòng đó rồi bấm lại).
  const todo = state.products.filter((p) => !state.aiSuggestions.has(p.id));
  if (!todo.length) {
    status.textContent = 'Tất cả sản phẩm đang hiển thị đã có gợi ý — bấm Áp dụng từng dòng bên dưới. Muốn gợi ý lại một sản phẩm thì bấm Bỏ qua dòng đó rồi bấm nút này lại.';
    status.className = '';
    return;
  }
  const isGemini = state.aiStatus?.provider === 'gemini';
  btn.disabled = true;
  wrap.innerHTML = '';
  const rows = [];
  let stopped429 = false;
  for (let i = 0; i < todo.length; i++) {
    const p = todo[i];
    status.textContent = `Đang gợi ý ${i + 1}/${todo.length}: ${p.title}` +
      (isGemini ? ' (Gemini: tool mặc định giãn ~4 giây/lần gọi; quota phụ thuộc model và project)' : '');
    try {
      const result = await api('/api/ai/suggest', { method: 'POST', body: JSON.stringify({ productId: p.id }) });
      state.aiSuggestions.set(p.id, result);
      rows.push({ p, result });
      // Chạm giới hạn nhà cung cấp (LLM trả 429, server đã fallback về
      // rule-based kèm warning chứa "429"): DỪNG NGAY, giữ kết quả đã có,
      // báo rõ để user đợi 1 phút rồi bấm tiếp — không gọi dồn dập nữa.
      if (result.provider === 'rule-based' && asArray(result.warnings).some((w) => w.includes('429'))) {
        stopped429 = true;
        break;
      }
    } catch (err) {
      rows.push({ p, result: null, error: err.message });
      if (String(err.message ?? '').includes('429')) {
        stopped429 = true;
        break;
      }
    }
  }
  status.textContent = stopped429
    ? `Đã DỪNG: AI chạm giới hạn (HTTP 429). Đã có gợi ý cho ${rows.filter((r) => r.result).length} sản phẩm — bấm Áp dụng các dòng đã có, đợi 1 phút rồi bấm "Gợi ý AI hàng loạt" tiếp. Nếu vẫn lỗi, kiểm tra quota của model/project tại nhà cung cấp. Sản phẩm đã có gợi ý sẽ được bỏ qua.`
    : `Xong: đã gợi ý cho ${rows.length} sản phẩm. Bấm Áp dụng từng dòng để lưu — gợi ý chưa được lưu.`;
  status.className = stopped429 ? 'error' : 'ok';
  btn.disabled = false;
  wrap.innerHTML = rows.length
    ? `<table><thead><tr><th>Sản phẩm</th><th>Nguồn</th><th>Title gợi ý</th><th>Type eBay</th><th>Item specifics</th><th>Lưu ý</th><th></th></tr></thead><tbody>${
      rows.map(({ p, result, error }, i) => {
        const s = result?.suggestion ?? {};
        return `<tr data-i="${i}">
          <td>${esc(p.title)}</td>
          <td>${esc(result?.provider ?? (error ? 'lỗi' : '—'))}</td>
          <td>${esc(s.title ?? '—')}</td>
          <td>${esc(s.ebayType ?? '—')}</td>
          <td>${esc(Object.entries(s.specifics ?? {}).map(([k, v]) => `${k}=${v}`).join('; ') || '—')}</td>
          <td>${esc(error ?? asArray(result?.warnings).join('; ') ?? '')}</td>
          <td>${result ? `<button type="button" class="ai-bulk-apply" data-i="${i}">Áp dụng</button> <button type="button" class="ai-bulk-skip" data-i="${i}">Bỏ qua</button>` : ''}</td>
        </tr>`;
      }).join('')}</tbody></table>`
    : '';
  wrap.querySelectorAll('.ai-bulk-apply').forEach((b) => b.addEventListener('click', async () => {
    const { p, result } = rows[Number(b.dataset.i)];
    try {
      const applied = await applyAiSuggestion(p, result.suggestion ?? {});
      b.closest('tr').querySelector('td:last-child').textContent = applied ? 'Đã áp dụng ✓' : 'Không có gì mới';
    } catch (err) {
      b.closest('tr').querySelector('td:last-child').textContent = err.status === 409 ? 'Version lệch (409) — tải lại trang' : `Lỗi: ${err.message}`;
    }
  }));
  wrap.querySelectorAll('.ai-bulk-skip').forEach((b) => b.addEventListener('click', () => {
    const { p } = rows[Number(b.dataset.i)];
    state.aiSuggestions.delete(p.id);
    b.closest('tr').remove();
  }));
});

// ---- Bảng tóm tắt nhóm (tab Duyệt, v9.3) -----------------------------------
// Vẽ lại sau mỗi lần AI phân loại và sau mỗi lần tra mã tự áp, để cột Mã
// eBay luôn hiện mã mới nhất. Nhóm chưa có mã thì chỉ còn 1 nút "Tìm lại"
// (chạy lại resolve cho nhóm đó, tra được thì tự áp luôn).
function renderGroupSummary() {
  const host = $('aiGroupSummary');
  if (!host || !state.lastAiGroups) return;
  const groups = state.lastAiGroups;
  const files = state.lastAiFiles ?? [];
  const grouped = state.lastAiGrouped ?? {};
  const template = state.template;
  host.innerHTML = `<p class="muted">Phân loại bằng ${grouped.provider === 'rule-based' ? 'từ khoá (chưa có key AI / AI lỗi)' : `AI (${esc(grouped.provider ?? '')})`}${grouped.stopped429 ? ' — đã chạm giới hạn AI (429), phần còn lại dùng nhóm theo từ khoá; đợi 1 phút rồi thử lại, nếu vẫn lỗi hãy kiểm tra quota tại nhà cung cấp' : ''}.</p>` +
    (grouped.warnings?.length ? `<p class="muted">Lưu ý: ${esc(grouped.warnings.slice(0, 3).join(' | '))}</p>` : '') +
    `<table><thead><tr><th>Nhóm</th><th>Số sản phẩm</th><th>Mã eBay</th><th>Vài sản phẩm mẫu</th><th>Xuất CSV</th></tr></thead><tbody>${groups.map((g) => {
      const file = files.find((f) => f.groupKey === g.key);
      const codeCell = g.resolvedCategory?.verifiedFromEbay
        ? `${esc(g.categoryId)} — <span class="ok">tự áp từ eBay</span><br>${esc(g.resolvedCategory.categoryPath ?? g.resolvedCategory.categoryName ?? '')}`
        : g.categoryId === template?.categoryId
          ? `${esc(template.categoryId)} — đã có template gối`
          : g.key === 'chua-phan-loai'
            ? '—'
            : `chưa có mã — file nháp<br><button type="button" data-resolve-ebay="${esc(g.key)}">Tìm lại</button>`;
      const exportCell = file
        ? `${file.needsReview ? 'Cần kiểm tra' : 'Đã đối chiếu dữ liệu'} — ${esc(file.filename)}${file.verifiedFromEbay ? ' (mã đã xác minh từ eBay)' : ''}${(file.warnings ?? []).length ? `<br><span class="warn">${esc(file.warnings.join(' '))}</span>` : ''}`
        : g.key === 'chua-phan-loai' ? 'Chưa phân loại — kiểm lại tay' : `File nháp — ebay-DRAFT-${esc(g.key)}.csv`;
      return `<tr><td>${esc(g.label)}</td><td>${g.products.length}</td><td>${codeCell}</td><td>${esc(g.products.slice(0, 3).map((p) => p.title).join('; '))}</td><td>${exportCell}</td></tr>`;
    }).join('')}</tbody></table>` +
    `<p><button type="button" id="ebayResolveAllBtn">Tìm lại mã eBay cho nhóm chưa có mã</button> <span class="muted">Cần khóa eBay (tab "AI gợi ý" → mục eBay Taxonomy). Mã tra được tự áp luôn vào sản phẩm, không cần bấm gì thêm.</span></p>`;
  $('ebayResolveAllBtn').addEventListener('click', () => resolveEbayGroups(state.lastAiGroups ?? groups));
}

// ---- AI phân loại + xuất CSV theo nhóm (tab Duyệt, v6) --------------------
// Gọi POST /api/ai/group 1 lần cho tất cả sản phẩm đang hiển thị (LLM gom
// theo batch 20, giãn cách như gợi ý hàng loạt) -> TỰ tra mã eBay + tự áp
// mã cho các nhóm (v9.3, không còn bước tay nào ở giữa) -> tự tải 1 file
// CSV cho mỗi nhóm có template (hiện chỉ gối 20563), nhóm chưa có template
// thì báo rõ, không xuất nhầm sang template gối. Nhóm sau khi tự tra vẫn
// chưa có mã thì vẫn ra file DRAFT như cũ + ghi rõ trong tóm tắt.
$('aiGroupBtn').addEventListener('click', async () => {
  const status = $('aiGroupStatus');
  const wrap = $('aiGroupResults');
  const btn = $('aiGroupBtn');
  if (!state.products.length) {
    status.textContent = 'Chưa có sản phẩm nào để phân loại.';
    status.className = 'error';
    return;
  }
  btn.disabled = true;
  wrap.innerHTML = '';
  status.textContent = `Đang nhờ AI phân loại ${state.products.length} sản phẩm…` +
    (state.aiStatus?.configured ? '' : ' (chưa có key AI — sẽ phân loại theo từ khoá, dán key vào tab AI gợi ý để AI phân loại)');
  try {
    const grouped = await api('/api/ai/group', { method: 'POST', body: JSON.stringify({ productIds: state.products.map((p) => p.id) }) });
    const template = await loadEmbeddedTemplate();
    if (!template) {
      status.textContent = 'Không tải được template gối 20563 nhúng sẵn — kiểm tra file public/templates/ebay-20563.csv, hoặc nạp template tay trong tab Xuất CSV.';
      status.className = 'error';
      return;
    }
    // Lưu nhóm vào sản phẩm (PUT, version check 409) để lần sau mở lại còn.
    const { saved, failed } = await saveAiGroups(state.products, grouped.assignments);
    // Tự tra mã eBay + tự áp cho các nhóm TRƯỚC khi xuất (v9.3): nhóm nào
    // tra được mã thì xuất file upload được luôn, nhóm nào chưa có mã thì
    // vẫn ra file nháp DRAFT + ghi rõ trong tóm tắt.
    let groups = groupProductsByAiAssignments(state.products, grouped.assignments);
    state.lastAiGroups = groups;
    state.lastAiAssignments = grouped.assignments;
    state.lastAiGrouped = grouped;
    state.lastAiFiles = [];
    await resolveEbayGroups(groups, { refreshSummary: false });
    groups = groupProductsByAiAssignments(state.products, grouped.assignments);
    state.lastAiGroups = groups;
    const { files, skipped } = buildGroupedEbayCsvs(state.products, template, currentExportConfig(), groups);
    state.lastAiFiles = files;
    let downloaded = 0;
    for (const file of files) {
      downloadText(file.filename, file.csv);
      downloaded++;
    }
    // Bảng tóm tắt: tên nhóm + số sản phẩm + mã eBay (đã tự áp / chưa có
    // mã) + vài tên mẫu + xuất CSV.
    wrap.innerHTML = '<div id="aiGroupSummary"></div>';
    renderGroupSummary();
    // File nháp (v7) cho nhóm chưa có template: gợi ý danh mục bằng AI
    // (best-effort, chỉ khi có key AI) rồi xây file nháp; không có key thì
    // file nháp vẫn tạo được, chỉ thiếu gợi ý danh mục.
    let draftSuggestions = [];
    let draftSuggestionNote = '';
    if (state.aiStatus?.configured) {
      try {
        const res = await api('/api/ai/draft-categories', { method: 'POST', body: JSON.stringify({ groups: grouped.groups }) });
        draftSuggestions = res.suggestions ?? [];
        if (res.warnings?.length) draftSuggestionNote = res.warnings.slice(0, 2).join(' | ');
      } catch (err) {
        draftSuggestionNote = `AI gợi ý danh mục lỗi (${err.message}) — file nháp vẫn tải được, chỉ thiếu gợi ý danh mục.`;
      }
    }
    const { drafts, skipped: draftSkipped } = buildDraftGroupedCsvs(state.products, template, { ...currentExportConfig(), draftCategorySuggestions: draftSuggestions }, groups);
    if (draftSuggestions.length) {
      const { saved: ds, failed: df } = await saveDraftCategorySuggestions(state.products, grouped.assignments, draftSuggestions);
      if (ds) draftSuggestionNote += (draftSuggestionNote ? ' ' : '') + `Đã lưu gợi ý danh mục vào ${ds} sản phẩm${df ? `, ${df} lỗi` : ''}.`;
    }
    // Hai mục rõ ràng: (a) file upload được (đã tải ở trên), (b) file nháp
    // chưa upload được — mỗi nhóm 1 nút tải trong mục dưới.
    renderDraftSection(wrap, drafts, draftSuggestionNote);
    const noDraftSkipped = skipped.filter((s) => !drafts.some((d) => d.groupKey === s.key));
    const fileWarnings = files.flatMap((f) => f.warnings ?? []);
    status.textContent = `Xong: đã tải ${downloaded} file CSV (${files.reduce((n, f) => n + f.productCount, 0)} sản phẩm), ${files.filter((f) => f.needsReview).length} file còn mục cần kiểm tra` +
      (drafts.length ? `; ${drafts.length} file nháp cho ${drafts.reduce((n, d) => n + d.productCount, 0)} sản phẩm chưa có template (bấm nút tải trong mục File nháp bên dưới)` : '') +
      (noDraftSkipped.length ? `; chưa xuất được: ${noDraftSkipped.map((s) => `"${s.label}" (${s.productCount} sp): ${s.reason}`).join('; ')}.` : '.') +
      (draftSkipped.length ? ` ${draftSkipped.map((s) => `"${s.label}" (${s.productCount} sp): ${s.reason}`).join(' ')}` : '') +
      (fileWarnings.length ? ` Lưu ý: ${fileWarnings.join(' ')}` : '') +
      ` Đã lưu nhóm vào ${saved} sản phẩm trong tool${failed ? `, ${failed} sản phẩm lưu lỗi (version lệch/bỏ qua)` : ''}.`;
    status.className = downloaded || drafts.length ? 'ok' : 'error';
    renderBrowse();
    renderGroupList();
  } catch (err) {
    status.textContent = `AI phân loại lỗi: ${err.message}`;
    status.className = 'error';
  } finally {
    btn.disabled = false;
  }
});

// Nút "Tìm lại" cho từng nhóm trong bảng tóm tắt (event delegation
// vì bảng được vẽ lại sau mỗi lần AI phân loại).
$('aiGroupResults').addEventListener('click', async (event) => {
  const key = event.target?.dataset?.resolveEbay;
  if (!key) return;
  const groups = (state.lastAiGroups ?? []).filter((g) => g.key === key);
  if (groups.length) await resolveEbayGroups(groups);
});

loadAiStatus();
loadEbayStatus();
loadBootstrap();
