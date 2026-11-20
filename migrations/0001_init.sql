-- 0001_init.sql — Schema khởi tạo cho CSV Listing eBay (Cloudflare D1).
-- Áp bằng: npx wrangler d1 migrations apply csv-ebay-studio
-- (local: npx wrangler d1 migrations apply csv-ebay-studio --local)
-- Khớp HANDOFF mục 3: products lưu mỗi sản phẩm một dòng JSON, có version
-- chống ghi đè (trả 409 khi hai người cùng sửa); meta giữ cấu hình chung,
-- catalog template và danh sách lỗi crawl; api_keys giữ khóa crawl (chỉ hash).

CREATE TABLE IF NOT EXISTS products (
  id TEXT PRIMARY KEY,
  data TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  source_site TEXT,
  source_product_id TEXT,
  updated_at TEXT
);

CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS api_keys (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  key_hash TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  last_used_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_products_source_site ON products (source_site);
CREATE INDEX IF NOT EXISTS idx_products_source ON products (source_site, source_product_id);
CREATE INDEX IF NOT EXISTS idx_api_keys_hash ON api_keys (key_hash);
