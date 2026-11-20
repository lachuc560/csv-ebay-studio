"use strict";
(() => {
  // src/extract.ts
  var EXTRACTOR_VERSION = "0.9.2";
  function sourceFromHost(host) {
    const h = host.toLowerCase().replace(/\.$/, "");
    if (/(^|\.)aliexpress\.[a-z.]+$/.test(h)) return "AliExpress";
    if (/(^|\.)sohohome\.[a-z.]+$/.test(h)) return "SohoHome";
    if (/(^|\.)amazon\.[a-z.]+$/.test(h)) return "Amazon";
    if (/(^|\.)walmart\.[a-z.]+$/.test(h)) return "Walmart";
    if (/(^|\.)zoro\.[a-z.]+$/.test(h)) return "Zoro";
    if (/(^|\.)staples\.[a-z.]+$/.test(h)) return "Staples";
    if (/(^|\.)etsy\.[a-z.]+$/.test(h)) return "Etsy";
    if (/(^|\.)ebay\.[a-z.]+$/.test(h)) return "Ebay";
    return null;
  }
  function looksLikeGenericProductPage(hasJsonLd) {
    if (hasJsonLd) return true;
    if (meta("og:type").toLowerCase() === "product") return true;
    if (document.querySelector('link[href*="cdn.shopify.com"], script[src*="cdn.shopify.com"]') && /\/products\//.test(location.pathname)) return true;
    if (document.body.classList.contains("single-product") || document.querySelector(".woocommerce-product-gallery")) return true;
    return false;
  }
  function jsonLdProducts() {
    return [...document.querySelectorAll('script[type="application/ld+json"]')].flatMap((node) => {
      try {
        const parsed = JSON.parse(node.textContent || "null");
        return Array.isArray(parsed) ? parsed : [parsed];
      } catch {
        return [];
      }
    }).flatMap((item) => {
      if (!item || typeof item !== "object") return [];
      const graph = item["@graph"];
      if (Array.isArray(graph)) return graph;
      return [item];
    }).filter((item) => {
      const type = item["@type"];
      const text = Array.isArray(type) ? type.join(",") : String(type ?? "");
      return text.toLowerCase().includes("product");
    });
  }
  function textContent(selector) {
    return document.querySelector(selector)?.textContent?.replace(/\s+/g, " ").trim() || "";
  }
  function firstText(selector) {
    for (const node of document.querySelectorAll(selector)) {
      const text = node.textContent?.replace(/\s+/g, " ").trim() || "";
      if (text) return text;
    }
    return "";
  }
  function meta(name) {
    return document.querySelector(`meta[property="${name}"], meta[name="${name}"]`)?.getAttribute("content") || "";
  }
  function detectCurrency(value) {
    const v = value.toUpperCase();
    const code = (name) => new RegExp(`(^|[^A-Z])${name}(?![A-Z])`).test(v);
    if (/₫/.test(v) || code("VND")) return "VND";
    if (/(^|[^A-Z])(CA|C)\s?\$/.test(v) || code("CAD")) return "CAD";
    if (/(^|[^A-Z])(AU|A)\s?\$/.test(v) || code("AUD")) return "AUD";
    if (/(^|[^A-Z])NZ\s?\$/.test(v) || code("NZD")) return "NZD";
    if (/(^|[^A-Z])MX\s?\$/.test(v) || code("MXN")) return "MXN";
    if (/(^|[^A-Z])US\s?\$|\$/.test(v) || code("USD")) return "USD";
    if (/€/.test(v) || code("EUR")) return "EUR";
    if (/£/.test(v) || code("GBP")) return "GBP";
    if (/¥/.test(v) || code("JPY")) return "JPY";
    if (/₹/.test(v) || code("INR")) return "INR";
    if (/₩/.test(v) || code("KRW")) return "KRW";
    const iso = v.match(/(?:^|[^A-Z])(CHF|SEK|NOK|DKK|PLN|CZK|HUF|SGD|HKD|TWD|THB|MYR|PHP|IDR|BRL|ZAR|TRY|ILS|AED|SAR)(?![A-Z])/);
    return iso?.[1] ?? null;
  }
  function parsePrice(value) {
    if (typeof value === "number" && value > 0) return { price: value, currency: "USD" };
    if (typeof value === "string") {
      const numbers = value.replace(/,/g, "").match(/\d+(?:\.\d{1,2})?/g) || [];
      if (numbers.length !== 1) return null;
      const n = Number(numbers[0]);
      if (n > 0) {
        return { price: n, currency: detectCurrency(value) ?? "USD" };
      }
    }
    if (value && typeof value === "object") {
      const offer = value;
      const nested = parsePrice(offer.price ?? offer.lowPrice);
      if (nested) {
        const spec = Array.isArray(offer.priceSpecification) ? offer.priceSpecification[0] : offer.priceSpecification;
        const currency = offer.priceCurrency ?? spec?.priceCurrency ?? nested.currency;
        return { price: nested.price, currency: String(currency) };
      }
    }
    return null;
  }
  function pushUrl(urls, value) {
    if (typeof value === "string" && /^(?:https?:)?\/\//i.test(value)) {
      const absolute = value.startsWith("//") ? `https:${value}` : value;
      const clean2 = absolute.split("?")[0];
      if (/grey-pixel|transparent-pixel|\/spacer\.|\.gif$|\.thumbnail\.\d{6,}\./i.test(clean2)) return;
      if (clean2.startsWith("http")) urls.push(clean2.replace(/^http:\/\//i, "https://"));
    }
    if (value && typeof value === "object" && !Array.isArray(value)) {
      const record = value;
      pushUrl(urls, record.url ?? record.contentUrl ?? record.contentURL);
    }
    if (Array.isArray(value)) value.forEach((item) => pushUrl(urls, item));
  }
  function upgradeAmazonImage(url) {
    return url.replace(/\._[A-Z0-9,_-]+_\./, ".").replace(/\._[A-Z0-9,_-]+$/i, "");
  }
  function collectAmazonImages() {
    const urls = [];
    const landing = document.querySelector("#landingImage, #imgBlkFront, #main-image");
    pushUrl(urls, landing?.getAttribute("data-old-hires") || landing?.getAttribute("data-a-hires") || landing?.src);
    try {
      const dynamic = JSON.parse(landing?.getAttribute("data-a-dynamic-image") || "{}");
      Object.keys(dynamic).forEach((url) => pushUrl(urls, url));
    } catch {
    }
    document.querySelectorAll("#altImages img, #imageBlock img, li.item img").forEach((img) => {
      const el = img;
      const src = el.getAttribute("data-old-hires") || el.dataset.oldHires || el.src;
      if (src && !/PK[a-z-]*play|play-icon-overlay|\.SS\d+_PK/i.test(src)) pushUrl(urls, src);
    });
    return urls.map(upgradeAmazonImage);
  }
  function amazonSpecifics(target) {
    document.querySelectorAll("#productOverview_feature_div tr, #poExpander tr, #prodDetails table tr, #productDetails_techSpec_section_1 tr, #productDetails_detailBullets_sections1 tr").forEach((row) => {
      const cells = [...row.querySelectorAll(":scope > th, :scope > td")];
      if (cells.length >= 2) addSpecific(target, cells[0].textContent, cells.slice(1).map((cell) => cell.textContent).join(" "));
    });
    document.querySelectorAll("#detailBullets_feature_div li, #detailBulletsWrapper_feature_div li").forEach((item) => {
      const spans = [...item.querySelectorAll("span > span")];
      if (spans.length >= 2) addSpecific(target, spans[0].textContent?.replace(/[\u200e\u200f:]/g, ""), spans[1].textContent);
    });
    document.querySelectorAll("#productFactsDesktopExpander .product-facts-detail").forEach((row) => {
      addSpecific(target, row.querySelector(".a-col-left")?.textContent, row.querySelector(".a-col-right")?.textContent);
    });
  }
  function amazonVariants() {
    const groups = [];
    document.querySelectorAll('#twister [id^="variation_"]').forEach((dimension) => {
      const name = dimension.querySelector(".a-form-label")?.textContent?.replace(/[:：]\s*$/, "").trim();
      const values = [...dimension.querySelectorAll("li")].map((li) => li.querySelector("img")?.getAttribute("alt") || li.querySelector(".a-button-text, .swatch-title-text")?.textContent || li.getAttribute("title")?.replace(/^Click to select\s*/i, "") || "").map((v) => v.replace(/\s+/g, " ").trim()).filter(Boolean);
      if (name && values.length > 0) groups.push({ name, values: [...new Set(values)].slice(0, 100) });
    });
    document.querySelectorAll('[id^="inline-twister-row-"]').forEach((row) => {
      const name = row.querySelector('[id^="inline-twister-dim-title-"]')?.textContent?.split(/[:：]/)[0]?.replace(/\s+/g, " ").trim();
      if (!name || groups.some((g) => g.name === name)) return;
      const values = [...row.querySelectorAll("li")].map((li) => li.querySelector("img")?.getAttribute("alt") || li.querySelector(".swatch-title-text-display, .swatch-title-text")?.textContent || "").map((v) => v.replace(/\s+/g, " ").trim()).filter(Boolean);
      const selected = row.querySelector('[id^="inline-twister-expanded-dimension-text-"]')?.textContent?.replace(/\s+/g, " ").trim();
      const all = values.length > 0 ? values : selected ? [selected] : [];
      if (all.length > 0) groups.push({ name, values: [...new Set(all)].slice(0, 100) });
    });
    return groups.length ? groups : void 0;
  }
  function upgradeAliImage(url) {
    return url.replace(/_\d+x\d+(?:q\d+)?(?:\.(?:jpg|jpeg|png|webp))?_?(?:\.(?:avif|webp))?$/i, "");
  }
  function collectAliExpressImages() {
    const urls = [];
    document.querySelectorAll("img").forEach((img) => {
      const src = img.currentSrc || img.src;
      if (/alicdn\.com|ae-pic|aliexpress-media\.com/i.test(src) && (img.naturalWidth >= 120 || img.closest('[class*="slider"], [class*="image-view"], [class*="magnifier"]'))) pushUrl(urls, src);
    });
    document.querySelectorAll("script:not([src])").forEach((script) => {
      const json = script.textContent || "";
      if (!json.includes("imagePathList")) return;
      const matches = json.match(/https?:(?:\\\/\\\/|\/\/)[^"'\\\s]+(?:alicdn\.com|aliexpress-media\.com)[^"'\\\s]+/g) || [];
      matches.forEach((m) => pushUrl(urls, m.replace(/\\\//g, "/")));
    });
    return urls.map(upgradeAliImage);
  }
  function aliExpressVariants() {
    const groups = [];
    document.querySelectorAll('[class*="sku-item--title"], [class*="sku-item-title"]').forEach((title) => {
      const name = (title.textContent || "").split(/[:：]/)[0].replace(/\s+/g, " ").trim();
      const block = title.parentElement;
      if (!name || !block) return;
      const values = [...block.querySelectorAll('img[alt], [class*="sku-item--text"], [class*="sku-item-text"], [class*="sku-item--skus"] > div, [class*="sku-item--skus"] > span')].map((node) => (node.getAttribute("alt") || node.textContent || "").replace(/\s+/g, " ").trim()).filter((v) => v && v.length <= 80);
      if (values.length > 0) groups.push({ name, values: [...new Set(values)].slice(0, 100) });
    });
    return groups.length ? groups : void 0;
  }
  function aliExpressSpecifics(target) {
    document.querySelectorAll('[class*="specification--prop"], [class*="specification--property"], [class*="specification-item"]').forEach((row) => {
      const name = row.querySelector('[class*="specification--title"], [class*="specification-title"]')?.textContent;
      const value = row.querySelector('[class*="specification--desc"], [class*="specification-desc"]')?.textContent;
      if (name && value) addSpecific(target, name, value);
      else {
        const pieces = [...row.querySelectorAll(":scope > span, :scope > div")].map((node) => node.textContent?.replace(/\s+/g, " ").trim() || "").filter(Boolean);
        if (pieces.length >= 2) addSpecific(target, pieces[0], pieces.slice(1).join(" "));
      }
    });
  }
  function walmartData(root = document) {
    try {
      const raw = root.querySelector("#__NEXT_DATA__")?.textContent;
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      return parsed.props?.pageProps?.initialData?.data ?? null;
    } catch {
      return null;
    }
  }
  var WALMART_RELOAD_MESSAGE = "Walmart ch\u01B0a t\u1EA3i d\u1EEF li\u1EC7u c\u1EE7a s\u1EA3n ph\u1EA9m n\xE0y (th\u01B0\u1EDDng do m\u1EDF t\u1EEB trang t\xECm ki\u1EBFm). B\u1EA5m F5 \u0111\u1EC3 t\u1EA3i l\u1EA1i trang r\u1ED3i b\u1EA5m \u0110\u1ECDc l\u1EA1i trong popup.";
  function isWalmartDataForCurrentItem(data) {
    if (!data?.product) return false;
    const urlId = location.pathname.match(/\/(\d{5,})(?:\/|$)/)?.[1];
    const dataId = data.product.usItemId ? String(data.product.usItemId) : "";
    return !urlId || !dataId || dataId === urlId;
  }
  async function fetchCurrentPageHtml(href) {
    const response = await fetch(href, { credentials: "include", headers: { Accept: "text/html" } });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return response.text();
  }
  async function extractProductAsync(fetchHtml = fetchCurrentPageHtml) {
    if (sourceFromHost(location.hostname) !== "Walmart") return extractProduct();
    const current = walmartData();
    if (isWalmartDataForCurrentItem(current)) return extractProduct({ walmart: current });
    let fetched = null;
    try {
      const html = await fetchHtml(location.href);
      fetched = walmartData(new DOMParser().parseFromString(html, "text/html"));
    } catch {
      fetched = null;
    }
    if (!isWalmartDataForCurrentItem(fetched)) throw new Error(WALMART_RELOAD_MESSAGE);
    return extractProduct({ walmart: fetched });
  }
  function collectWalmartImages(data) {
    const urls = [];
    data?.product?.imageInfo?.allImages?.forEach((image) => pushUrl(urls, image.url));
    if (urls.length === 0) {
      document.querySelectorAll("img").forEach((img) => {
        const src = img.currentSrc || img.src;
        if (/walmartimages/i.test(src) && !/\.svg(?:$|\?)|\/dfw\//i.test(src) && img.naturalWidth >= 120) pushUrl(urls, src);
      });
    }
    return urls;
  }
  function collectZoroImages() {
    const urls = [];
    document.querySelectorAll("img").forEach((img) => {
      const src = img.currentSrc || img.src;
      if (/zoro\.com\/static\/cms\/product|scene7|cloudinary/i.test(src) && img.naturalWidth >= 120) pushUrl(urls, src);
    });
    return urls;
  }
  var ZORO_SIZE_RANK = { full: 5, large: 4, medium: 3, small: 2, petit: 1, thum: 1, email: 0 };
  function dedupeZoroSizes(urls) {
    const best = /* @__PURE__ */ new Map();
    const order = [];
    urls.forEach((raw) => {
      const url = raw.replace(/ /g, "%20");
      const match = url.match(/\/static\/cms\/product\/([a-z]+)\/([^/]+)$/i);
      if (!match) {
        if (!best.has(url)) {
          best.set(url, { url, rank: 0 });
          order.push(url);
        }
        return;
      }
      const key = `zoro:${match[2].toLowerCase()}`;
      const rank = ZORO_SIZE_RANK[match[1].toLowerCase()] ?? 0;
      const current = best.get(key);
      if (!current) {
        best.set(key, { url, rank });
        order.push(key);
      } else if (rank > current.rank) best.set(key, { url, rank });
    });
    return order.map((key) => best.get(key).url);
  }
  function upgradeStaplesImage(url) {
    return /staples-3p\.com\/s7\/is\/image\//i.test(url) ? `${url.split("?")[0]}?wid=1200&hei=1200` : url;
  }
  function collectStaplesImages() {
    const urls = [];
    document.querySelectorAll('[class*="image-gallery"] img, [class*="imageGallery"] img, [class*="product-image"] img').forEach((img) => {
      const el = img;
      const src = el.getAttribute("data-zoom") || el.getAttribute("data-src") || el.currentSrc || el.src;
      if (src && !/logo|banner|\/dfw\//i.test(src)) pushUrl(urls, src);
    });
    return urls;
  }
  function upgradeEtsyImage(url) {
    return url.replace(/il_(?:\d+x\d+|\d+xN)\./, "il_fullxfull.");
  }
  function collectEtsyImages() {
    const urls = [];
    document.querySelectorAll(".image-carousel-container img, ul.carousel-pane-list img, [data-carousel-pane] img").forEach((img) => {
      const el = img;
      pushUrl(urls, el.getAttribute("data-src") || el.currentSrc || el.src);
    });
    document.querySelectorAll("img").forEach((img) => {
      const src = img.currentSrc || img.src;
      if (/etsystatic\.com\/\d+\/r\/il\//i.test(src) && img.naturalWidth >= 120) pushUrl(urls, src);
    });
    return urls.map(upgradeEtsyImage);
  }
  function upgradeEbayImage(url) {
    return url.replace(/s-l\d+/g, "s-l1600").replace(/\.webp$/i, ".jpg");
  }
  function collectEbayImages() {
    const urls = [];
    document.querySelectorAll(".ux-image-carousel-item img, .ux-image-grid img, img").forEach((img) => {
      const el = img;
      const src = el.getAttribute("data-zoom-src") || el.getAttribute("data-src") || el.currentSrc || el.src;
      if (src && /ebayimg\.com\/(?:thumbs\/)?images\/g\//i.test(src) && (el.naturalWidth >= 120 || /data-zoom-src|s-l\d{3,}/.test(src))) {
        pushUrl(urls, src);
      }
    });
    return urls.map(upgradeEbayImage);
  }
  function upgradeShopifyImage(url) {
    return url.replace(/_(?:\d+x\d*|x\d+|pico|icon|thumb|small|compact|medium|large|grande|master)(?=\.(?:jpe?g|png|webp|gif))/i, "");
  }
  function isOtherProductTile(img) {
    const link = img.closest("a[href]");
    if (!link) return false;
    try {
      const target = new URL(link.getAttribute("href") || "", location.origin);
      const here = location.pathname.replace(/\/$/, "");
      return /\/products?\/|\/itm\/|\/dp\/|\/ip\/|\/listing\//i.test(target.pathname) && target.pathname.replace(/\/$/, "") !== here;
    } catch {
      return false;
    }
  }
  function collectWebsiteImages() {
    const urls = [];
    document.querySelectorAll(".woocommerce-product-gallery__image img, .product__media img, .product-gallery img, [data-product-media-type-image] img").forEach((img) => {
      const el = img;
      pushUrl(urls, el.getAttribute("data-large_image") || el.getAttribute("data-src") || el.currentSrc || el.src);
    });
    document.querySelectorAll("img").forEach((img) => {
      const src = img.currentSrc || img.src;
      if (/cdn\.shopify\.com|\/cdn\/shop\/(?:files|products)\/|\/wp-content\/uploads\//i.test(src) && img.naturalWidth >= 160 && !isOtherProductTile(img)) pushUrl(urls, src);
    });
    return urls.map(upgradeShopifyImage);
  }
  // ---- Soho Home: gallery đầy đủ, tối đa 12 ảnh (v9.6) ----
  // JSON-LD của Soho thường chỉ có 1 ảnh chính, gallery thật nằm trong
  // DOM (assets.sohohome.com, dạng cdn-cgi/image/.../images/original/...).
  // Cùng 1 ảnh ở nhiều crop khác nhau (trim/width khác nhau) thì chỉ
  // tính 1 lần: dedupe theo phần sau "/images/original/" (tên file gốc),
  // không dedupe theo URL CDN thô. Góc khác nhau (listing/hover/
  // lifestyle/detail1...) có tên file khác nhau nên vẫn giữ đủ.
  function sohoImageKey(url) {
    try {
      const u = new URL(String(url));
      const m = u.pathname.match(/\/images\/original\/(.+)$/i);
      if (m) return `soho-original:${decodeURIComponent(m[1]).toLowerCase()}`;
      return `soho-path:${u.origin}${u.pathname.toLowerCase()}`;
    } catch {
      return `soho-raw:${String(url).split("?")[0].toLowerCase()}`;
    }
  }
  function collectSohoHomeImages(fromLd) {
    const urls = [];
    const seen = new Set();
    const add = (value) => {
      const found = [];
      pushUrl(found, value);
      for (const u of found) {
        const key = sohoImageKey(u);
        if (seen.has(key)) continue;
        seen.add(key);
        urls.push(u);
      }
    };
    // 1. JSON-LD trước — ảnh listing chính đứng đầu.
    add(fromLd);
    document.querySelectorAll('meta[property="og:image"]').forEach((el) => add(el.getAttribute("content")));
    // The live product gallery uses figures in main. #related-products
    // contains other ranges, including unlinked images, so URL tests alone
    // cannot distinguish those images from this product's gallery.
    const excluded = (img) => isOtherProductTile(img) || img.closest('nav, header, footer, aside, #related-products, [class*="recommend"], [class*="related"], [class*="carousel-recs"], [id*="sponsored"], [class*="standard-tile"], [id*="onetrust"], [id*="cookie"], [class*="cookie"], [class*="consent"]');
    const gallery = [...document.querySelectorAll("main figure img")].filter((img) => !excluded(img));
    const candidates = gallery.length ? gallery : [...document.querySelectorAll("img")];
    // 2. Prefer the scoped gallery; retain older markup fallback when absent.
    candidates.forEach((img) => {
      const src = img.getAttribute("data-zoom-src") || img.getAttribute("data-src") || img.currentSrc || img.src;
      if (!src || !/sohohome\.com/i.test(src)) return;
      if (img.naturalWidth && img.naturalWidth < 400) return;
      if (excluded(img)) return;
      add(src);
    });
    // 3. Dự phòng: ảnh lớn khác trên trang (cùng luật loại trừ như
    // collectImages) — phòng khi gallery dùng CDN khác.
    if (urls.length < 12) {
      candidates.forEach((img) => {
        const src = img.currentSrc || img.src;
        if (src?.startsWith("https://") && img.naturalWidth >= 400 && !excluded(img)) add(src);
      });
    }
    return urls.slice(0, 12);
  }
  function collectImages(source, fromLd, walmart) {
    // v9.6: Soho Home có gallery riêng — JSON-LD chỉ có 1 ảnh chính nên
    // không dùng đường chung (đường chung chỉ lấy ld.image + og:image).
    if (source === "SohoHome") return collectSohoHomeImages(fromLd);
    const urls = [];
    pushUrl(urls, fromLd);
    document.querySelectorAll('meta[property="og:image"]').forEach((el) => pushUrl(urls, el.getAttribute("content")));
    if (source === "Amazon") urls.push(...collectAmazonImages());
    if (source === "AliExpress") urls.push(...collectAliExpressImages());
    if (source === "Zoro") urls.push(...collectZoroImages());
    if (source === "Walmart") urls.push(...collectWalmartImages(walmart));
    if (source === "Staples") urls.push(...collectStaplesImages());
    if (source === "Etsy") urls.push(...collectEtsyImages());
    if (source === "Ebay") urls.push(...collectEbayImages());
    if (source === "Website") urls.push(...collectWebsiteImages());
    if (new Set(urls).size < 4) {
      document.querySelectorAll("img").forEach((img) => {
        const src = img.currentSrc || img.src;
        if (src.startsWith("https://") && img.naturalWidth >= 400 && !isOtherProductTile(img) && !img.closest('nav, header, footer, aside, [class*="recommend"], [class*="related"], [class*="carousel-recs"], [id*="sponsored"], [class*="standard-tile"], [id*="onetrust"], [id*="cookie"], [class*="cookie"], [class*="consent"]')) {
          pushUrl(urls, src);
        }
      });
    }
    const normalized = urls.map((u) => {
      if (source === "Etsy") return upgradeEtsyImage(u);
      if (source === "Ebay") return upgradeEbayImage(u);
      if (source === "Website") return upgradeShopifyImage(u);
      if (source === "Amazon") return upgradeAmazonImage(u);
      if (source === "AliExpress") return upgradeAliImage(u);
      return u;
    });
    let unique = [...new Set(normalized.filter((u) => u.startsWith("https://")))];
    if (source === "Zoro") unique = dedupeZoroSizes(unique);
    if (source === "Staples") unique = unique.filter((u) => !/logo|banner|\/dfw\//i.test(u)).map(upgradeStaplesImage);
    return unique.slice(0, 12);
  }
  function amazonAsin() {
    return location.pathname.match(/\/(?:dp|gp\/product)\/([A-Z0-9]{10})/i)?.[1] || document.querySelector('#ASIN, input[name="ASIN"]')?.getAttribute("value") || document.querySelector("[data-asin]")?.getAttribute("data-asin") || "";
  }
  function aliItemId() {
    return location.pathname.match(/\/item\/(\d+)/)?.[1] || new URLSearchParams(location.search).get("itemId") || "";
  }
  function zoroId() {
    return location.pathname.match(/\/i\/(G\d+)/i)?.[1] || location.pathname.match(/\/(\d{4,})(?:\/|$)/)?.[1] || textContent('[data-za="product-sku"]').replace(/^Zoro\s*#\s*/i, "") || "";
  }
  function walmartId(data) {
    return data?.product?.usItemId || location.pathname.match(/\/(\d{5,})(?:\/|$)/)?.[1] || new URLSearchParams(location.search).get("itemId") || "";
  }
  function staplesId() {
    return location.pathname.match(/\/product[_-](\d+)/i)?.[1] || new URLSearchParams(location.search).get("productId") || textContent('[data-product-id], [itemprop="sku"]') || location.pathname.match(/\/(\d{5,})(?:\/|$)/)?.[1] || "";
  }
  function etsyListingId() {
    return location.pathname.match(/\/listing\/(\d+)/)?.[1] || "";
  }
  function ebayItemId() {
    return location.pathname.match(/\/itm\/(?:[^/]+\/)?(\d{9,})/)?.[1] || new URLSearchParams(location.search).get("item") || "";
  }
  function websiteId(sku) {
    const handle = sku || location.pathname.match(/\/products?\/([^/?#]+)/i)?.[1] || location.pathname.split("/").filter(Boolean).at(-1) || "trang-chu";
    const host = location.hostname.replace(/^www\./i, "");
    return `${host}:${handle}`.slice(0, 120);
  }
  function canonicalSourceProductId(source, sku, walmart) {
    if (source === "Website") return websiteId(sku);
    if (source === "Amazon") return amazonAsin() || sku;
    if (source === "AliExpress") return aliItemId() || sku;
    if (source === "Zoro") return zoroId() || sku;
    if (source === "Walmart") return walmartId(walmart) || sku;
    if (source === "Staples") return staplesId() || sku;
    if (source === "Etsy") return etsyListingId() || sku;
    if (source === "Ebay") return ebayItemId() || sku;
    return sku;
  }
  function etsyVariants() {
    const groups = [...document.querySelectorAll('select[id^="variation-selector"]')].map((sel) => ({
      name: document.querySelector(`label[for="${sel.id}"]`)?.textContent?.replace(/\s+/g, " ").trim() || sel.getAttribute("aria-label")?.trim() || sel.closest("div")?.querySelector("label")?.textContent?.replace(/\s+/g, " ").trim() || "Option",
      values: [...sel.querySelectorAll("option")].map((o) => o.textContent?.replace(/\s+/g, " ").trim() || "").map((v) => v.replace(/\s*\((?=[^)]*\d)[^)]*(?:₫|\$|€|£|¥|\b(?:USD|VND|EUR|GBP|CAD|AUD)\b)[^)]*\)\s*$/i, "").trim()).filter((v) => v && !/^(select|chọn)/i.test(v))
    })).filter((g) => g.values.length > 0);
    return groups.length ? groups : void 0;
  }
  function cssEscape(value) {
    return typeof CSS !== "undefined" && typeof CSS.escape === "function" ? CSS.escape(value) : value.replace(/["\\]/g, "\\$&");
  }
  var NON_VARIANT_SELECT = /quantity|qty|sort|per[-_ ]?page|page[-_ ]?size|language|lang\b|currency|country|region|ship[-_ ]?to|zip|postal|search|category|\bcat\b|gh-cat|locale|dropdownbox/i;
  function ebayVariants() {
    const groups = [];
    document.querySelectorAll(".x-sku, .x-msku__box-cont").forEach((box) => {
      const name = box.querySelector(".btn__label, .x-msku__label, label")?.textContent?.replace(/[:：]\s*$/, "").replace(/\s+/g, " ").trim();
      if (!name || NON_VARIANT_SELECT.test(name)) return;
      const values = [...box.querySelectorAll('[role="option"]')].map((option) => option.getAttribute("data-sku-value-name") || option.querySelector(".listbox__value")?.textContent || "").map((value) => value.replace(/\s+/g, " ").trim()).filter((value) => value && !/^select(ed)?$/i.test(value) && !/^select\s*selected$/i.test(value));
      if (values.length > 0) groups.push({ name, values: [...new Set(values)].slice(0, 100) });
    });
    return groups.length ? groups : void 0;
  }
  function productGroupVariants(variants) {
    const groups = /* @__PURE__ */ new Map();
    const add = (name, value) => {
      const text = compact(value);
      if (!name || !text || NON_VARIANT_SELECT.test(name)) return;
      const key = name.charAt(0).toUpperCase() + name.slice(1);
      if (!groups.has(key)) groups.set(key, /* @__PURE__ */ new Set());
      groups.get(key).add(text);
    };
    variants.slice(0, 200).forEach((variant) => {
      if (!variant || typeof variant !== "object") return;
      const item = variant;
      add("Size", item.size);
      add("Color", item.color);
      add("Material", item.material);
      add("Pattern", item.pattern);
      if (typeof item.url === "string") {
        try {
          new URL(item.url, location.origin).searchParams.forEach((value, key) => {
            if (!/^(variant|utm_|ref|_)/i.test(key)) add(key.replace(/[-_]+/g, " "), value);
          });
        } catch {
        }
      }
    });
    const result = [...groups.entries()].map(([name, values]) => ({ name, values: [...values].slice(0, 100) })).filter((group) => group.values.length > 0);
    return result.length ? result : void 0;
  }
  function collectVariants(ld, source, walmart) {
    if (source === "Etsy") return etsyVariants();
    if (source === "Ebay") {
      const fromSku = ebayVariants();
      if (fromSku) return fromSku;
    }
    if (source === "Amazon") return amazonVariants();
    if (source === "AliExpress") return aliExpressVariants();
    if (source === "Walmart" && walmart?.product?.variantCriteria?.length) {
      const groups2 = walmart.product.variantCriteria.map((criteria) => ({ name: criteria.name || "Option", values: (criteria.variantList || []).map((v) => v.name || "").filter(Boolean).slice(0, 100) })).filter((g) => g.values.length > 0);
      if (groups2.length) return groups2;
    }
    if (Array.isArray(ld.hasVariant) && ld.hasVariant.length > 0) {
      const grouped = productGroupVariants(ld.hasVariant);
      if (grouped) return grouped;
    }
    const groups = [...document.querySelectorAll("select")].filter((select) => !NON_VARIANT_SELECT.test(`${select.id} ${select.name} ${select.getAttribute("aria-label") || ""}`)).map((select) => ({
      name: select.getAttribute("aria-label") || (select.id ? document.querySelector(`label[for="${cssEscape(select.id)}"]`)?.textContent : null) || select.name,
      values: [...select.querySelectorAll("option")].map((option) => option.textContent?.replace(/\s+/g, " ").trim() || "").filter((value) => value && !/^(select|choose|chọn)/i.test(value))
    })).filter((group) => group.name && !NON_VARIANT_SELECT.test(group.name) && group.values.length > 1 && group.values.length <= 100);
    return groups.length ? groups.slice(0, 12) : void 0;
  }
  function compact(value) {
    if (Array.isArray(value)) return value.map(compact).filter(Boolean).join(", ");
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      return String(value).replace(/\s+/g, " ").trim();
    }
    if (value && typeof value === "object") {
      const record = value;
      return compact(record.name ?? record.value ?? record.text ?? record["@id"]);
    }
    return "";
  }
  var NON_SPECIFIC_NAME = /^(add to|buy now|quantity|qty|shipping|shipping cost|returns?|payments?|delivery|import charges|located in|item location|sold by|ships from|seller|seller notes|estimated|ship to|feedback|availability|price|sale price|see all|customer reviews|best sellers rank|list price|item price|estimated total|you save|next day delivery)$/i;
  var NON_SPECIFIC_VALUE = /opens in a new window|see details|learn more|estimated between|amount confirmed at checkout/i;
  function addSpecific(target, rawName, rawValue) {
    const name = compact(rawName).replace(/[:：]\s*$/, "").slice(0, 100);
    let value = compact(rawValue).slice(0, 400);
    value = value.replace(/^https?:\/\/schema\.org\//i, "");
    if (!name || !value || name.length < 2 || target[name]) return;
    if (NON_SPECIFIC_NAME.test(name) || NON_SPECIFIC_VALUE.test(value)) return;
    target[name] = value;
  }
  function specificationRows(value) {
    const list = Array.isArray(value) ? value : value && typeof value === "object" ? Object.values(value).find(Array.isArray) : null;
    if (!Array.isArray(list)) return [];
    return list.flatMap((item) => {
      if (!item || typeof item !== "object") return [];
      const record = item;
      const name = record.name ?? record.propertyID ?? record.attributeName ?? record.label ?? record.key;
      const val = record.value ?? record.valueReference ?? record.attributeValue ?? record.values;
      return name !== void 0 && val !== void 0 ? [{ name, value: val }] : [];
    });
  }
  function collectItemSpecifics(source, ld, walmart) {
    const result = {};
    addSpecific(result, "Brand", ld.brand);
    addSpecific(result, "MPN", ld.mpn);
    addSpecific(result, "Model", ld.model);
    addSpecific(result, "SKU ngu\u1ED3n", ld.sku);
    addSpecific(result, "UPC", ld.gtin12 ?? ld.upc);
    addSpecific(result, "EAN", ld.gtin13 ?? ld.ean);
    addSpecific(result, "GTIN", ld.gtin ?? ld.gtin8 ?? ld.gtin14);
    addSpecific(result, "Color", ld.color);
    addSpecific(result, "Material", ld.material);
    addSpecific(result, "Size", ld.size);
    addSpecific(result, "Condition", ld.itemCondition);
    specificationRows(ld.additionalProperty).forEach((row) => addSpecific(result, row.name, row.value));
    specificationRows(ld.specifications).forEach((row) => addSpecific(result, row.name, row.value));
    if (source === "Walmart" && walmart) {
      addSpecific(result, "Brand", walmart.product?.brand);
      addSpecific(result, "UPC", walmart.product?.upc);
      addSpecific(result, "Model", walmart.product?.model ?? walmart.product?.manufacturerProductId);
      specificationRows(walmart.idml?.specifications).forEach((row) => addSpecific(result, row.name, row.value));
    }
    if (source === "Amazon") amazonSpecifics(result);
    if (source === "AliExpress") aliExpressSpecifics(result);
    const rowSelectors = [
      '[data-testid="product-specifications"] tr',
      '[data-testid="item-details"] tr',
      ".product-specifications tr",
      ".specifications tr",
      ".product-specs tr",
      "#specifications tr"
    ].join(",");
    document.querySelectorAll(rowSelectors).forEach((row) => {
      const cells = [...row.querySelectorAll(":scope > th, :scope > td")];
      if (cells.length >= 2) addSpecific(result, cells[0].textContent, cells.slice(1).map((cell) => cell.textContent).join(" "));
    });
    if (source !== "Ebay") {
      document.querySelectorAll("dl").forEach((list) => {
        if (list.closest('footer, nav, header, [class*="footer"], [id*="footer"]')) return;
        list.querySelectorAll("dt").forEach((term) => {
          const value = term.nextElementSibling;
          if (value?.tagName === "DD") addSpecific(result, term.textContent, value.textContent);
        });
      });
    }
    if (source === "Ebay") {
      document.querySelectorAll('.ux-layout-section--features dt.ux-labels-values__labels, [data-testid="ux-layout-section-evo"] dt.ux-labels-values__labels').forEach((term) => {
        const value = term.nextElementSibling;
        if (value?.tagName !== "DD") return;
        addSpecific(result, term.textContent, value.querySelector('[data-testid="text"] .ux-textspans, .ux-textspans')?.textContent ?? value.textContent);
      });
    }
    document.querySelectorAll('.ux-layout-section--features .ux-labels-values, .ux-layout-section-evo__item .ux-labels-values, [data-testid="ux-layout-section-evo"] .ux-labels-values, .x-about-this-item .ux-labels-values').forEach((row) => {
      addSpecific(
        result,
        row.querySelector(".ux-labels-values__labels-content, .ux-labels-values__labels")?.textContent,
        row.querySelector(".ux-labels-values__values-content, .ux-labels-values__values")?.textContent
      );
    });
    if (source === "Ebay" && Object.keys(result).length < 3) {
      document.querySelectorAll(".ux-labels-values").forEach((row) => {
        addSpecific(
          result,
          row.querySelector(".ux-labels-values__labels-content, .ux-labels-values__labels")?.textContent,
          row.querySelector(".ux-labels-values__values-content, .ux-labels-values__values")?.textContent
        );
      });
    }
    return Object.fromEntries(Object.entries(result).slice(0, 100));
  }
  function siteTitle(source, walmart) {
    if (source === "Ebay") {
      return textContent("h1.x-item-title__mainTitle").replace(/^Details about\s*/i, "");
    }
    if (source === "Amazon") return textContent("#productTitle");
    if (source === "Walmart") return walmart?.product?.name || textContent("h1");
    if (source === "Website") {
      return textContent('h1.product_title, .product__title h1, h1[itemprop="name"]');
    }
    return "";
  }
  function sitePrice(source, walmart) {
    if (source === "Ebay") {
      const text = firstText(".x-price-primary .ux-textspans");
      return parsePrice(text.split(/\s+to\s+/i)[0]);
    }
    if (source === "Amazon") {
      return parsePrice(firstText("#corePrice_feature_div .priceToPay .a-offscreen, #corePriceDisplay_desktop_feature_div .priceToPay .a-offscreen, #apex_desktop .priceToPay .a-offscreen, .apexPriceToPay .a-offscreen, #corePrice_feature_div .a-offscreen, #corePriceDisplay_desktop_feature_div .a-offscreen, #apex_desktop .a-offscreen, #priceblock_ourprice, #priceblock_dealprice")) || parsePrice(firstText(".a-price .a-offscreen"));
    }
    if (source === "Walmart") {
      const current = walmart?.product?.priceInfo?.currentPrice;
      if (current?.price && current.price > 0) return { price: current.price, currency: current.currencyUnit || "USD" };
      return parsePrice(firstText('[data-seo-id="hero-price"], [itemprop="price"]'));
    }
    if (source === "Etsy") {
      return parsePrice(firstText('[data-buy-box-region="price"] .wt-text-title-larger, [data-buy-box-region="price"] p.wt-text-title-larger'));
    }
    if (source === "Website") {
      return parsePrice(textContent(".summary .price ins .woocommerce-Price-amount")) || parsePrice(textContent(".summary .price .woocommerce-Price-amount")) || parsePrice(textContent(".price__sale .price-item--sale, .price .price-item--regular"));
    }
    return null;
  }
  function siteDescription(source, walmart) {
    if (source === "Walmart") return walmart?.idml?.shortDescription || walmart?.idml?.longDescription || "";
    if (source === "Amazon") {
      return [...document.querySelectorAll("#feature-bullets li:not(.aok-hidden) .a-list-item, #productFactsDesktopExpander ul li .a-list-item")].map((li) => li.textContent?.replace(/\s+/g, " ").trim() || "").filter(Boolean).join("\n");
    }
    return "";
  }
  function lowestVariantOffer(variants) {
    if (!Array.isArray(variants)) return null;
    let best = null;
    variants.slice(0, 200).forEach((variant) => {
      const offers = variant?.offers;
      const offer = Array.isArray(offers) ? offers[0] : offers;
      if (!offer) return;
      const parsed = parsePrice(offer);
      if (parsed && (!best || parsed.price < best.price)) best = { offer, price: parsed.price };
    });
    return best ? best.offer : null;
  }
  function extractProduct(options = {}) {
    const ld = jsonLdProducts()[0] ?? {};
    let source = sourceFromHost(location.hostname);
    if (!source && looksLikeGenericProductPage(Object.keys(ld).length > 0)) {
      source = "Website";
    }
    if (!source) {
      throw new Error("Trang n\xE0y ch\u01B0a \u0111\u01B0\u1EE3c h\u1ED7 tr\u1EE3. M\u1EDF trang s\u1EA3n ph\u1EA9m c\u1EE7a AliExpress, Amazon, Walmart, Zoro, Staples, Etsy, eBay, Soho Home ho\u1EB7c website Shopify/Woo.");
    }
    const walmart = source === "Walmart" ? options.walmart ?? walmartData() : null;
    if (source === "Walmart" && !isWalmartDataForCurrentItem(walmart)) {
      throw new Error(WALMART_RELOAD_MESSAGE);
    }
    const offers = ld.offers;
    const offer = Array.isArray(offers) ? offers[0] : offers;
    const variantOffer = !offer && source === "Website" ? lowestVariantOffer(ld.hasVariant) : null;
    const preferSite = source === "Ebay" || source === "Amazon" || source === "Walmart";
    const price = (preferSite ? sitePrice(source, walmart) : null) || parsePrice(offer) || (variantOffer ? parsePrice(variantOffer) : null) || sitePrice(source, walmart) || parsePrice(meta("product:price:amount")) || parsePrice(firstText('[itemprop="price"]')) || parsePrice(firstText(".product-price, [data-price]"));
    const title = (siteTitle(source, walmart) || String(ld.name ?? meta("og:title") ?? document.title)).replace(/\s*\|\s*eBay\s*$/i, "").replace(/^Amazon\.com\s*:\s*/i, "").replace(/\s+/g, " ").trim();
    const preferSiteDescription = source === "Walmart" || source === "Amazon";
    const description = String((preferSiteDescription ? siteDescription(source, walmart) : "") || ld.description || meta("og:description") || siteDescription(source, walmart) || "").trim();
    const sku = String(ld.sku ?? ld.mpn ?? ld.productID ?? ld.gtin13 ?? "").trim();
    const sourceProductId = canonicalSourceProductId(source, sku, walmart) || location.pathname.split("/").filter(Boolean).at(-1) || location.pathname;
    if (!title || !price) {
      throw new Error("Kh\xF4ng \u0111\u1ECDc \u0111\u01B0\u1EE3c title/gi\xE1. Reload trang s\u1EA3n ph\u1EA9m r\u1ED3i th\u1EED l\u1EA1i.");
    }
    const images = collectImages(source, ld.image, walmart);
    if (images.length === 0) {
      throw new Error("Kh\xF4ng l\u1EA5y \u0111\u01B0\u1EE3c \u1EA3nh s\u1EA3n ph\u1EA9m.");
    }
    const itemSpecifics = collectItemSpecifics(source, ld, walmart);
    return {
      source,
      sourceProductId,
      sourceUrl: location.href.split("#")[0],
      title,
      description: description || void 0,
      price: price.price,
      currency: price.currency || "USD",
      images,
      variants: collectVariants(ld, source, walmart),
      itemSpecifics,
      raw: {
        jsonLd: ld,
        url: location.href,
        host: location.hostname,
        extractorVersion: EXTRACTOR_VERSION,
        capturedAt: (/* @__PURE__ */ new Date()).toISOString()
      }
    };
  }

  // src/csvRecord.ts
  var WALK_DELAY_MS = 450;
  var MAX_WALK_READS = 150;
  var sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  var clean = (value) => String(value ?? "").replace(/\s+/g, " ").trim();
  function isColorName(name) {
    return /colou?r/i.test(name);
  }
  function isSizeName(name) {
    return /\bsize\b/i.test(name) && !/size\s*type/i.test(name);
  }
  function splitOptions(options) {
    let size = null;
    let color = null;
    const extra = {};
    options.forEach(({ name, value }) => {
      if (!value) return;
      if (!color && isColorName(name)) color = value;
      else if (!size && isSizeName(name)) size = value;
      else extra[name] = value;
    });
    return { size, color, extra_options: Object.keys(extra).length ? extra : null };
  }
  function toVariant(raw, fallbackCurrency) {
    return {
      sku: raw.sku ?? null,
      // Keep original option names as well as the ingest compatibility fields.
      // The AI payload consumes options; size/color alone used to disappear.
      options: Object.fromEntries((raw.options ?? []).filter((o) => o.name && o.value).map((o) => [o.name, o.value])),
      ...splitOptions(raw.options),
      price: raw.price,
      compare_at_price: raw.compareAt ?? null,
      currency: raw.currency ?? fallbackCurrency,
      in_stock: typeof raw.inStock === "boolean" ? raw.inStock : null,
      stock_qty: raw.stockQty ?? null,
      upc: raw.upc ?? null,
      image: raw.image ?? null
    };
  }
  async function readShopify(fetchJson) {
    const handle = location.pathname.match(/\/products\/([^/?#]+)/)?.[1];
    if (!handle) return null;
    let product;
    try {
      const response = await fetchJson(`/products/${handle}.js`, { headers: { Accept: "application/json" } });
      if (!response.ok) return null;
      product = await response.json();
    } catch {
      return null;
    }
    if (!Array.isArray(product?.variants)) return null;
    const names = product.options.map((o) => typeof o === "string" ? o : o.name);
    const https = (url) => typeof url === "string" ? url.replace(/^\/\//, "https://").split("?")[0] : null;
    return {
      optionNames: names,
      productId: String(product.id),
      brand: product.vendor,
      description: product.description ? new DOMParser().parseFromString(product.description, "text/html").body.textContent?.replace(/\s+/g, " ").trim() || void 0 : void 0,
      hints: [product.type, ...product.tags ?? []].filter(Boolean).join(" "),
      images: (product.images ?? []).map(https).filter((x) => Boolean(x)),
      variants: product.variants.map((v) => ({
        options: [v.option1, v.option2, v.option3].flatMap((value, i) => value && names[i] && !(names[i] === "Title" && value === "Default Title") ? [{ name: names[i], value }] : []),
        // Shopify trả giá theo xu.
        price: v.price / 100,
        compareAt: v.compare_at_price ? v.compare_at_price / 100 : null,
        inStock: v.available,
        sku: v.sku || null,
        upc: v.barcode || null,
        image: https(v.featured_image?.src)
      }))
    };
  }
  function readWalmart() {
    let product;
    try {
      const raw = document.querySelector("#__NEXT_DATA__")?.textContent;
      product = JSON.parse(raw ?? "null")?.props?.pageProps?.initialData?.data?.product;
    } catch {
      return null;
    }
    const map = product?.variantsMap;
    const criteria = product?.variantCriteria;
    if (!map || !criteria?.length) return null;
    const names = /* @__PURE__ */ new Map();
    criteria.forEach((c) => (c.variantList ?? []).forEach((v) => {
      if (v.id) names.set(v.id, { name: c.name ?? "Option", value: clean(v.name) });
    }));
    const fallback = product?.priceInfo?.currentPrice?.price ?? null;
    const crumbs = (product?.category?.path ?? []).map((x) => clean(x.name)).filter(Boolean);
    return {
      optionNames: criteria.map((c) => c.name ?? "Option"),
      brand: typeof product?.brand === "string" ? product.brand : void 0,
      breadcrumb: crumbs,
      variants: Object.values(map).map((v) => ({
        options: (v.variants ?? []).flatMap((id) => names.get(id) ? [names.get(id)] : []),
        price: v.priceInfo?.currentPrice?.price ?? fallback,
        compareAt: v.priceInfo?.wasPrice?.price ?? null,
        currency: v.priceInfo?.currentPrice?.currencyUnit ?? "USD",
        inStock: v.availabilityStatus === "IN_STOCK",
        sku: v.usItemId ?? null,
        image: v.imageInfo?.allImages?.[0]?.url ?? null
      }))
    };
  }
  function sliceJsonObject(text, key) {
    const marker2 = `"${key}":{`;
    const start = text.indexOf(marker2);
    if (start < 0) return null;
    const open = start + marker2.length - 1;
    let depth = 0;
    let inString = false;
    for (let i = open; i < text.length; i++) {
      const c = text[i];
      if (inString) {
        if (c === "\\") i++;
        else if (c === '"') inString = false;
      } else if (c === '"') inString = true;
      else if (c === "{") depth++;
      else if (c === "}" && --depth === 0) {
        try {
          return JSON.parse(text.slice(open, i + 1));
        } catch {
          return null;
        }
      }
    }
    return null;
  }
  function inlineScriptWith(key) {
    for (const script of document.querySelectorAll("script:not([src])")) {
      if (script.textContent?.includes(key)) return script.textContent;
    }
    return null;
  }
  function readEbay() {
    const script = inlineScriptWith("variationCombinations");
    const msku = script ? sliceJsonObject(script, "MSKU") : null;
    if (!msku?.variationCombinations || !msku.variationsMap || !msku.menuItemMap || !msku.selectMenus) return null;
    const menuOf = /* @__PURE__ */ new Map();
    msku.selectMenus.forEach((menu) => (menu.menuItemValueIds ?? []).forEach((id) => menuOf.set(id, clean(menu.displayLabel))));
    const variants = [];
    Object.entries(msku.variationCombinations).forEach(([combo, variationId]) => {
      const data = msku.variationsMap[String(variationId)];
      if (!data) return;
      const options = combo.split("_").map(Number).flatMap((id) => {
        const item = msku.menuItemMap[String(id)];
        return item ? [{ name: menuOf.get(id) ?? "Option", value: clean(item.valueName ?? item.displayName) }] : [];
      });
      const money = data.binModel?.price?.value;
      variants.push({ options, price: money?.value ?? null, currency: money?.currency ?? "USD", inStock: data.quantity ? data.quantity.outOfStock !== true : null, sku: String(variationId) });
    });
    return { optionNames: msku.selectMenus.map((m) => clean(m.displayLabel)), variants };
  }
  function amazonInline(key) {
    const script = inlineScriptWith(`"${key}"`);
    const start = script?.indexOf(`"${key}"`) ?? -1;
    if (!script || start < 0) return null;
    const open = script.slice(start).search(/[[{]/) + start;
    const opener = script[open];
    const closer = opener === "{" ? "}" : "]";
    let depth = 0;
    let inString = false;
    for (let i = open; i < script.length; i++) {
      const c = script[i];
      if (inString) {
        if (c === "\\") i++;
        else if (c === '"') inString = false;
      } else if (c === '"') inString = true;
      else if (c === opener) depth++;
      else if (c === closer && --depth === 0) {
        try {
          return JSON.parse(script.slice(open, i + 1));
        } catch {
          return null;
        }
      }
    }
    return null;
  }
  function readAmazon(product) {
    const names = amazonInline("dimensionsDisplay");
    const values = amazonInline("dimensionValuesDisplayData");
    if (!Array.isArray(names) || !values || !Object.keys(values).length) return null;
    return {
      optionNames: names,
      estimated: true,
      variants: Object.entries(values).map(([asin, combo]) => ({
        options: combo.map((value, i) => ({ name: names[i] ?? "Option", value: clean(value) })),
        price: product.price,
        currency: product.currency,
        inStock: true,
        sku: asin
      }))
    };
  }
  async function walkChoices(getChoices, readPrice, readImage, readLastWithoutClick) {
    const variants = [];
    const names = getChoices().map((c) => c.name);
    let reads = 0;
    let truncated = false;
    const walk = async (depth, picked) => {
      const groups = getChoices();
      const group = groups[depth];
      if (!group) return;
      const isLast = depth === groups.length - 1;
      for (let i = 0; i < group.items.length; i++) {
        if (reads >= MAX_WALK_READS) {
          truncated = true;
          return;
        }
        const fresh = getChoices()[depth];
        const element = fresh?.items[i];
        if (!element) continue;
        const option = { name: group.name, value: fresh.label(element) };
        if (isLast && (readLastWithoutClick || fresh.disabled(element))) {
          const money = readPrice();
          variants.push({ options: [...picked, option], price: money?.price ?? null, currency: money?.currency ?? null, inStock: !fresh.disabled(element), image: readImage() });
          continue;
        }
        element.click();
        reads++;
        await sleep(WALK_DELAY_MS);
        if (isLast) {
          const money = readPrice();
          variants.push({ options: [...picked, option], price: money?.price ?? null, currency: money?.currency ?? null, inStock: true, image: readImage() });
        } else {
          await walk(depth + 1, [...picked, option]);
        }
      }
    };
    await walk(0, []);
    return { variants, truncated, names };
  }
  function moneyFromText(text) {
    const value = clean(text);
    if (!value) return null;
    const vnd = /₫|VND/i.test(value);
    const digits = (vnd ? value.replace(/[.,]/g, "") : value.replace(/,/g, "")).match(/\d+(?:\.\d{1,2})?/)?.[0];
    if (!digits || Number(digits) <= 0) return null;
    return { price: Number(digits), currency: vnd ? "VND" : /US\s?\$|\$|USD/i.test(value) ? "USD" : "USD" };
  }
  async function readAliExpress() {
    const getChoices = () => [...document.querySelectorAll('[class*="sku-item--property"]')].map((block) => ({
      name: clean(block.querySelector('[class*="sku-item--title"]')?.textContent).split(/[:：]/)[0] || "Option",
      items: [...block.querySelectorAll("[data-sku-col]")],
      // "L UK Size 12-14" là size L kèm bảng quy đổi của người bán.
      label: (el) => clean(el.querySelector("img")?.getAttribute("alt") || el.textContent).replace(/\s+(?:UK|US|EU|CN|AU)\s*Size\b.*$/i, ""),
      disabled: (el) => /soldOut|disabled/i.test(el.className)
    })).filter((group) => group.items.length > 0);
    if (!getChoices().length) return null;
    const result = await walkChoices(
      getChoices,
      () => moneyFromText(document.querySelector('[class*="price-default--current"], [class*="price--current"]')?.textContent ?? ""),
      () => {
        const src = document.querySelector('[class*="magnifier--image"], [class*="image-view"] img')?.src;
        return src ? src.replace(/_\d+x\d+[^/]*$/i, "") : null;
      },
      false
    );
    return { optionNames: result.names, variants: result.variants, truncated: result.truncated };
  }
  async function readSalesforce() {
    const getChoices = () => {
      const groups = [...document.querySelectorAll("[data-attr]")].map((block) => ({
        name: (block.dataset.attr ?? "Option").replace(/^./, (c) => c.toUpperCase()),
        items: [...block.querySelectorAll("[data-attr-value]")],
        label: (el) => clean(el.dataset.attrValue),
        disabled: (el) => /unselectable|disabled|out-of-stock/i.test(el.className) || el.getAttribute("aria-disabled") === "true"
      })).filter((group) => group.items.length > 0);
      return [...groups.filter((g) => !isSizeName(g.name)), ...groups.filter((g) => isSizeName(g.name))];
    };
    if (!getChoices().length) return null;
    const result = await walkChoices(
      getChoices,
      () => {
        const node = document.querySelector('.prices .sales .value, .price .sales .value, [itemprop="price"]');
        return moneyFromText(node?.getAttribute("content") ? `$${node.getAttribute("content")}` : node?.textContent ?? "");
      },
      () => document.querySelector('.primary-images img, [class*="product-image"] img, [class*="gallery"] img')?.src ?? null,
      true
    );
    return { optionNames: result.names, variants: result.variants, truncated: result.truncated };
  }
  function usefulCrumbs(items) {
    const title = clean(document.querySelector("h1")?.textContent).toLowerCase();
    return items.filter((text) => text && !/^home$/i.test(text) && text.toLowerCase() !== title).slice(0, 8);
  }
  function breadcrumbFromPage() {
    for (const node of document.querySelectorAll('script[type="application/ld+json"]')) {
      try {
        const parsed = JSON.parse(node.textContent || "null");
        const list = (Array.isArray(parsed) ? parsed : [parsed, ...parsed?.["@graph"] ?? []]).find((x) => x?.["@type"] === "BreadcrumbList");
        const items = list?.itemListElement;
        if (items?.length) return usefulCrumbs(items.map((x) => clean(x.name ?? x.item?.name)));
      } catch {
      }
    }
    return usefulCrumbs([...document.querySelectorAll('nav[aria-label*="readcrumb" i] a, .breadcrumb a, [class*="breadcrumb"] a, #wayfinding-breadcrumbs_feature_div a')].map((a) => clean(a.textContent)));
  }
  function findSpecific(specifics, pattern) {
    const key = Object.keys(specifics).find((name) => pattern.test(name));
    return key ? specifics[key] : null;
  }
  var WOMEN_ONLY_SITES = /(^|\.)(oglmove|eileenfisher)\.com$/i;
  function departmentFrom(title, breadcrumb, specifics, hints) {
    const stated = findSpecific(specifics, /^department$/i);
    if (stated) return stated;
    if (WOMEN_ONLY_SITES.test(location.hostname)) return "Women";
    const text = `${breadcrumb.join(" ")} ${title} ${hints}`.toLowerCase();
    const women = /\b(women|womens|women's|ladies)\b/.test(text);
    const men = /\b(men|mens|men's)\b/.test(text);
    if (women === men) return null;
    return women ? "Women" : "Men";
  }
  function compositionFrom(text) {
    return text.match(/\b\d{1,3}%\s+[A-Za-z][A-Za-z-]*(?:[ ,/&]+(?:and\s+)?\d{1,3}%\s+[A-Za-z][A-Za-z-]*)*/)?.[0] ?? null;
  }
  function availabilityFromOffer(offer) {
    const value = String(offer?.availability ?? "").split(/[\/#]/).at(-1).toLowerCase();
    if (value === "instock" || value === "limitedavailability") return true;
    if (["outofstock", "soldout", "discontinued"].includes(value)) return false;
    return null;
  }
  function buildCsvRecord(product, read) {
    const specifics = product.itemSpecifics ?? {};
    const breadcrumb = read?.breadcrumb?.length ? read.breadcrumb : breadcrumbFromPage();
    const offers = product.raw?.jsonLd?.offers;
    const offer = Array.isArray(offers) ? offers[0] : offers;
    const single = { options: [], price: product.price, currency: product.currency, inStock: availabilityFromOffer(offer) };
    const variants = (read?.variants.length ? read.variants : [single]).map((v) => toVariant(v, product.currency));
    return {
      source_site: location.hostname.replace(/^www\./i, ""),
      source_url: location.href.split("#")[0],
      // Mã của site, để cùng sản phẩm mở từ link màu khác nhau chỉ thành một dòng.
      source_product_id: read?.productId ?? product.sourceProductId.replace(/^[^:]+:/, ""),
      crawled_at: (/* @__PURE__ */ new Date()).toISOString(),
      brand: read?.brand ?? findSpecific(specifics, /^brand$/i),
      title: product.title,
      breadcrumb,
      department: departmentFrom(product.title, breadcrumb, specifics, read?.hints ?? ""),
      description_text: read?.description !== void 0 ? read.description : product.description || null,
      attributes: {
        material: findSpecific(specifics, /^(material|fabric|fabric type|outer shell material|exterior material)$/i) ?? compositionFrom(read?.description || product.description || ""),
        fit: findSpecific(specifics, /^fit( type)?$/i),
        care: findSpecific(specifics, /^care( instructions)?$/i),
        country_of_origin: findSpecific(specifics, /country|origin/i),
        dimensions: findSpecific(specifics, /^dimensions?$/i)
      },
      images: read?.images?.length ? read.images : product.images,
      options: read?.optionNames ?? [],
      variants,
      flags: { price_estimated: read?.estimated === true || !read?.variants.length },
      crawl_truncated: read?.truncated === true,
      specs: read?.sohoSpecs ?? void 0
    };
  }

  // ---- Soho Home (v1.1.0, thêm mới — site KHÔNG phải Shopify) ----
  // Trang thật đã kiểm 13/11/2026: JSON-LD schema.org/Product có offers.price
  // = GIÁ NON-MEMBER (bàn Cavern $1,470; thảm Catherine 200x200cm $2,450),
  // availability InStock. Giá Member rẻ hơn ~20% ($1,176 / $1,960): KHÔNG lấy.
  // "Regular Price $2,095" là giá gốc/compare-at. Size nằm trong tiêu đề
  // (", 200 x 200cm"); các size khác của thảm là TRANG RIÊNG (vd 170x240cm
  // có URL và giá riêng) — bulk crawl phải crawl từng URL, không gộp thành
  // biến thể của một trang. Không vượt captcha: đọc DOM/JSON-LD sẵn có.
  function sohoSizeFromTitle(title) {
    const dim = String(title ?? "").match(/(\d+\s*x\s*\d+\s*(?:cm|in|"))/i);
    if (dim) return dim[1].replace(/\s+/g, " ").trim();
    const bed = String(title ?? "").match(/\b(California King|King|Queen|Full|Twin)\b/i);
    return bed ? bed[1] : null;
  }
  function sohoDetailsText() {
    const tidy = (text) => {
      let value = String(text ?? '').replace(/\r/g, '').trim();
      value = value.replace(/^Details\s*&\s*Dimensions\s*/i, '');
      const end = value.search(/\b(?:Delivery\s*&\s*Returns|Add to basket|Explore the range|Notify me when available)\b/i);
      if (end >= 0) value = value.slice(0, end).trim();
      // A complete field such as "Dimensions\n50 x 50cm" can be shorter
      // than a sentence; the description's minimum length is checked later.
      return value.slice(0, 8000);
    };
    const panel = document.querySelector('#product-detail-extra-content');
    const scoped = tidy(sohoNodeText(panel));
    if (scoped) return scoped;
    // Older pages render details inline. Stop immediately at adjacent buttons;
    // never climb a parent container containing delivery/cart/related products.
    const text = document.body?.innerText ?? '';
    const start = text.search(/Details\s*&\s*Dimensions/i);
    return start < 0 ? '' : tidy(text.slice(start));
  }

  function sohoNodeText(node) {
    if (!node) return '';
    if (String(node.innerText ?? '').trim()) return node.innerText;
    if (!node.childNodes?.length) return node.textContent ?? '';
    const blocks = /^(?:P|DIV|SECTION|ARTICLE|DL|DT|DD|LI|UL|OL|TR|TH|TD|H[1-6]|BR)$/;
    const visit = (el) => el.nodeType === 3 ? el.textContent ?? '' :
      `${blocks.test(el.tagName ?? '') ? '\n' : ''}${[...(el.childNodes ?? [])].map(visit).join('')}${blocks.test(el.tagName ?? '') ? '\n' : ''}`;
    return visit(node).replace(/\n[ \t]*\n+/g, '\n').trim();
  }

  async function revealSohoDetails() {
    if (!/(^|\.)sohohome\.com$/i.test(location.hostname) || sohoDetailsText()) return;
    const button = [...document.querySelectorAll('button, [role="button"]')]
      .find((el) => /^Details\s*&\s*Dimensions$/i.test(clean(el.textContent)) && !el.disabled);
    if (!button || typeof button.click !== 'function') return;
    // If the user already opened the panel while its content is loading,
    // wait for that render instead of toggling the panel closed again.
    if (button.getAttribute?.('aria-expanded') !== 'true') button.click();
    // This only opens the product's information panel. No cart action or
    // private endpoint is involved; failed lazy loading leaves fields blank.
    for (let i = 0; i < 8; i++) {
      await sleep(250);
      const text = sohoNodeText(document.querySelector('#product-detail-extra-content'));
      if (Object.keys(sohoSpecsFromText(text)).length) return;
    }
  }
  function sohoSpecsFromText(text) {
    const LABELS = ["Dimensions", "Packaged dimensions", "Assembled size", "Base dimensions", "Weight", "Packaged weight", "Material", "Frame", "Composition", "Care instructions", "Assembly required", "Clearance", "Feet", "Marble type", "Handmade", "Pile", "Rug style", "Technique", "Bulb type", "Bulb", "Number of bulbs", "Bulb included", "Wattage", "Light source", "Dimmable", "Switch", "Cable length", "Cable colour", "Voltage", "Shade", "Base", "Bulb required", "Bulb style", "Bulb(s) included", "Electrician required", "Lighting Certification US", "IP Rating", "Bathroom safe"];
    const lines = String(text ?? "").split("\n").map((x) => x.trim()).filter(Boolean);
    const specs = {};
    for (let i = 0; i < lines.length; i++) {
      // Dạng "Nhãn: giá trị" trên cùng 1 dòng (vd "Dimensions: H49 x W34 x D34cm").
      const sameLine = lines[i].match(/^([^:]{2,40}):\s+(.+)$/);
      if (sameLine) {
        const label = LABELS.find((l) => l.toLowerCase() === sameLine[1].trim().toLowerCase());
        if (label && !specs[label]) specs[label] = sameLine[2].trim();
        continue;
      }
      const label = LABELS.find((l) => lines[i].replace(/:$/, "").toLowerCase() === l.toLowerCase());
      if (!label) continue;
      const vals = [];
      for (let j = i + 1; j < lines.length && vals.length < 3; j++) {
        if (LABELS.some((l) => lines[j].replace(/:$/, "").toLowerCase() === l.toLowerCase())) break;
        if (/^[^:]{2,40}:\s+.+/.test(lines[j]) && LABELS.some((l) => lines[j].split(":")[0].trim().toLowerCase() === l.toLowerCase())) break;
        vals.push(lines[j]);
      }
      if (vals.length) specs[label] = vals.join(" ").trim();
    }
    return specs;
  }
  function readSohoHome() {
    if (!/sohohome\.com$/i.test(location.hostname)) return null;
    const ld = jsonLdProducts()[0] ?? {};
    const offers = ld.offers;
    const offer = Array.isArray(offers) ? offers[0] : offers;
    const price = parsePrice(offer) ?? null;
    const details = sohoDetailsText();
    const specs = sohoSpecsFromText(details);
    const detailLines = details.split('\n');
    const specNames = Object.keys(specs);
    const firstSpec = detailLines.findIndex((line) => specNames.some((name) => line.trim().replace(/:$/, '').toLowerCase() === name.toLowerCase() || line.trim().toLowerCase().startsWith(`${name.toLowerCase()}:`)));
    const intro = (firstSpec >= 0 ? detailLines.slice(0, firstSpec).join(' ') : details).replace(/^Details & Dimensions\s*/i, '').trim();
    const title = String(ld.name ?? document.querySelector("h1")?.textContent ?? "");
    // v9.5: KHÔNG trả null chỉ vì thiếu giá JSON-LD — specs/mô tả/ảnh vẫn
    // có giá trị, server sẽ báo thiếu giá bằng warning thay vì mất hết dữ
    // liệu. Chỉ trả null khi trang không đọc được gì (không tiêu đề, không
    // giá, không panel Details) — vd trang danh mục, không phải trang sản phẩm.
    if (!price && !title.trim() && !details) return null;
    const size = sohoSizeFromTitle(title);
    // Compare-at = "Regular Price $X" đầu tiên trên trang, chỉ khi > giá hiện tại.
    const reg = (document.body?.innerText ?? "").match(/Regular Price\s*\$?\s*([\d,]+(?:\.\d{2})?)/i);
    const regVal = reg ? Number(reg[1].replace(/,/g, "")) : null;
    const compareAt = regVal && price && regVal > price.price ? regVal : null;
    const inStock = sohoProductUnavailable() ? false : availabilityFromOffer(offer);
    const parts = location.pathname.split("/").filter(Boolean);
    const prodIdx = parts.indexOf("products");
    const productId = prodIdx >= 0 ? parts.slice(prodIdx + 1).join("-") : parts.at(-1);
    // v9.6: KHÔNG chỉ lấy ld.image (thường chỉ 1 ảnh chính) — lấy đủ
    // gallery từ DOM qua collectSohoHomeImages (tối đa 12, ảnh listing
    // chính đứng đầu, cùng ảnh ở nhiều crop chỉ tính 1 lần).
    const images = collectSohoHomeImages(ld.image);
    const sku = String(ld.sku ?? ld.mpn ?? ld.productID ?? '').trim() || null;
    const color = sohoSelectedColor(ld, title, sku);
    const options = [...(color ? [{ name: 'Color', value: color }] : []), ...(size ? [{ name: 'Size', value: size }] : [])];
    const description = [intro, ld.description, meta('og:description')]
      .map((v) => clean(v).replace(/(?:^|\s+)Download\s+tearsheet\s*$/i, '').trim())
      .find((v) => v.length >= 20 && !/Delivery\s*&\s*Returns|Add to basket|Explore the range/i.test(v)) ?? null;
    return {
      optionNames: options.map((o) => o.name),
      productId,
      brand: "Soho Home",
      description,
      images,
      breadcrumb: breadcrumbFromPage(),
      hints: [specs.Material, specs.Frame].filter(Boolean).join(" "),
      variants: [{
        options,
        price: price?.price ?? null,
        compareAt,
        currency: price?.currency ?? "USD",
        inStock,
        // SKU CHỈ lấy từ JSON-LD (sku/mpn/productID). Trang Soho Home
        // không ghi SKU — dãy số trong tên file ảnh (vd 79971888 trong
        // 219687-79971888-listingjpg.jpg) KHÔNG phải SKU, tuyệt đối
        // không dùng làm SKU.
        sku,
        image: images[0] ?? null,
      }],
      sohoSpecs: specs,
    };
  }

  function sohoSelectedColor(ld, title, sku) {
    const stated = typeof ld.color === 'string' ? clean(ld.color) : '';
    if (stated) return stated;
    const here = location.pathname.replace(/\/$/, '');
    const base = here.replace(/\/\d+$/, '');
    let titleMatch = null;
    for (const link of document.querySelectorAll('main a[href]')) {
      if (link.closest('#related-products')) continue;
      let target;
      try { target = new URL(link.getAttribute('href'), location.origin); } catch { continue; }
      const path = target.pathname.replace(/\/$/, '');
      if (target.origin !== location.origin || path.replace(/\/\d+$/, '') !== base) continue;
      const label = clean(link.textContent);
      if (!label || label.length > 80) continue;
      const selected = sku && path.split('/').at(-1) === sku;
      const suffix = clean(title).toLowerCase().endsWith(`, ${label.toLowerCase()}`) || clean(title).toLowerCase().endsWith(` - ${label.toLowerCase()}`);
      // A concrete SKU match wins over an earlier link matching a stale
      // product-title suffix while the site's variant UI is updating.
      if (selected) return label;
      if (suffix && !titleMatch) titleMatch = label;
    }
    return titleMatch;
  }

  function sohoProductUnavailable() {
    const scope = document.querySelector('main') ?? document;
    for (const el of scope.querySelectorAll('p, [role="status"], button, [class*="stock"], [class*="availability"]')) {
      if (el.closest('#related-products, nav, footer, [hidden], [aria-hidden="true"]')) continue;
      if (typeof el.getClientRects === 'function' && !el.getClientRects().length) continue;
      const text = clean(el.innerText ?? el.textContent);
      if (text.length > 350) continue;
      if (/\b(?:discontinued|out of stock|sold out|currently unavailable|(?:this )?(?:product|item) is no longer available)\b/i.test(text)) return true;
    }
    return false;
  }
  async function extractCsvRecord(fetchJson = fetch.bind(globalThis)) {
    const product = await extractProductAsync();
    let read = null;
    if (product.source === "Walmart") read = readWalmart();
    else if (product.source === "Ebay") read = readEbay();
    else if (product.source === "Amazon") read = readAmazon(product);
    else if (product.source === "AliExpress") read = await readAliExpress();
    else if (product.source === "SohoHome") { await revealSohoDetails(); read = readSohoHome(); }
    else read = await readShopify(fetchJson) ?? await readSalesforce();
    return buildCsvRecord(product, read);
  }

  // ---- Crawl AI 1 trang (v9) ----
  // Thu thap du lieu tho cho server trich xuat bang AI: du lieu reader
  // (JSON-LD + bien the + gia non-member, xem extractCsvRecord) + doan
  // text hien thi cua trang (toi da ~12.000 ky tu, uu tien phan noi dung
  // chinh). Size/mau lay tu trang goc (reader + text) — server KHONG bia.
  function pageVisibleText(maxChars) {
    const limit = maxChars || 12000;
    const candidates = [
      document.querySelector("main"),
      document.querySelector("article"),
      document.querySelector("[role='main']"),
      document.body,
    ];
    for (const el of candidates) {
      const text = (el?.innerText ?? "").replace(/\s+/g, " ").trim();
      if (text.length > 500) return text.slice(0, limit);
    }
    return (document.body?.innerText ?? "").replace(/\s+/g, " ").trim().slice(0, limit);
  }
  async function extractAiPage(fetchJson = fetch.bind(globalThis)) {
    const record = await extractCsvRecord(fetchJson);
    let jsonLd = null;
    try {
      const raw = jsonLdProducts()[0] ?? null;
      if (raw) jsonLd = JSON.parse(JSON.stringify(raw, (k, v) => (typeof v === "string" && v.length > 2000 ? v.slice(0, 2000) : v)));
    } catch {
      jsonLd = null;
    }
    // v9.5: buildCsvRecord KHÔNG có field price/currency ở cấp record
    // (giá nằm ở từng variant) nên gửi thẳng record.price luôn là null —
    // đó là 1 lý do server tưởng trang không có giá (vd Fleur $315).
    // Lấy giá top-level từ biến thể: biến thể còn hàng rẻ nhất, rồi tới
    // biến thể đầu tiên có giá.
    const pricedVariants = (record.variants ?? []).filter((v) => Number.isFinite(Number(v?.price)) && Number(v.price) > 0);
    const inStockPriced = pricedVariants.filter((v) => v?.in_stock === true);
    const candidates = inStockPriced.length ? inStockPriced : pricedVariants;
    // Never compare amounts in different currencies to select the minimum.
    const currency = candidates[0]?.currency ?? "USD";
    const firstPriced = candidates.filter((v) => (v.currency ?? "USD") === currency)
      .reduce((best, v) => !best || Number(v.price) < Number(best.price) ? v : best, null);
    return {
      url: location.href.split("#")[0],
      sourceSite: location.hostname.replace(/^www\./i, ""),
      sourceProductId: record.source_product_id,
      brand: record.brand ?? null,
      title: record.title ?? null,
      price: firstPriced?.price ?? null,
      currency: firstPriced?.currency ?? "USD",
      compareAt: firstPriced?.compareAt ?? firstPriced?.compare_at_price ?? null,
      images: record.images ?? [],
      description: record.description_text ?? null,
      specs: record.specs ?? {},
      attributes: record.attributes ?? {},
      option_names: record.options ?? [],
      flags: record.flags ?? {},
      crawl_truncated: record.crawl_truncated === true,
      variants: (record.variants ?? []).map((v) => ({
        options: v.options ?? { ...(v.size ? { Size: v.size } : {}), ...(v.color ? { Color: v.color } : {}), ...(v.extra_options ?? {}) },
        size: v.size ?? null,
        color: v.color ?? null,
        extra_options: v.extra_options ?? null,
        sku: v.sku ?? null,
        upc: v.upc ?? null,
        price: v.price ?? null,
        compareAt: v.compareAt ?? v.compare_at_price ?? null,
        currency: v.currency ?? currency,
        in_stock: typeof v.in_stock === "boolean" ? v.in_stock : null,
        stock_qty: v.stock_qty ?? null,
        image: v.image ?? null,
      })),
      pageText: pageVisibleText(12000),
      jsonLd,
    };
  }

  // ---- So da ban tren listing eBay (v9) ----
  // Chi doc so "X sold" CONG KHAI tren trang listing eBay (tong ca
  // listing, khong chia mau/size). KHONG cao WatchCount, KHONG goi API
  // eBay seller. Tra {itemId, soldText} de popup parse so bang
  // CsvEbayCore.parseEbaySoldCount.
  function extractEbaySold() {
    if (!/ebay\./i.test(location.hostname)) return null;
    const parts = location.pathname.split("/").filter(Boolean);
    const itmIdx = parts.findIndex((p) => p.toLowerCase() === "itm");
    const candidates = itmIdx >= 0 ? parts.slice(itmIdx + 1) : parts;
    const itemId = candidates.find((p) => /^\d{9,}$/.test(p)) ?? null;
    const text = document.body?.innerText ?? "";
    const soldMatch = text.match(/[\d][\d.,]*\s*sold\b/i);
    return {
      url: location.href.split("#")[0],
      itemId,
      soldText: soldMatch ? soldMatch[0] : null,
    };
  }
  // src/content.ts
  var marker = globalThis;
  if (!marker.__csvStudioCrawler) {
    marker.__csvStudioCrawler = true;
    chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
      if (message?.type === "EXTRACT_AI_PAGE") {
        extractAiPage().then((page) => sendResponse({ ok: true, page })).catch((error) => sendResponse({ ok: false, error: error instanceof Error ? error.message : "Kh\xF4ng \u0111\u1ECDc \u0111\u01B0\u1EE3c trang \u0111\u1EC3 AI tr\xEDch xu\u1EA5t." }));
        return true;
      }
      if (message?.type === "EXTRACT_EBAY_SOLD") {
        try {
          const sold = extractEbaySold();
          if (!sold) sendResponse({ ok: false, error: "Trang n\xE0y kh\xF4ng ph\u1EA3i listing eBay." });
          else sendResponse({ ok: true, sold });
        } catch (error) {
          sendResponse({ ok: false, error: error instanceof Error ? error.message : "Kh\xF4ng \u0111\u1ECDc \u0111\u01B0\u1EE3c s\u1ED1 \u0111\xE3 b\xE1n." });
        }
        return true;
      }
      // EXTRACT_CSV da bo tu v9.2 (nut "Crawl trang nay" cu + crawl hang
      // loat + luong Sheet da xoa). extractCsvRecord van giu vi
      // extractAiPage dung chung no de lay du lieu reader.
      return;
    });
  }
})();
