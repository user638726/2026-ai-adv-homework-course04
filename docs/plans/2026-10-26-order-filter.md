# 2026-10-26 我的訂單篩選與分頁

來源：Issue #3（對應第四場作業 Issue C）。驗收測試：`tests/acceptance/order-filter.test.js`（助教提供，不得修改）。

## User Story

作為會員，我希望查詢自己的訂單時可以依付款狀態篩選並分頁，以便在訂單變多時快速找到想看的那一筆。

## Spec

### API 規格

`GET /api/orders`（需 JWT）新增三個選填 query 參數：

| 參數 | 說明 | 預設 | 限制 |
|------|------|------|------|
| `status` | `pending`、`paid` 或 `failed`，只回傳該狀態的訂單 | 不篩選 | 其他值一律 400 |
| `page` | 頁碼 | `1` | 正整數，否則 400 |
| `limit` | 每頁筆數 | `10` | 正整數，否則 400；超過 `50` 以 `50` 計 |

- 只回傳目前會員自己的訂單；排序為 `created_at` 由新到舊。`created_at` 只有秒級精度，同一秒建立的訂單以 `rowid` 由新到舊作為次要排序，讓頁與頁之間的順序穩定（與 `GET /api/admin/orders` 相同）。
- 回應沿用後台列表的格式：

  ```json
  { "data": { "orders": [ ... ], "pagination": { "page": 1, "limit": 10, "total": 12, "totalPages": 2 } }, "error": null, "message": "成功" }
  ```

  `orders` 內每筆的欄位不變；`totalPages = ceil(total / limit)`，沒有訂單時為 `0`。
- `page` 超過最後一頁：回 200，`orders` 為空陣列，`pagination` 仍照實回報（不報錯）。
- 錯誤（400）使用既有的 `VALIDATION_ERROR`，`data: null`。

### 與 `GET /api/admin/orders` 的差異

後台列表遇到不合法的 `status`、`page`、`limit` 是靜默退回預設值（`parsePagination`）；會員列表依規格改為回 400，因此**不沿用** `parsePagination`，另外提供嚴格版的解析函式。後台列表的行為不調整（Issue 明列不在範圍內）。

### 輸入驗證細節

- `page`、`limit` 只接受十進位數字字串（`^\d+$`）且 ≥ 1：`0`、`-1`、`1.5`、`abc`、空字串、`1e3`、重複的參數（`?page=1&page=2`，Express 解析成陣列）與巢狀物件（`?page[x]=1`）都是 400。
- `page` 上限沿用 `MAX_PAGE`（1,000,000），避免超大的 SQLite offset；`limit` 超過上限以上限計（規格要求，不是錯誤）。
- `status` 必須完全等於三個允許值之一；空字串、大小寫不同（`PAID`）、陣列都是 400。沒有帶 `status` 才表示不篩選。
- SQL 一律參數化；`WHERE` 子句只由固定字串組成，使用者輸入只會以 `?` 綁定。

### 分層

- 解析 `page`／`limit` 的純函式放 `src/utils/validators.js`（`parseStrictPagination`），不依賴 Express 與 DB。
- 查詢與計數放 `src/services/orderService.js` 的 `listOrdersForUser`（目前唯一的呼叫者是此路由，直接改成接受篩選與分頁，回傳 `{ orders, total }`）。
- 路由只做輸入驗證與組合回應。

### 前端

- `public/js/pages/orders.js` 原本讀 `res.data.orders`，新格式相容，不會壞。
- 預設每頁 10 筆，若不處理，超過 10 筆訂單的會員會默默看不到舊訂單。因此訂單頁加上最小的頁碼按鈕（沿用後台訂單頁的樣式與寫法），只在 `totalPages > 1` 時顯示。
- 篩選下拉選單不做（Issue 標示為選做且不在範圍內）。

### 不在本次範圍

- 後台訂單列表（`GET /api/admin/orders`）的調整，包含它對不合法參數的寬鬆處理。
- 依日期區間或關鍵字搜尋。
- 前端訂單頁的狀態篩選 UI。

## Tasks

- [ ] `parseStrictPagination` 與單元測試
- [ ] `listOrdersForUser` 支援狀態篩選與分頁
- [ ] `GET /api/orders` 驗證、查詢、回應格式
- [ ] API 測試（篩選、分頁、預設值、上限、400、隔離、排序穩定性）
- [ ] 前端訂單頁頁碼按鈕
- [ ] 執行 `test:unit`、`test:integration`、`test:acceptance -- order-filter`
- [ ] 更新 `docs/FEATURES.md`、`ARCHITECTURE.md`、`TESTING.md`、`CHANGELOG.md` 與 `openapi.json`
- [ ] 計畫移至 `docs/plans/archive/`
