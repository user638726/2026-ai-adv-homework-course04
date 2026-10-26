# AI 審查報告:訂單、付款、運費、購物車

> 本文件整理三個 agent 的審查結果,重點項目另由主 agent 在記憶體資料庫實測重現。**審查階段沒有修改任何程式碼、測試或設定**;之後的修正與本文件放在同一批 commit,各項的處理結果見第 11 節「修正狀態」。第 1 至 10 節描述的是修正前(`99d4869`)的狀況,「修正方向」是當時的建議。

| 項目 | 內容 |
|---|---|
| 審查日期 | 2026-10-26 |
| 審查基準 | `main` @ `99d4869`(已追蹤檔案與 HEAD 一致,僅有未追蹤的 `.claude/`) |
| 修正結果 | 27 項中已修正 12、部分修正 8、未處理 7;修正後 `test:unit` 242 項、`test:integration` 16 項全數通過(見第 2、11 節) |
| 範圍 | 訂單、付款(綠界 ECPay)、運費、購物車,以及相關測試、測試設定與 CI |
| 參與 agent | `security-reviewer`(權限、身分驗證、金流、輸入驗證)、`code-reviewer`(業務邏輯、規格符合度、邊界條件、測試品質)、`test-runner`(`test:unit`、`test:integration`) |
| 驗證方式 | 兩位審查者為純靜態閱讀;重點發現另行重現,方法與限制見附錄 A |

---

## 1. 摘要

**測試全綠,但綠燈不可靠。** `test:unit` 54 通過、1 略過,`test:integration` 10 通過,沒有失敗項目。被略過的那 1 項,正是會揭露免運門檻錯誤的 1,500 元邊界測試。下表前 4 項問題,現有測試都沒有涵蓋。

共 27 項發現:**Critical 1、High 4、Medium 9、Low 10、Info 3**。

### 最需要優先處理

| 順位 | ID | 問題 | 一句話說明 |
|---|---|---|---|
| 1 | F-01 | 購物車 PATCH 未驗證數量 | 傳 `quantity: 0.00390625`,即可用 NT$65 成立標價 NT$1,280 的訂單(已重現) |
| 2 | F-02 | `GET /api/orders/:id` 沒有擁有者檢查 | 任何會員都能讀到別人訂單的姓名、Email、地址(已重現) |
| 3 | F-03 | 免運門檻用 `>`,對應測試被 `it.skip` | 小計剛好 1,500 元仍收運費,與畫面、規格不符(已重現) |
| 4 | F-04 | Email 正則 O(n²) 回溯 | 一個未登入請求可卡住整個服務約 9.6 秒(已實測) |
| 5 | F-05 | 預設管理員帳密寫在程式碼 | 漏設 `ADMIN_PASSWORD` 就能用公開的預設密碼登入管理員 |

**處理結果**:F-01 至 F-04 已修正;F-05 在 `NODE_ENV=production` 時強制要求明確的管理員帳密,開發用的預設帳密維持不變(作業與驗收測試依賴它)。其餘項目見第 11 節。

### 驗證標記與嚴重度

| 標記 | 意思 |
|---|---|
| 重現 | 主 agent 在記憶體資料庫實際發出請求或呼叫函式,確認行為 |
| 讀碼 | 主 agent 自己讀過相關程式碼或規格並確認 |
| 靜態 | 僅審查者的靜態分析,尚未獨立驗證 |

| 嚴重度 | 定義 |
|---|---|
| Critical | 一般會員或匿名者可輕易利用,直接破壞金額或資料完整性,不需特殊前提 |
| High | 核心規則錯誤、越權存取,或單一請求即可癱瘓服務 |
| Medium | 需特定前提(部署設定、網路位置、多行程)才成立,或屬防護、測試缺口 |
| Low | 影響有限,屬穩健性或一致性問題 |
| Info | 資訊、文件不符,或日後實作需注意 |

合併兩位審查者的重複項目時取較高的嚴重度。唯一調整是 F-01:兩位審查者都評為 High,實測證實可把標價 NT$1,280 的訂單壓到 NT$65,且付款表單金額即為 65,因此升為 Critical。

---

## 2. 測試執行結果(test-runner)

| 指令 | 結果 | 耗時 |
|---|---|---|
| `npm run test:unit` | 7 個檔案;54 通過、1 略過、0 失敗;exit code 0 | vitest 4.08 秒 |
| `npm run test:integration` | 1 個檔案(`tests/integration/order-checkout.integration.test.js`);10 通過、0 失敗;exit code 0 | vitest 1.30 秒 |

- **略過的測試**:`tests/shipping.test.js:29` 的 `it.skip('商品小計 1,500 元時免基本運費')`。這是 `tests/` 內唯一一處 `.skip` / `.only` / `.todo` / `xit` / `xdescribe`,檔案內沒有註解說明原因。取消 skip 後會失敗(見 F-03)。
- **警告**:兩次執行都出現 `The CJS build of Vite's Node API is deprecated.`。`package.json` 沒有 `"type"` 欄位,而 `vitest.config.js` 使用 ESM 語法,與此警告相符,但成因未直接驗證。不影響結果。
- **副作用檢查**:測試前後 `git status --short` 與 `database.sqlite`(mtime 與大小)都沒有差異,符合「測試不得修改專案資料庫」的規定。
- **未執行**:`test:e2e`(會寫入開發 DB 並連綠界 staging)與 `test:acceptance`(不在這次要求內)。CI 也只跑 unit 與 integration,所以這兩者都不會攔到下列問題。

### 修正後

| 指令 | 結果 |
|---|---|
| `npm run test:unit` | 14 個檔案;**242 項全數通過**,0 失敗、0 略過 |
| `npm run test:integration` | 1 個檔案;**16 項全數通過**,0 失敗、0 略過 |

- 新增的測試先在修正前的程式碼上執行過:Unit 有 83 項失敗,每一項都對應到本報告的一個缺陷(包括「偽造的 admin 角色宣告可通過」);Integration 新增案例在修正前的程式碼上有 6 項失敗。確認測試有鑑別力之後才實作修正。
- 測試前後 `database.sqlite` 的修改時間與大小沒有變化。
- 未執行:`test:e2e`(連綠界 staging、寫入開發 DB)與 `test:acceptance`(助教提供、不得修改)。前端的訂單詳情橫幅修改(F-21)因此沒有瀏覽器層級的驗證。

---

## 3. 發現總表

| ID | 嚴重度 | 標題 | 主要位置 | 原始編號 | 驗證 |
|---|---|---|---|---|---|
| F-01 | Critical | 購物車 PATCH 未驗證數量,小數數量可低價下單 | `src/routes/cartRoutes.js:296-315` | CR-04、SEC-02 | 重現 |
| F-02 | High | `GET /api/orders/:id` 缺擁有者檢查 | `src/routes/orderRoutes.js:351` | CR-03、SEC-01 | 重現 |
| F-03 | High | 免運門檻 `>` 應為 `>=`,對應測試被 `it.skip` 掩蓋 | `src/utils/shipping.js:40`、`tests/shipping.test.js:29` | CR-01、CR-02、SEC-10 | 重現 |
| F-04 | High | Email 正則回溯,未登入可 ReDoS | `src/routes/authRoutes.js:111-112` | SEC-04 | 重現 |
| F-05 | High | 預設管理員帳密 fallback | `src/database.js:116-117` | SEC-03 | 重現 |
| F-06 | Medium | `isTradePaid` 缺 CheckMacValue 時略過驗簽 | `src/services/paymentService.js:15` | CR-05、SEC-05 | 重現 |
| F-07 | Medium | 付款流程缺口:無通知端點、無法重試、無取消與逾時 | `src/utils/ecpay.js:114`、`src/services/orderService.js:70` | CR-10、SEC-09 | 讀碼 |
| F-08 | Medium | 庫存檢查在 transaction 外,扣庫存無守衛 | `src/routes/orderRoutes.js:157-175`、`src/services/orderService.js:83` | CR-09 | 讀碼 |
| F-09 | Medium | 核心規則與安全行為缺測試 | `tests/` | CR-06、CR-07 | 讀碼、靜態 |
| F-10 | Medium | 多處斷言過弱或同義反覆 | `tests/orders.test.js:46-49` 等 | CR-08 | 部分讀碼 |
| F-11 | Medium | JWT 角色取自 token、無法撤銷、範例 secret | `src/middleware/authMiddleware.js:18-31` | SEC-06 | 讀碼 |
| F-12 | Medium | ECPay 設定預設值 fail-open | `src/utils/ecpay.js:3-8` | SEC-07 | 讀碼 |
| F-13 | Medium | 無速率限制與安全標頭,同步 bcrypt | `app.js`、`src/routes/authRoutes.js:138,236` | SEC-08、SEC-12 | 讀碼 |
| F-14 | Medium | 第三方腳本無 SRI,JWT 存 localStorage | `views/layouts/front.ejs:12`、`views/layouts/admin.ejs:15`、`public/js/auth.js:24-25` | SEC-11 | 讀碼 |
| F-15 | Low | `/ecpay/payment/:orderId` 無認證 | `src/routes/pageRoutes.js:61-72` | SEC-13 | 重現 |
| F-16 | Low | 頁面路由 500 回應洩漏伺服器路徑與模板原始碼 | `src/routes/pageRoutes.js:9,17`、`app.js:50` | SEC-14 | 重現 |
| F-17 | Low | 列表參數驗證不完整 | `src/routes/adminOrderRoutes.js:91-93` 等 | CR-12、SEC-15 | 重現 |
| F-18 | Low | 訂單編號僅 5 碼隨機,碰撞不重試 | `src/services/orderService.js:9` | CR-13、SEC-19 | 讀碼 |
| F-19 | Low | 資料庫約束與索引不足 | `src/database.js:22-88` | CR-16 | 讀碼 |
| F-20 | Low | 外部呼叫無逾時,async 錯誤處理不完整 | `src/utils/ecpay.js:160-164` 等 | CR-11、SEC-18 | 靜態 |
| F-21 | Low | 前端顯示與回應形狀不一致 | `views/pages/order-detail.ejs:10-16` 等 | CR-14、SEC-20 | 靜態 |
| F-22 | Low | 分層與重複邏輯 | `src/routes/*` | CR-15 | 靜態 |
| F-23 | Low | 測試隔離與穩定性 | `tests/setup/*` | CR-17 | 部分讀碼 |
| F-24 | Low | 帳號列舉、密碼政策、Email 大小寫 | `src/routes/authRoutes.js` | SEC-16 | 靜態 |
| F-25 | Info | 文件與實況不一致 | `docs/*.md` | CR-18、CR-19 | 部分讀碼 |
| F-26 | Info | 其他加固建議 | 多處 | SEC-17、SEC-21、SEC-22、SEC-23 | 靜態 |
| F-27 | Info | 無法以 git 比對驗收測試是否被改動 | `tests/acceptance/` | CR-20 | 讀碼 |

---

## 4. Critical 與 High

### F-01 [Critical] 購物車 PATCH 未驗證數量,小數數量可低價下單

- **位置**:`src/routes/cartRoutes.js:296-299`(只擋 `NaN`)、`:310-315`(只擋超過庫存後直接 UPDATE)。對照同檔 POST 在 `:195` 使用 `parsePositiveInteger`(`src/utils/validators.js:15`),它在全專案只被 POST 使用。
- **規格**:`docs/FEATURES.md:191,202` 要求 `quantity` 必須為正整數,否則 400 `VALIDATION_ERROR`。
- **成因**:程式碼是 `const qty = Number(quantity)`,只檢查 `Number.isNaN(qty)`。資料表 `cart_items.quantity` 是 `INTEGER ... CHECK(quantity > 0)`(`src/database.js:48`),不是 STRICT table,所以大於 0 的小數能通過並以 REAL 儲存。

**實測結果**(記憶體資料庫,同一個購物車項目):

| 輸入 `quantity` | 實際結果 | 規格預期 |
|---|---|---|
| `0`、`-1`、`null`、`""` | 500 `INTERNAL_ERROR`(`CHECK constraint failed: quantity > 0`) | 400 |
| `"abc"` | 400 | 400 |
| `"0x1F"`、`[2]`、`true` | 200,數量分別存成 31、2、1 | 400 |
| `1.5` | 200,存成 REAL。單價 890 的商品:購物車 `total` 1335、下單 `total_amount` 1455、庫存變成 97.5 | 400 |
| `0.00390625` | 200。單價 1,280 的商品:下單 `subtotal` 5、`shipping_fee` 60、`total_amount` 65 | 400 |

**價格竄改的完整路徑**(單價 1,280 的商品):

```
POST  /api/cart            {"productId": "<單價 1280 的商品>", "quantity": 1}
PATCH /api/cart/<itemId>   {"quantity": 0.00390625}                       -> 200
POST  /api/orders          (shippingMethod: convenience_store)             -> 201
      subtotal 5, shipping_fee 60, total_amount 65
      order_items.quantity = 0.00390625(REAL)
GET   /ecpay/payment/<orderId>  (不帶任何 token)                           -> 200
      <input type="hidden" name="TotalAmount" value="65">
商品庫存 10 -> 9.99609375(REAL)
```

- **影響**:任何註冊會員(免費)都能用極小的小數數量,以趨近於運費的金額買下任何商品,庫存幾乎不減。依 `src/services/paymentService.js:23` 的核對邏輯,以 65 元付款後 `TradeAmt` 與 `total_amount` 會一致,訂單即變為 paid。綠界實際是否接受這個金額未驗證。
- **另一個問題**:數量為 0、負數、空字串、`null` 時回 500,而規格是 400。PATCH 走 `dualAuth`,訪客用 `X-Session-Id` 也能呼叫。審查者另指出 `mergeGuestCart`(`src/routes/authRoutes.js:14-41`)會把訪客購物車的小數數量原樣併入會員購物車(靜態)。
- **修正方向**:
  1. PATCH 改用 `parsePositiveInteger`,錯誤訊息與 POST 一致。
  2. `createOrderFromCart` 的 transaction 內再斷言 `Number.isInteger(quantity) && quantity > 0`。
  3. 資料層加 `CHECK(typeof(quantity) = 'integer')` 或改 STRICT table,並檢查、清理既有資料。
  4. 補測試:PATCH 的 0、-1、1.5、極小小數、`'abc'`、`null`、`[]`、超庫存,以及他人的項目(見 F-09)。
- **原始編號**:CR-04(High)、SEC-02(High)。

### F-02 [High] `GET /api/orders/:id` 缺擁有者檢查(IDOR)

- **位置**:`src/routes/orderRoutes.js:350-364`(關鍵在 `:351` 的 `findOrderById(req.params.id)`),`src/services/orderService.js:21-27`。同檔的 `/pay` 與 `/check-payment` 都使用 `findOrderForUser(id, userId)`,只有這一支漏掉。
- **規格**:`docs/FEATURES.md:288-291`「僅能查看自己的訂單」「查詢條件含 `user_id`,他人訂單視為 404」。
- **重現**:
  1. Alice、Bob 各自註冊。Alice 加入購物車並建立訂單。
  2. Bob 用自己的 token 呼叫 `GET /api/orders/<Alice 的訂單 id>`:規格預期 404,**實際 200**,回應含 `recipient_name`、`recipient_email`、`recipient_address`、`total_amount`、`merchant_trade_no`。
  3. 作為對照,Bob 呼叫 `POST /api/orders/<id>/check-payment` 正確回 404。
- **影響**:任何已登入會員都能讀取他人訂單與個資。訂單 UUID 難猜,但它會出現在 `/orders/<id>` 網址、瀏覽器歷史、Referer、代理 log、`/ecpay/payment/<id>` 連結與傳給綠界的 `ClientBackURL`,不能當成秘密。
- **修正方向**:改用 `findOrderForUser(req.params.id, req.user.userId)`,不符時回 404。補跨使用者測試:`GET /api/orders/:id`、`PATCH /api/orders/:id/pay`、`POST /api/orders/:id/check-payment` 以他人 token 都應回 404(目前完全沒有,見 F-09)。
- **原始編號**:CR-03(High)、SEC-01(High)。

### F-03 [High] 免運門檻用 `>`,小計剛好 1,500 元仍收運費;對應測試被 `it.skip` 掩蓋

- **位置**:
  - 實作:`src/utils/shipping.js:39-41` 的 `return subtotal > SHIPPING_RATES.FREE_SHIPPING_THRESHOLD`(門檻 `:9` 為 1500)。
  - 被略過的測試:`tests/shipping.test.js:29-34`。
  - 前端與實作相反:`public/js/pages/checkout.js:28` 為 `if (cartTotal.value >= 1500) baseFee = 0`,`views/pages/cart.ejs:17` 為 `v-if="total < 1500"`(等於 1,500 時不再顯示「再買 NT$ … 即享免基本運費」)。
- **規格**:五處文件都寫「滿 1,500 元」:`docs/FEATURES.md:232`、`docs/README.md:70`、`docs/ARCHITECTURE.md:420`、`docs/CHANGELOG.md:73,86`。驗收測試 `tests/acceptance/coupon.test.js:74-77` 也要求折扣後剛好 1,500 元時免基本運費。
- **重現**:
  - `calculateShipping({ subtotal: 1499 / 1500 / 1501, method: 'home_delivery' })` 的運費為 120 / **120** / 0。
  - 端到端:單價 750 的商品買 2 件,購物車 `total` 為 1500,`POST /api/orders`(宅配、無附加費)回 `shipping_fee: 120`、`total_amount: 1620`。畫面顯示免運,實際多收 120 元,送給綠界的金額也是 1,620。
- **測試被掩蓋的細節**:
  - 被 skip 的測試預期 `qualifiesForFreeShipping === true` 且運費為 0,取消 skip 後會失敗。這是全專案唯一的 skip,沒有說明原因。
  - `git diff e1f39a0 99d4869 -- tests src` 為空,表示 skip 在初始 commit 就存在,無法由歷史判斷是誰、何時關掉的。
  - `docs/FEATURES.md:17`、`docs/README.md:83`、`docs/TESTING.md:16` 寫「55 項」、`docs/ARCHITECTURE.md:112` 寫 shipping「13 項」,都是含略過的總數,沒有註明其中 1 項被略過。`docs/DEVELOPMENT.md:53` 規定「邊界門檻與可累加條件應各有單元測試」,`docs/CHANGELOG.md` 也宣稱 shipping 測試涵蓋免運邊界。
  - `tests/orders.test.js:46-49` 用 `(productPrice >= 1500 ? 0 : 60) + 200 + 250` 計算期望運費,等於把規格改寫進測試,且只取 `products[0]` 的價格,碰不到 1,500 邊界(後者為審查者分析)。
- **修正方向**:
  1. 門檻判斷改為 `>=`,取消 `it.skip`。
  2. 補邊界測試:1,499 / 1,500 / 1,501,宅配與超商各一,含附加費組合。
  3. 前後端共用同一份門檻:例如由 API 回傳運費試算,或提供共用設定,避免前端複製規則(`checkout.js` 目前硬編 120 / 60 / 1500 / 200 / 250)。
  4. CI 加禁止 `.skip` 的檢查,例如 `vitest/no-disabled-tests` 或 grep 步驟。
  5. 文件的測試數量改以實際執行數為準。
- **原始編號**:CR-01(High)、CR-02(High)、SEC-10(Medium)。

### F-04 [High] Email 正則 O(n²) 回溯,未登入請求可 ReDoS

- **位置**:`src/routes/authRoutes.js:111-112`(`POST /api/auth/register`,不需登入)。審查者指出同一個正則也用在 `src/routes/orderRoutes.js:132-133`(需 JWT)。請求體上限是 `app.js:25` 的 `express.json()` 預設 100kb。
- **證據**:`/^[^\s@]+@[^\s@]+\.[^\s@]+$/`。`@` 之後的 `[^\s@]+` 與 `\.` 可互相重疊(`.` 也屬於該字元類別),輸入 `"a@" + "." × N + " "`(結尾空白讓 `$` 失敗)時,每個切分點都要把第三段吞完再逐一退回,總步數約 N²。
- **實測**:

  ```
  POST /api/auth/register   {"email": "a@" + 100000 個 "." + " ", "password": "123456", "name": "x"}
  請求體 100,046 bytes(上限 102,400)  ->  HTTP 400 VALIDATION_ERROR,耗時 9,565 ms
  ```

  僅正則的耗時(5k / 10k / 20k / 40k 個點)約 64 / 204 / 757 / 1,508 ms,大致隨長度平方成長;後續請求因 V8 已編譯正則而較快(20k 個點的註冊請求為 341 ms)。耗時依機器而異。
- **影響**:單一未登入請求讓 Node 的單一事件迴圈停擺近 10 秒,期間所有其他請求都無法處理;幾個並行請求即可持續癱瘓服務。
- **修正方向**:先限制長度(Email ≤ 254)再驗證格式,並改用不會重疊的規則(讓網域段不含 `.`)或成熟的驗證套件。各字串欄位(姓名、地址、備註等)也設最大長度。
- **原始編號**:SEC-04(High,待實測;已實測確認)。

### F-05 [High] 預設管理員帳密寫在程式碼

- **位置**:`src/database.js:116-117`:`process.env.ADMIN_EMAIL || 'admin@hexschool.com'`、`process.env.ADMIN_PASSWORD || '12345678'`。`.env.example:16-17` 照抄預設值,`docs/README.md:63` 的表格公開列出,`docs/DEVELOPMENT.md:164-165` 還標為「選填」。
- **重現**:未設定任何 `ADMIN_*` 環境變數時,`POST /api/auth/login {admin@hexschool.com, 12345678}` 取得 admin token,並成功呼叫 `GET /api/admin/orders`(200)。
- **影響**:部署時漏設或照抄 `.env.example`,任何人都能取得 7 天有效的管理員 JWT,可讀取全部訂單與個資、改價、改庫存、刪商品。登入端點沒有速率限制或鎖定(F-13),弱密碼也可被線上猜測。種子帳號只在首次建立,事後改環境變數不會更新密碼。
- **修正方向**:非 test 環境要求明確設定且達一定強度的 `ADMIN_EMAIL`、`ADMIN_PASSWORD`,否則啟動失敗;程式內不留預設值;`.env.example` 用占位值並加註;文件標明預設帳密「僅限本機開發」。
- **備註**:教學環境刻意提供預設值,實際風險取決於部署設定,但上線前必須處理。
- **原始編號**:SEC-03(High)。

---

## 5. Medium

### F-06 `isTradePaid` 缺 CheckMacValue 時略過驗簽(fail-open)

- **位置**:`src/services/paymentService.js:15`:`if (tradeInfo.CheckMacValue && !verifyCheckMacValue(...)) throw ...`。
- **規格**:`docs/FEATURES.md:380`「`TradeStatus === '1'` 時,先驗證回應的 CheckMacValue,並核對 `MerchantTradeNo`、`TradeAmt`」。
- **重現**:對 `isTradePaid(order, { TradeStatus: '1', MerchantTradeNo, TradeAmt })`(不帶 `CheckMacValue`)回傳 `true`;帶錯誤的 `CheckMacValue` 則丟出 `QueryTradeInfo CheckMacValue mismatch`。
- **影響**:一般使用者無法影響回應(網址固定為 HTTPS,`MerchantTradeNo` 由伺服器產生)。但任何能竄改或代答 QueryTradeInfo 回應的位置(TLS 被攔截、錯誤的 proxy 或 DNS、日後把 endpoint 改成可設定),只要省略 `CheckMacValue`,就能把任意 pending 訂單標成 paid。金流最關鍵的一道檢查應 fail-closed。
- **修正方向**:`TradeStatus` 為 `'1'` 時,缺少或不符簽章一律拋錯;同時核對回應的 `MerchantID`。補「缺簽章」與「`MerchantTradeNo` 不符」的測試(`tests/integration/order-checkout.integration.test.js:421-454` 只測了簽章被竄改與金額不符)。
- **原始編號**:CR-05(Medium)、SEC-05(Medium)。

### F-07 付款流程缺口:無通知端點、無法重試、無取消與逾時

- **位置**:`src/utils/ecpay.js:114`(`ReturnURL: baseUrl + '/ecpay/notify'`)、`src/services/orderService.js:70`(`merchant_trade_no` 固定)、`src/database.js:66`(狀態只有 `pending`、`paid`、`failed`)、`src/routes/adminProductRoutes.js:356-363`。
- **問題**:
  1. 全專案沒有 `/ecpay/notify` 路由(grep 確認),但付款表單仍把它送給綠界當 `ReturnURL`。`docs/FEATURES.md:371` 說明本專案運行於本地端、無法接收 Server Notify,所以改用 `check-payment` 主動查詢;一旦部署到公開網址,綠界通知會 404,使用者付款後若沒回站按「查詢」,訂單會永遠停在 pending。
  2. 每筆訂單的 `merchant_trade_no` 固定,`docs/FEATURES.md:367` 已列為已知限制:進入綠界頁面後沒付完,再次「前往付款」可能被綠界以重複編號拒絕,只能重新下單。
  3. `src` 內完全沒有 cancel 相關程式碼(grep 確認),也沒有逾時機制。建單即扣庫存,pending 訂單永久占用庫存;存在 pending 訂單的商品無法被後台刪除(`DELETE /api/admin/products/:id` 回 409)。
  4. 任何註冊會員(免費、無速率限制)都可以把每個商品庫存全部下單且永不付款,讓商品顯示已售完。
  5. 綠界回報未付款或失敗時,沒有任何路徑把訂單標為 `failed` 或回補庫存(審查者分析:`failed` 只能靠測試用的模擬端點到達)。
- **備註**:`tests/acceptance/cancel-order.test.js` 顯示取消功能是已規劃但尚未實作的 Issue,屬功能未完成而非回歸。
- **修正方向**:每次付款嘗試產生新的 `MerchantTradeNo`(保留對應表);實作通知端點(驗簽、核對金額、冪等);補取消與逾時回補庫存(transaction 內、僅 pending → cancelled、冪等);限制單一會員的 pending 訂單數。注意 `orders.status` 的 CHECK 約束不含 `cancelled`,SQLite 不能 ALTER CHECK,需要重建資料表(見 F-19)。
- **原始編號**:CR-10(Medium)、SEC-09(Medium)。

### F-08 庫存檢查在 transaction 之外,扣庫存無守衛

- **位置**:`src/routes/orderRoutes.js:157-175`(讀購物車與庫存檢查)、`src/services/orderService.js:83`(`UPDATE products SET stock = stock - ? WHERE id = ?`,沒有 `stock >= ?` 條件,也不檢查 `changes`)、`:86-109`(`db.transaction()`,預設為 deferred BEGIN)。
- **分析**:目前是單一 Node 行程加同步的 better-sqlite3,檢查與寫入之間沒有 `await`,所以不會交錯,**目前不會超賣**。多行程部署(PM2 cluster、多容器共用同一個檔案)或日後在其間加入任何 `await`,檢查與寫入之間就會出現競爭。此時資料層的 `CHECK(stock >= 0)`(`src/database.js:37`)會擋下並整筆回滾,資料是安全的,但使用者收到的是 500 `INTERNAL_ERROR`,而不是 `STOCK_INSUFFICIENT`。
- **附帶**:`cart_items` 沒有 UNIQUE 約束(F-19),若同一商品在購物車有多列,`findInsufficientItems` 逐列比較,合計超量時會漏檢(靜態)。
- **修正方向**:把讀購物車、庫存檢查與 `UPDATE ... WHERE id = ? AND stock >= ?`(檢查 `changes`)放進同一個 `db.transaction(...).immediate()`,不足時轉成 400 `STOCK_INSUFFICIENT`。多行程情境需要實際環境驗證。
- **原始編號**:CR-09(Medium)。

### F-09 核心規則與安全行為缺測試

以下行為目前沒有任何測試(完整對照見第 7 節)。其中第 1、2 項若有測試,就能分別攔下 F-02、F-01。

1. **跨使用者存取**:`GET /api/orders/:id`、`PATCH /api/orders/:id/pay`、`POST /api/orders/:id/check-payment` 以他人 token;購物車 PATCH / DELETE 他人項目;訪客 session 與會員購物車互相隔離;後台訂單詳情對一般會員 403、未登入 401(只有列表有 403 測試)。`tests/orders.test.js` 只用本人 token 讀自己的訂單。
2. **`PATCH /api/cart/:itemId` 的無效輸入**:`tests/cart.test.js` 只有一個正常路徑的 PATCH 案例(`:48`),沒有 0、-1、1.5、`'abc'`、`null`、超庫存。
3. **購物車其他規則**:POST 累加同商品與累加後超庫存、DELETE 不存在的項目、`dualAuth` 無認證或無效 token 回 401、`GET /api/cart` 的 `total` 數值(只驗屬性存在)。
4. **建單**:輸入驗證(無效 Email、`shippingMethod`、旗標非 boolean、缺欄位;目前只測 `recipientName` 非字串)、前端傳入 `totalAmount` / `shippingFee` 被忽略、多品項庫存不足列出全部、購買量剛好等於庫存、商品事後改價或刪除後訂單快照不變、transaction 回滾(只模擬第二筆 `order_items` 寫入失敗,扣庫存與清購物車失敗未測)。
5. **金流**:`check-payment` 的缺簽章、`MerchantTradeNo` 不符、`NO_TRADE_NO`、他人訂單、已 paid 重複查詢、逾時;ECPay 付款頁的非 pending 回 302、訂單不存在回 404、`ItemName` 超過 400 bytes 截斷。
6. **後台訂單**:paid / failed 篩選、非法 `status` 被忽略、`page` / `limit` 邊界、分頁數值(`pagination` 只驗 `toHaveProperty`)。
7. **認證與輸入邊界**:偽造、過期、`alg=none` 的 token;已刪除使用者的 token;被竄改 `role` 的 token;無效 Bearer 加有效 `X-Session-Id` 不降級;超長 Email 與 ReDoS 輸入;`page` 極大值或物件型;body 超過 100kb(413);XSS 輸出編碼;errorHandler 資訊洩漏。
8. **運費**:1,500 邊界(被 skip,見 F-03);`NaN`、`Infinity`、小數輸入。

- **原始編號**:CR-06(Medium)、CR-07(Medium),以及 security-reviewer 的「測試面向的安全缺口」。驗證:第 1、2 項已用 grep 確認,其餘為審查者靜態盤點。

### F-10 多處斷言過弱或同義反覆

| 位置 | 問題 |
|---|---|
| `tests/orders.test.js:46-49` | 期望運費寫成 `(productPrice >= 1500 ? 0 : 60) + 200 + 250`,把實作的分支規則重寫進測試,且只走單一分支(讀碼確認) |
| `tests/orders.test.js:64-81`、`:132-140` | 只驗 400 / 404、`data: null` 與 `toHaveProperty('error')`;屬性存在即通過,`error: null` 也會過,沒有驗 `CART_EMPTY` 等錯誤碼(靜態) |
| `tests/adminOrders.test.js:50-60` | for 迴圈逐筆斷言 `status === 'pending'`,但沒斷言結果非空,也沒有非 pending 的資料;篩選壞掉回傳 `[]` 照樣通過(靜態) |
| `tests/cart.test.js:27`、`:41` | `toHaveProperty('quantity')`、`toHaveProperty('total')` 只檢查屬性存在,不驗值(`:41` 讀碼確認,`:27` 靜態) |
| `tests/e2e/ecpay-atm-payment.spec.js:169-170` | `shipping_fee >= 0` 恆真;`total_amount === subtotal + shipping_fee` 對伺服器自算結果是同義反覆;沒有比對結帳頁或綠界頁的金額與 `total_amount`,F-03 這類問題正是這樣漏掉(靜態) |
| `tests/e2e/ecpay-atm-payment.spec.js:87` | 「付款成功」橫幅只要網址帶 `?payment=success` 就會出現(F-21),不能證明訂單已 paid(靜態) |

- **修正方向**:補精確的錯誤碼與數值斷言;篩選案例加上「非空」與「排除其他狀態」的斷言;期望值用固定的 fixture(例如價格 1,499 / 1,500 的商品),不要在測試內重寫實作的規則。
- **原始編號**:CR-08(Medium)。

### F-11 JWT 角色取自 token、無法撤銷、範例 secret

- **位置**:`src/middleware/authMiddleware.js:18-31` 只用 `SELECT id FROM users` 確認使用者存在,`role` 取自 `decoded.role`;`adminMiddleware` 只看 `req.user.role`。審查者另指出 `cartRoutes.js:17-26` 的 `dualAuth` 同樣如此、`.env.example:6` 的 `JWT_SECRET=your-jwt-secret-key-here` 是弱占位值、`server.js:5-9` 只檢查「有沒有設」而不檢查長度或是否為範例值(靜態)。
- **影響**:降權後舊 token 最長 7 天仍有原權限(目前沒有改角色的 API,屬潛在風險);沿用範例 secret 或 secret 外洩時,可簽發 `role: 'admin'` 的 token;token 沒有 `jti` 或版本號,無法撤銷。
- **修正方向**:`authMiddleware` 與 `dualAuth` 從 DB 讀 `role` 並以其為準;啟動時拒絕範例值或過短的 `JWT_SECRET`(例如小於 32 bytes);縮短期限,或加版本號以利撤銷。
- **已確認沒問題的部分**:驗證固定 `algorithms: ['HS256']`,沒有 `alg=none` 或演算法混淆;`JWT_SECRET` 沒有硬編碼 fallback;已刪除使用者的 token 回 401。
- **原始編號**:SEC-06(Medium)。

### F-12 ECPay 設定預設值 fail-open

- **位置**:`src/utils/ecpay.js:3-8`:`ECPAY_MERCHANT_ID` / `ECPAY_HASH_KEY` / `ECPAY_HASH_IV` 缺值時使用公開的 staging 測試值,`ECPAY_ENV` 預設為 `staging`。`docs/DEVELOPMENT.md` 將這些變數標為「選填」(審查者引用 `:167-170`)。
- **影響**:正式環境漏設 `ECPAY_ENV=production` 時,系統會靜默連到綠界 staging。顧客用公開的測試卡付款,staging 的 QueryTradeInfo 會回「已付款」,訂單被標成 paid 但實際沒收到錢。反過來,只設 `production` 卻漏設金鑰,會用公開測試金鑰打正式站(會失敗,但沒有明確的設定錯誤訊息)。這些測試值是綠界公開文件的值,不算憑證外洩。
- **修正方向**:`NODE_ENV=production` 時,`ECPAY_ENV` 與三個憑證都必須明確提供,否則啟動失敗;啟動時 log 目前的綠界環境。
- **原始編號**:SEC-07(Medium)。

### F-13 無速率限制與安全標頭,同步 bcrypt

- **位置**:`app.js:21-35`(只有 `cors`、`express.json`、`express.urlencoded`、`sessionMiddleware`,沒有 helmet 或 limiter;`package.json` 也沒有這些套件)、`src/routes/authRoutes.js:138`(`hashSync`)與 `:236`(`compareSync`)、`src/middleware/sessionMiddleware.js:2-4`(`X-Session-Id` 直接採用,沒有格式或長度驗證)。
- **影響**:
  1. 登入沒有鎖定,可對 admin 或任何帳號線上猜密碼(配合 F-05 最明顯)。
  2. cost 10 的 bcrypt 在主執行緒同步執行,大量註冊或登入就能佔滿事件迴圈。
  3. 訪客用隨機 `X-Session-Id` 反覆 `POST /api/cart`,可無限新增 `cart_items`,且沒有過期清理(靜態)。
  4. 已登入者可無限次呼叫 `check-payment`,每次都用我方 MerchantID 對綠界發 QueryTradeInfo,而 `fetch` 沒有逾時(F-20)(靜態)。
  5. 沒有 CSP、`X-Frame-Options`、`nosniff`、Referrer-Policy、HSTS,回應帶 `X-Powered-By: Express`,所有頁面(含 `/checkout`、`/admin/*`)可被任意網站 iframe。
- **修正方向**:登入、註冊、加入購物車、`check-payment` 分別設速率限制;改用非同步 `bcrypt.hash` / `bcrypt.compare`;驗證 `X-Session-Id` 的格式(UUID)與長度,並設每個 session 的品項上限與過期清理;使用 helmet(`/ecpay/payment` 頁含 inline script,需用 nonce 或改為外部腳本)並關閉 `x-powered-by`。
- **原始編號**:SEC-08(Medium)、SEC-12(Low)。

### F-14 第三方腳本無 SRI,JWT 存 localStorage

- **位置**:`views/layouts/front.ejs:12`、`views/layouts/admin.ejs:15` 載入 `https://unpkg.com/vue@3/dist/vue.global.prod.js`,版本浮動(`@3`)、沒有 `integrity` / `crossorigin`;`public/js/auth.js:24-25` 把 token 與 user 存在 `localStorage`。
- **影響**:unpkg 或套件遭竄改、劫持時,惡意程式可在前台與後台頁面讀取 token(含 admin token)並代送任何 API。JWT 有效 7 天且不可撤銷(F-11)。
- **修正方向**:自行託管並鎖定 Vue 版本,或固定精確版本加 SRI;搭配 CSP(`script-src 'self'`)。長期可考慮 HttpOnly + SameSite cookie 加 CSRF 防護。
- **備註**:審查者確認目前沒有 XSS sink(使用者字串都走 Vue 的 `{{ }}`,沒有 `v-html`),所以這屬供應鏈與縱深防禦風險。
- **原始編號**:SEC-11(Medium)。

---

## 6. Low 與 Info

| ID | 位置 | 問題 | 修正方向 |
|---|---|---|---|
| F-15 | `src/routes/pageRoutes.js:61-72` | **`/ecpay/payment/:orderId` 無認證、無擁有者檢查**(重現:不帶任何 token 即取得含 `TotalAmount` 的已簽章表單)。持有訂單 UUID 的人可取得表單,並可搶先以同一個 `MerchantTradeNo` 向綠界建立交易,讓買家本人之後被判重複(綠界實際行為未驗證)。UUID 不可猜的前提又被 F-02 削弱 | 要求登入並比對 `user_id`(例如由前端帶 Bearer 取得表單),或改發一次性短效 token |
| F-16 | `src/routes/pageRoutes.js:9,17`、`app.js:50` | **頁面路由繞過 errorHandler**:`res.status(500).send(err.message)`。重現:`GET /orders/some-id?payment[toString]=1`(Express 4 預設的 query parser 允許物件)讓 EJS 丟出例外,**500 回應內含伺服器絕對路徑 `/home/.../views/pages/order-detail.ejs:1` 與模板原始碼**,違反「500 一律回『伺服器內部錯誤』」的設計 | render 錯誤改走 `next(err)` 交給 errorHandler;`paymentResult` 先轉成白名單字串 |
| F-17 | `src/routes/adminOrderRoutes.js:91-93`、`src/routes/productRoutes.js:73-75`、`src/routes/adminProductRoutes.js:87-89` | **列表參數驗證不完整**(重現):`?page=99999999999999999999` 回 500(`datatype mismatch`),`/api/products` 與 `/api/admin/orders` 皆是;`?page[toString]=1` 回 500;`limit=0` 變 10、`limit=-3` 變 1、`limit=2abc` 變 2(規格 `docs/FEATURES.md:492` 為 1~100,但未定義越界行為,現況不一致)。另外 `ORDER BY created_at DESC` 只有秒級精度,同秒訂單的分頁順序不穩定(靜態) | `page` 加上限並先確認為 string;越界一律 400 或統一 clamp;排序加次要鍵(如 `rowid DESC`) |
| F-18 | `src/services/orderService.js:9` | **訂單編號後 5 碼取自 UUID 前 5 個十六進位字元**,每日只有 16^5 ≈ 104.9 萬種組合。依生日問題估算,日單量約 100 筆碰撞機率約 0.5%,1,000 筆約 38%,約 1,200 筆過半。`order_no` 為 UNIQUE(`src/database.js:55`),碰撞時整筆 transaction 回滾並回 500(推論);`merchant_trade_no` 由它衍生 | 加長編號、改用序號,或碰撞時重試 |
| F-19 | `src/database.js:22-88` | **資料庫防線不足**:沒有任何索引(`orders(user_id)`、`orders(status, created_at)`、`cart_items(user_id / session_id)`、`order_items(order_id)`);`cart_items` 沒有 UNIQUE(user_id, product_id) / (session_id, product_id);沒有 `order_items.quantity > 0`,也沒有 `total_amount = subtotal + shipping_fee` 的 CHECK;`ALTER TABLE ... ADD COLUMN merchant_trade_no` 的 `catch` 吞掉所有錯誤(`:84-88`),不只「欄位已存在」;`orders.status` 的 CHECK 不含 `cancelled`(`:66`);`shipping.js:26` 只檢查 `Number.isFinite`,不要求整數(與 `docs/DEVELOPMENT.md` 的「金額一律整數」不符);後台商品 `price` / `stock` 只檢查 `isInteger`,沒有上限(靜態) | 補索引與約束;`catch` 只忽略 duplicate column;把重建資料表列入取消功能的任務;運費與商品欄位加整數與上限檢查 |
| F-20 | `src/utils/ecpay.js:160-164`、`src/routes/orderRoutes.js:496-516`、`src/routes/pageRoutes.js:61-72` | **外部呼叫與 async 錯誤處理**(靜態):ECPay 查詢的 `fetch` 沒有逾時(undici 預設 300 秒),綠界變慢時 `check-payment` 與前端 `paying` 狀態會卡住;`check-payment` 是 Express 4 的 async handler,`findOrderForUser`、`getOrderItemSummaries` 在 `try` 之外,DB 例外(如 `SQLITE_BUSY`)會變成 unhandled rejection,Node 15 以上預設會讓行程結束;`merchant_trade_no` 為 NULL 的舊訂單仍會產生表單(`MerchantTradeNo=null`),`check-payment` 有防護但付款頁沒有 | `fetch` 加 `AbortSignal.timeout`;async handler 全部包進 try 或使用統一的 wrapper;付款頁檢查 NULL |
| F-21 | `views/pages/order-detail.ejs:10-16`、`views/pages/admin/orders.ejs:28,42`、`public/js/pages/order-detail.js:35` | **前端顯示與回應形狀不一致**(靜態):付款結果橫幅只看網址的 `payment` 參數,`/orders/<pending 訂單 id>?payment=success` 會顯示「付款成功!感謝您的購買。」而狀態徽章仍是「待付款」;後台「買家」欄顯示的是 `recipient_name`(收件人),不是下單會員;`POST /api/orders` 與 `check-payment` 回 `{product_name, product_price, quantity}`,詳情與後台回完整資料列,`order-detail.js:35` 把 check-payment 的 `data` 取代 `order` 後 `item.id` 為 undefined | 橫幅改依 `order.status`;修正欄名或資料來源;統一 `items` 形狀 |
| F-22 | `src/routes/orderRoutes.js:460`、`:178-180`;`src/routes/cartRoutes.js:10-47,108-115`;`src/routes/authRoutes.js:14-41` | **分層與重複邏輯**(靜態):`/pay` 路由內直接寫 UPDATE,與 `paymentService.markOrderPaid` 各有一份狀態轉換;subtotal 在路由計算;購物車 JOIN SQL 在 `cartRoutes.js` 與 `orderService.getCheckoutItems` 重複;`adminOrderRoutes.js` 直寫 SQL;`mergeGuestCart` 的購物車 SQL 放在認證路由檔;`dualAuth` 與 `authMiddleware` 的 JWT 驗證邏輯重複;`createOrderFromCart` 信任呼叫端傳入的 subtotal 與 shipping,沒有檢查 `shipping.subtotal === subtotal` | 抽出 service,狀態轉換只留單一入口 |
| F-23 | `tests/setup/testEnvironment.js:1-9`、`tests/setup/integrationGlobalSetup.mjs:29-38`、`tests/orders.test.js` | **測試隔離與穩定性**:`testEnvironment.js` 固定了 `JWT_SECRET`、`DATABASE_PATH` 等,但沒有固定 `ADMIN_EMAIL` 與 `ADMIN_PASSWORD`(讀碼確認),而 `app.js:1` 的 `dotenv.config()` 會載入開發者的 `.env`,一旦把 `ADMIN_PASSWORD` 改成非 `12345678`,所有 `getAdminToken()` 與驗收測試都會連鎖失敗;integration 以雜湊、大小與 mtime 守衛 `database.sqlite`,若開發伺服器或 E2E 同時寫入(WAL checkpoint 也會改檔案)會誤判成「測試修改了 DB」;`orders.test.js` 的案例依序依賴前一案,第一案失敗會連鎖誤報(後兩者為靜態) | 測試環境固定這兩個變數;守衛排除外部寫入;案例各自建立所需資料 |
| F-24 | `src/routes/authRoutes.js:120,128-135,138,227-243` | **帳號列舉、密碼政策、Email 大小寫**(靜態):註冊已存在的 Email 回 409 可列舉帳號;登入時 Email 不存在會立即回應、存在才跑 bcrypt,回應時間可區分;密碼只要求 ≥ 6 字元、無上限,bcrypt 只取前 72 bytes;Email 區分大小寫,`Admin@hexschool.com` 可註冊成獨立的一般帳號 | 不存在的使用者也做一次假的 bcrypt 比對;Email 正規化(trim 加 lowercase)後再當唯一鍵;設密碼長度上下限 |
| F-25 | `docs/FEATURES.md:17`、`docs/README.md:83`、`docs/TESTING.md:16`、`docs/ARCHITECTURE.md:112`、`README.md:58` 等 | **文件與實況不一致**:測試數量「55 項」「13 項」是含略過的總數,沒說明有 1 項被略過(F-03);「驗收測試在 `main` 上預期失敗」(`README.md:58`、`docs/README.md:94`、`docs/TESTING.md:48`)與審查者的推導不完全相符,推導有 3 項會空洞通過(`tests/acceptance/cancel-order.test.js:81-91`、`:93-100`、`tests/acceptance/order-filter.test.js:49-60`,未實跑確認);`docs/DEVELOPMENT.md:16-17` 的命名規則有例外(Request 的 `image_url`、pagination 的 `totalPages`);seed 商品「季節鮮花訂閱(月配)」文案寫「訂閱期間享免運優惠」(`src/database.js:185`),運費模組沒有對應規則;`src/middleware/errorHandler.js:11-16` 的 `ERROR_CODES` 沒有 413 / 422 / 429,會落成 `VALIDATION_ERROR`;取消功能的驗收要求 409,但現有 `/pay` 的狀態衝突是 400 `INVALID_STATUS`,實作時需決定並同步更新錯誤碼對照表 | 以實際數字更新文件;實跑 `npm run test:acceptance` 確認空洞通過的項目 |
| F-26 | 多處 | **其他加固建議**(靜態):模擬付款端點只靠 `NODE_ENV === 'test'` 單一開關(`orderRoutes.js:24-30`),同一旗標也把 bcrypt cost 降為 1(`authRoutes.js:10`、`database.js:121`),誤設會讓會員自助標記已付款;偏遠地區與急件旗標由使用者自行勾選,伺服器未依地址驗證(營收洩漏,屬業務規則);`npm start` 執行 `npx @tailwindcss/cli`(`package.json:6,9`),缺 devDependencies 時會在啟動時從 registry 下載並執行;CI actions 以 tag 而非 commit SHA 固定,也沒跑 `npm audit`;沒有稽核日誌(登入失敗、付款狀態轉換、admin 操作) | 依部署需求逐項評估 |
| F-27 | `tests/acceptance/` | **無法以 git 比對驗收測試是否被改動**:專案只有兩個 commit,第二個只改了 `package-lock.json`(`git diff --stat e1f39a0 99d4869`),所以驗收測試與初始 commit 相同,但沒有助教原版可比對。以現況內容看,沒有 skip,也沒有被註解掉的案例 | 與助教提供的版本對照確認 |

---

## 7. 測試覆蓋矩陣

由 code-reviewer 靜態盤點,「購物車 PATCH 無效數量」與「訂單詳情擁有者」兩列另以 grep 與讀碼確認過。`integration` 指 `tests/integration/order-checkout.integration.test.js`。

| 規則 / 行為 | 有測試? | 備註 |
|---|---|---|
| 基本運費(宅配 120 / 超商 60) | 有 | `shipping.test.js` |
| 免運:1,499 仍收費 | 有 | `shipping.test.js` |
| 免運:剛好 1,500 | **無(`it.skip`)** | `shipping.test.js:29`;見 F-03 |
| 免運:2,000(兩種配送方式) | 有 | `shipping.test.js` |
| 附加費疊加、滿額仍收附加費 | 有 | `shipping.test.js` |
| 運費模組輸入驗證 | 部分 | 負數、配送方式、旗標型別有;`NaN`、`Infinity`、小數沒有 |
| 建單金額後端重算 | 有 | `orders.test.js`、integration |
| 建單輸入驗證 | 部分 | 只有 `recipientName` 非字串(`orders.test.js:142`) |
| 前端傳入金額被忽略 | 無 | |
| 空購物車 `CART_EMPTY` | 部分 | 未驗錯誤碼(`orders.test.js:64`) |
| 庫存不足(單一商品) | 有 | integration:252 |
| 庫存不足(多品項列出全部)、購買量剛好等於庫存 | 無 | |
| 建單 transaction 回滾 | 部分 | 僅模擬第二筆 `order_items` 寫入失敗(integration:276) |
| 品項快照 | 部分 | 建單當下有;事後改價、改名、刪商品無 |
| 扣庫存、清購物車 | 有 | integration:145 |
| 訂單詳情擁有者(他人 404) | **無** | 實作也缺(F-02) |
| 訂單列表僅本人 | 無 | 僅驗收測試,功能未實作 |
| 狀態機 pending → paid / failed 不可逆 | 部分 | `orders.test.js:177`;failed 後再操作無 |
| `/pay` 僅 test 環境 | 有 | `orders.test.js:160` |
| `check-payment`:成功、未付、HTTP 錯、簽章錯、金額錯 | 有 | integration |
| `check-payment`:缺簽章、交易編號不符、`NO_TRADE_NO`、他人訂單、已 paid 重複查詢、逾時 | 無 | |
| ECPay 表單:金額、簽章、`ItemName`、URL | 有 | integration:316 |
| ECPay 付款頁:非 pending 302、不存在 404、`ItemName` 截斷 | 無 | |
| 取消訂單、回補庫存、重複取消 | 僅驗收測試 | 功能未實作 |
| 重複付款通知冪等 | 無 | 無通知端點(F-07) |
| 購物車 CRUD(訪客、基本) | 有 | `cart.test.js` |
| 購物車 POST 非整數數量 | 有 | `cart.test.js:100` |
| 購物車 PATCH 無效數量 | **無** | 實作有缺陷(F-01);`cart.test.js` 只有 `:48` 一個正常 PATCH |
| 購物車:累加同商品、累加超庫存、PATCH 超庫存 | 無 | |
| 購物車:他人項目 404、DELETE 不存在、`dualAuth` 401 | 無 | |
| 購物車 `total` 數值 | 無 | 只驗屬性存在 |
| 登入 / 註冊合併訪客購物車(含庫存上限) | 有 | `cart.test.js:113、147` |
| 後台訂單列表、詳情、pending 篩選 | 有(弱) | `adminOrders.test.js` |
| 後台訂單:paid / failed 篩選、非法 status、page / limit 邊界 | 無 | |
| 後台訂單權限 | 部分 | 列表 403 有;詳情 403 / 401 / 404 無 |
| 優惠碼、訂單篩選與分頁 | 僅驗收測試 | 功能未實作 |
| E2E 綠界付款 | 有 | `tests/e2e/ecpay-atm-payment.spec.js`,手動執行,不在 CI |

---

## 8. 已檢查、未發現問題

以下為審查者回報的涵蓋範圍,不代表絕對沒有問題;標「†」者主 agent 另外讀碼確認過。

- **認證覆蓋**:`orderRoutes.js:22` 對整個 router 套 `authMiddleware`†;兩個 admin router 都是 `router.use(authMiddleware, adminMiddleware)` 且順序正確(`adminOrderRoutes.js:9`†;`adminProductRoutes.js:11` 為審查者引用);`cartRoutes` 四個端點都掛 `dualAuth`;`productRoutes`、`pageRoutes` 公開且無寫入。
- **JWT**:固定 `algorithms: ['HS256']`†,沒有硬編碼 secret fallback,簽發 7 天過期,已刪除使用者的 token 回 401†。
- **`dualAuth`**:有 `Bearer` 但 token 無效時立即 401,不降級成 session;JWT 有效時忽略 `X-Session-Id`;購物車讀、改、刪都帶擁有者條件;前端 session id 由 `crypto.randomUUID()` 產生;登入或註冊的合併只在密碼驗證成功後執行,以庫存為上限。
- **建單**:只接受 JWT;金額由 DB 價格加 shipping 模組重算,不讀任何 client 傳入的 price、total、shipping_fee†;`shippingMethod` 是白名單,兩個旗標必須是 boolean†;建立訂單 → 品項快照 → 扣庫存 → 清購物車在同一個 `db.transaction()` 內†,整合測試驗證中途失敗時訂單、品項、庫存、購物車全數回滾。
- **SQL 注入**:所有查詢都參數化;字串插值只有 `${owner.field}` 與 `ALTER TABLE ${column}`,值來自程式內固定集合;沒有動態 `ORDER BY` 或 `LIKE`。
- **ECPay**:CheckMacValue 的排序、URL encode、小寫、SHA256、大寫與官方規則一致;驗簽先比長度再用 `timingSafeEqual`;表單值經 `escapeHtml`;狀態更新 `UPDATE ... WHERE status = 'pending'` 冪等且不可逆†;HashKey、HashIV、MerchantID 可由環境變數覆寫,不寫入 log 或回應;專案內沒有關閉 TLS 驗證的設定;沒有 `/ecpay/notify` 路由,因此沒有可偽造的通知端點†(但見 F-07)。
- **XSS**:`<%-` 只用於 include 與 layout 的 `body`;使用者與 DB 字串都走 Vue `{{ }}` 文字插值,沒有 `v-html`;`innerHTML` 只用靜態字串;登入頁 redirect 只允許同源路徑。
- **errorHandler**:5xx 一律回「伺服器內部錯誤」,4xx 用固定訊息,不輸出堆疊†(頁面路由例外見 F-16)。
- **CORS 與靜態檔**:CORS 為單一明確來源†;驗證走 Authorization header、無 cookie,沒有傳統 CSRF 面;靜態檔只暴露 `public/`,`.env` 與 `database.sqlite*` 不在其中且被 `.gitignore` 排除。
- **憑證與 CI**:`.env.example` 與 CI workflow 沒有真實憑證(ECPay 是綠界公開 staging 測試值);workflow 為 `permissions: contents: read`,沒有 `pull_request_target`。
- **測試設定**:unit 設定排除 `tests/integration/**`、`tests/e2e/**`、`tests/acceptance/**`†,載入 `testEnvironment.js`(`DATABASE_PATH=':memory:'`)†;審查者確認 integration 的 `fetch` 一律 mock、Playwright 設定沒有 `webServer`;`tests/` 內沒有 `.only`、`xit`、`xdescribe`、`it.todo`,也沒有被註解掉的測試†。
- **API 一致性**:`orderRoutes`、`cartRoutes`、`adminOrderRoutes`、`errorHandler` 與 404 handler 的回應皆為 `{ data, error, message }`,錯誤時 `data: null`。
- **其他**:運費模組其餘規則(宅配 120、超商 60、偏遠 +200、急件 +250,滿額只免基本費)與輸入驗證;`/pay` 在非 test 環境回 404 並有測試覆蓋;Mass assignment 與原型污染(欄位一律解構白名單,註冊角色固定為 `'user'`);依賴版本都很新(express 4.22.3、jsonwebtoken 9.0.3、bcrypt 6.0.0、better-sqlite3 12.8.0、ejs 5.0.1)。

---

## 9. 尚未驗證,需要人工或實際環境確認

1. **綠界的實際行為**:是否接受 NT$65 之類的低金額交易(F-01);對重複 `MerchantTradeNo` 的處理(F-07、F-15);正式環境的 QueryTradeInfo 是否一律帶 `CheckMacValue`(決定 F-06 能否改成一律拒絕);ATM、超商代碼等非即時付款的時序。
2. **實際部署設定**:`.env` 的 `JWT_SECRET` 長度與熵、`ADMIN_PASSWORD` 是否仍為預設、`ECPAY_ENV` 與金鑰是否為正式值、`NODE_ENV` 的值(security-reviewer 刻意沒有讀 `.env`)。
3. **多行程部署**下的庫存競爭,以及 500 取代 `STOCK_INSUFFICIENT` 的行為(F-08)。
4. **`npm run test:acceptance` 的實際結果**:F-25 提到的 3 項空洞通過是審查者推導,未實跑。
5. **`npm audit` 或其他 SCA 掃描**:審查者無法執行指令,主 agent 也未執行。
6. **部署層防護**:反向代理的 TLS、HSTS、安全標頭、速率限制、body size 限制、WAF。
7. **`getMerchantTradeDate`**:使用 `hour12: false` 搭配 `sv-SE`,在目前 Node / ICU 下午夜時段是否輸出「24:xx」(預期不會,風險低)。
8. **使用者付款後沒回站時的對帳流程**(沒有 `ReturnURL` 路由,見 F-07)。
9. **`tests/acceptance/` 與助教原版是否一致**(F-27)。

---

## 10. 建議的處理順序

以下是審查時提出的建議順序;第 1、2 批的多數項目與第 3 批中可獨立完成的部分已在本次修正完成,實際處理結果見第 11 節,此表保留作為剩餘項目的參考。修正方式是**先寫會失敗的測試,再修正**,修完後重跑 `test:unit` 與 `test:integration`。

| 批次 | 項目 | 重點 |
|---|---|---|
| 1 | F-01、F-02、F-03 | 影響金額與他人資料。PATCH 改用 `parsePositiveInteger`;訂單詳情改用 `findOrderForUser`;門檻改 `>=` 並取消 `it.skip`。各自補對應的失敗測試,CI 加禁止 `.skip` 的檢查 |
| 1 | F-04、F-05、F-12 | Email 長度上限與正則;非 test 環境強制明確設定 `ADMIN_*`、`ECPAY_*`、`JWT_SECRET` 並拒絕範例值 |
| 2 | F-06、F-11、F-13、F-14 | 驗簽改為必要;角色取自 DB;速率限制、helmet、非同步 bcrypt、`X-Session-Id` 驗證;自行託管 Vue 或固定版本加 SRI |
| 2 | F-15、F-16、F-17 | 付款頁加認證;頁面 render 錯誤交給 errorHandler;列表參數驗證 |
| 3 | F-07、F-08 | 與取消功能(Issue B)一併規劃:新 `MerchantTradeNo`、通知端點、逾時與取消回補庫存、庫存守衛。注意 `orders.status` 的 CHECK 需重建資料表(F-19) |
| 3 | F-09、F-10 | 依第 7 節補測試,強化過弱的斷言 |
| 4 | F-18 至 F-27 | Low 與 Info,隨相關改動順手處理 |

---

## 11. 修正狀態

狀態定義:**已修正**=缺陷已排除且有測試保護(殘留的子項目列在備註);**部分修正**=主要風險已處理,仍有明確缺口;**未處理**=本次刻意不動,原因列在備註。

| ID | 狀態 | 做了什麼 | 未做／原因 |
|---|---|---|---|
| F-01 | 已修正 | PATCH 改用 `parsePositiveInteger()`(上限為安全整數);建單前檢查購物車數量,舊資料中的小數數量回 400;`createOrderFromCart` 以 `TypeError` 拒絕非整數數量 | 資料表層的 `CHECK(typeof(quantity) = 'integer')`:SQLite 無法就地新增 CHECK,需重建資料表;應用層已有三道防線。既有資料庫可能殘留的小數列不會自動清理,結帳時會被擋下,需要時請人工處理 |
| F-02 | 已修正 | `GET /api/orders/:id` 改用 `findOrderForUser()`;補跨使用者測試(讀取、模擬付款、查詢綠界、列表、後台詳情) | — |
| F-03 | 已修正 | 門檻改為 `>=`;取消 `it.skip` 並補 1,499 / 1,500 / 1,501 邊界(單元測試與完整 API 流程);新增 `noDisabledTests` 守衛;文件的測試數量改為實際數字;`orders.test.js` 的期望運費改為固定值 510 | 前端 `checkout.js`、`cart.ejs` 仍各自內建運費規則(目前與後端一致);改成由 API 提供試算需要前後端一起設計,另案 |
| F-04 | 已修正 | 新增 `isValidEmail()`(254 字元上限加無重疊的規則),註冊與建單共用;100KB 的請求從 9,565 ms 降到 83 ms | 其餘字串欄位(姓名、地址)尚未設長度上限,目前只受 `express.json()` 的 100KB 限制 |
| F-05 | 部分修正 | `server.js` 在載入 `app.js` 之前檢查環境;`NODE_ENV=production` 時管理員 Email／密碼必須明確設定,密碼不得為預設值且至少 12 字元;開發環境顯示警告;文件標明「僅限本機開發」 | 開發環境仍保留 `admin@hexschool.com` / `12345678`:作業、驗收測試與 E2E 都依賴這組帳密 |
| F-06 | 已修正 | `TradeStatus === '1'` 時缺少 `CheckMacValue` 一律視為驗證失敗;補「缺簽章」「交易編號不符」案例 | 回應中的 `MerchantID` 未另外核對(簽章以我方的 HashKey / HashIV 驗證,已涵蓋) |
| F-07 | 未處理 | — | 屬功能開發:通知端點、每次付款嘗試使用新的 `MerchantTradeNo`、取消與逾時回補庫存(對應第四場作業 Issue B,驗收測試由助教提供)。需連同 `orders.status` 的 CHECK 重建一併規劃 |
| F-08 | 已修正 | 扣庫存改為 `UPDATE … WHERE stock >= ?` 並檢查影響列數;transaction 改為 `BEGIN IMMEDIATE`;新增 `InsufficientStockError`,路由轉成 400 `STOCK_INSUFFICIENT`;同商品多列的購物車不再回 500 | 路由的庫存預檢查仍在 transaction 之外(只用來給出完整的不足商品清單,最終判斷由扣庫存的條件決定);多行程部署未實際壓測 |
| F-09 | 部分修正 | 補了 F-01 至 F-08 相關測試,以及購物車(累加、庫存上限、他人項目、無效 token)、建單輸入驗證、金額由後端計算、check-payment(缺簽章、交易編號不符、已付款、無交易編號、逾時)、分頁參數、頁面路由 | 尚未補:偽造／過期／`alg=none` 的 token、後台商品寫入端點的 401 / 403、ECPay 付款頁的非 pending 與不存在案例、`ItemName` 截斷、body 超過 100KB(413)、XSS 輸出編碼 |
| F-10 | 部分修正 | 期望值改為固定數字;`CART_EMPTY`／`NOT_FOUND` 錯誤碼;購物車數量與總額改驗實際值;後台狀態篩選改為 pending / paid / failed / 未知值的明確案例 | `tests/e2e/ecpay-atm-payment.spec.js` 的恆真斷言未動:E2E 會連綠界 staging 並寫入開發 DB,這次無法執行驗證 |
| F-11 | 部分修正 | `authMiddleware` 與 `dualAuth` 的 `email`、`role` 取自資料庫;production 拒絕範例或過短的 `JWT_SECRET` | token 仍為 7 天且無法撤銷(沒有 `jti`／版本號) |
| F-12 | 已修正 | production 必須明確設定 `ECPAY_ENV`;`ECPAY_ENV=production` 時三個憑證必填且不得沿用 staging 測試值;啟動時印出綠界環境 | — |
| F-13 | 部分修正 | 新增 `securityHeaders` middleware(`nosniff`、`X-Frame-Options: SAMEORIGIN`、`Referrer-Policy`),關閉 `X-Powered-By` | 速率限制、非同步 bcrypt、訪客購物車的成長控制、CSP／HSTS:需要新增依賴或部署層設定,另案 |
| F-14 | 未處理 | — | 固定 Vue 版本並加上 SRI 需要連網計算雜湊,且沒有瀏覽器層級的測試可驗證頁面仍能載入;錯誤的雜湊會讓整個前台無法運作,應在能實際開啟頁面時處理 |
| F-15 | 未處理 | 只處理了「訂單沒有交易編號時回 400」 | 付款頁由瀏覽器直接導向,不帶 `Authorization` header;改成需登入要調整前端的付款流程(例如先以 API 取得表單),另案 |
| F-16 | 已修正 | 頁面路由的渲染失敗改交給 `errorHandler`;`?payment=` 只接受 `success` / `failed` / `cancel` / `pending` | — |
| F-17 | 已修正 | 新增 `parsePagination()`,商品、後台商品、後台訂單共用;訂單排序加上 `rowid` 以穩定分頁 | 商品列表排序未加次要鍵:這會改變同一秒建立的種子商品之順序,多個測試取列表第一筆當 fixture,這次未評估連帶影響 |
| F-18 | 已修正 | 訂單編號重複時重新產生(最多 10 次),格式不變 | — |
| F-19 | 部分修正 | 新增 6 個索引;`merchant_trade_no` 的 migration 改為先檢查欄位;`calculateShipping` 要求整數小計 | `cart_items` 的 UNIQUE 約束與金額／數量 CHECK:既有資料庫可能已有重複列,建立唯一索引會讓啟動失敗,CHECK 則需重建資料表;後台商品價格與庫存的上限未設 |
| F-20 | 已修正 | QueryTradeInfo 加 10 秒逾時;`check-payment` 的非預期錯誤交給 `errorHandler`,資料庫錯誤不再被誤標為 `ECPAY_QUERY_ERROR`;付款頁對沒有交易編號的訂單回 400 | — |
| F-21 | 已修正 | 訂單詳情的付款結果橫幅必須與訂單狀態一致(`success` 需 paid、`failed` 需 failed、`pending` 需 pending);後台訂單列表的欄位改稱「收件人」 | `items` 欄位形狀不一致未動;橫幅修改沒有瀏覽器層級的測試 |
| F-22 | 未處理 | 只在 `createOrderFromCart` 補上不變量檢查(整數數量、`shipping.subtotal === subtotal`) | 分層重構會大幅改動路由與 service,另案 |
| F-23 | 部分修正 | 測試環境固定 `ADMIN_EMAIL` / `ADMIN_PASSWORD` | `integrationGlobalSetup.mjs` 在開發伺服器同時寫入時可能誤判;`orders.test.js` 既有案例仍依序相依 |
| F-24 | 未處理 | — | 屬政策決定(Email 正規化需處理既有資料、密碼長度規則、帳號列舉防護) |
| F-25 | 部分修正 | 更新測試數量、`vitest.config.js` 排除範圍、環境變數、API 行為說明與 `CHANGELOG` | 驗收測試「預期失敗」的說法未實跑確認;命名規則例外、seed 商品文案、錯誤碼表(413 / 422 / 429)未動 |
| F-26 | 未處理 | — | 逐項需依部署需求評估 |
| F-27 | 未處理 | — | 資訊項目:需與助教原版對照,無法由本儲存庫處理 |

統計:已修正 12(F-01、02、03、04、06、08、12、16、17、18、20、21)、部分修正 8(F-05、09、10、11、13、19、23、25)、未處理 7(F-07、14、15、22、24、26、27)。

---

## 附錄 A:驗證方式與限制

- **security-reviewer、code-reviewer**:只有 Read / Grep / Glob 工具,純靜態閱讀,沒有執行任何程式或測試,也沒有 git 可用;security-reviewer 刻意沒有讀本機 `.env`。
- **test-runner**:只執行 `npm run test:unit` 與 `npm run test:integration`,並在前後記錄 `git status --short` 與 `database.sqlite` 狀態。
- **主 agent 的重現**:
  - 以專案外的暫存腳本執行(未納入版控),直接載入 `app.js` 搭配 `supertest`。
  - 使用與 `tests/setup/testEnvironment.js` 相同的環境變數,`DATABASE_PATH=':memory:'`;並把 `fetch` 改成直接丟錯,確保不會對外連線。
  - 重現前後,`database.sqlite` 的 mtime 與大小以及 `git status` 都沒有變化。
  - 重現環境為 `NODE_ENV=test`(bcrypt cost 降為 1、啟用模擬付款端點);這些差異不影響 F-01 至 F-06、F-15 至 F-17 的結論。
  - 時間量測(F-04)隨機器與 V8 的正則編譯狀態而異,僅供數量級參考。
  - 修正後以同一批腳本重新執行:F-01、F-02、F-03、F-04、F-06、F-16、F-17 不再重現(例如小數數量回 400、他人訂單回 404、1,500 元運費為 0、100KB 的註冊請求 83 ms);F-15(付款頁不需 token)依然重現,屬未處理項目。
- **git 歷史**:只有兩個 commit(`e1f39a0` Initial commit、`99d4869` 第二次commit),第二個只改了 `package-lock.json`。因此無法用歷史判斷任何測試是否被弱化,只能以現況判斷。
- **審查者的 High / Medium 評級**:兩位審查者對同一問題的評級不一致時(例如 F-03),本文取較高者;F-01 因實測升為 Critical。

## 附錄 B:原始編號對照

| 審查者編號 | 本文 ID |
|---|---|
| CR-01、CR-02 | F-03 |
| CR-03 | F-02 |
| CR-04 | F-01 |
| CR-05 | F-06 |
| CR-06、CR-07 | F-09 |
| CR-08 | F-10 |
| CR-09 | F-08 |
| CR-10 | F-07 |
| CR-11 | F-20 |
| CR-12 | F-17 |
| CR-13 | F-18 |
| CR-14 | F-21 |
| CR-15 | F-22 |
| CR-16 | F-19 |
| CR-17 | F-23 |
| CR-18、CR-19 | F-25 |
| CR-20 | F-27 |
| SEC-01 | F-02 |
| SEC-02 | F-01 |
| SEC-03 | F-05 |
| SEC-04 | F-04 |
| SEC-05 | F-06 |
| SEC-06 | F-11 |
| SEC-07 | F-12 |
| SEC-08、SEC-12 | F-13 |
| SEC-09 | F-07 |
| SEC-10 | F-03 |
| SEC-11 | F-14 |
| SEC-13 | F-15 |
| SEC-14 | F-16 |
| SEC-15 | F-17 |
| SEC-16 | F-24 |
| SEC-17、SEC-21、SEC-22、SEC-23 | F-26 |
| SEC-18 | F-20 |
| SEC-19 | F-18 |
| SEC-20 | F-21 |
| security-reviewer 的「測試面向的安全缺口」 | F-09 |
