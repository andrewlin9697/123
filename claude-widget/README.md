# Claude 用量小工具（iOS Scriptable）

在 iPhone 主畫面和鎖定畫面看 Claude 的用量。介面全部是繁體中文，時間一律用台灣時間（Asia/Taipei）。不需要 Mac，只要 iPhone 上的 Scriptable 加一台能開瀏覽器的電腦（用來複製一次 sessionKey）。

> ⚠️ **兩件事請先知道**
>
> 1. **sessionKey 等於你的 Claude 帳號鑰匙。** 拿到它的人可以用你的帳號。不要貼到聊天室、截圖分享、放進雲端筆記或 GitHub。這個腳本只把它存在手機的 Scriptable Keychain，而且只會送到 `claude.ai`。
> 2. **這是非官方介面。** 資料來自 claude.ai 用量頁背後的 `claude.ai/api/organizations/{組織ID}/usage`，Anthropic 沒有公開或保證這個介面，隨時可能改版。改版時小工具會顯示「回應格式不符」而不會當機，到時候需要更新腳本。

## 功能

| 項目 | 說明 |
| --- | --- |
| 5 小時用量 | 彩色圓環＋百分比、重置倒數（例如「2 小時 13 分後重置」） |
| 每週用量 | 彩色圓環＋百分比、重置時間（例如「週四 14:00 重置」） |
| 使用量額度 | 已花 / 每月上限（例如「$3.20 / $50.00」），只在 claude.ai 有開啟時顯示 |
| 模型別用量 | 如果 claude.ai 有回傳 Opus／Sonnet 的每週用量，大尺寸和詳細頁會一起顯示 |
| 顏色 | 未滿 60% 綠色、60～79% 橙色、80% 以上紅色 |
| 速度預估 | 依目前消耗速度預估「約 15:45 用完」，或「重置前用不完」 |
| 用量節奏 | 比較「用了幾 %」和「時間過了幾 %」：偏快／剛好／從容 |
| 趨勢圖 | 中尺寸顯示近 5 小時的小折線，大尺寸和詳細頁顯示近 5 小時與近 7 天趨勢 |
| 更新時間 | 「上次更新 13:05・3 分鐘前」，一定附上絕對時間，iOS 晚更新也不會誤導 |
| 離線 | 斷線或失敗時保留上次成功的資料，並標示「⚠️ 離線・12 分鐘前資料」 |
| 深淺色 | 跟著系統自動切換（文字、底色、進度條都會即時換色） |
| 自動更新 | 每 5 分鐘向 iOS 請求更新，5 小時或每週額度重置後 1 分鐘會再更新一次（實際時間由 iOS 決定，可能延後） |
| 通知 | 5 小時額度重置時提醒「Claude 額度回來了 🎉」；用量超過 80% 時提醒一次，同一個視窗不重複提醒（5 小時、每週各算各的）；sessionKey 失效時提醒一次。門檻都能在 App 內調整 |
| 點擊 | 點小工具會打開 App 內詳細頁（不用另外設定），有圓環總覽、趨勢圖，以及「立即更新」「打開 claude.ai 用量頁」「預覽小工具」「通知設定」「重設登入資料」 |
| 捷徑 | 從「捷徑」App 執行會輸出一段文字摘要，可以接自動化（例如每天早上念給你聽） |
| 示範畫面 | 還沒設定前，可以在精靈裡先看小工具長什麼樣子 |

支援的尺寸：主畫面**小**、**中**、**大**；鎖定畫面**圓環**、**長條**、**單行**。

---

## 安裝步驟

### 1. 安裝 Scriptable

在 App Store 搜尋 **Scriptable**（開發者 Simon B. Støvring），免費下載。

### 2. 把腳本放進 Scriptable

方法 A：直接貼上（最簡單）

1. 在 iPhone 用 Safari 打開本資料夾裡的 [`ClaudeUsage.js`](./ClaudeUsage.js)，按「Raw」顯示純文字。
2. 全選並拷貝。
3. 打開 Scriptable，按右上角「＋」新增腳本。
4. 貼上全部內容。
5. 點最上方的標題，改名為 **ClaudeUsage**，再按「Done」。

方法 B：用「檔案」App

1. 把 `ClaudeUsage.js` 下載到 iPhone。
2. 在「檔案」App 把它移到「iCloud 雲碟 → Scriptable」資料夾。
3. 打開 Scriptable，就會看到 ClaudeUsage。

### 3. 用電腦瀏覽器取得 sessionKey

iPhone 的 Safari 看不到 cookie，所以這一步要用電腦（Windows、Linux、Chromebook 都可以，不需要 Mac）。

**Chrome / Edge**

1. 打開 <https://claude.ai> 並登入。
2. 按 `F12`（或 `Ctrl + Shift + I`）打開開發人員工具。
3. 切到 **Application（應用程式）** 分頁。如果看不到，點 `>>` 展開。
4. 左側 **Storage（儲存空間）→ Cookies → https://claude.ai**。
5. 找到名稱為 **`sessionKey`** 的那一列，雙擊 **Value（值）** 欄位並複製。值會以 `sk-ant-sid` 開頭。

**Firefox**

1. 登入 claude.ai 後按 `F12`。
2. 切到 **Storage（儲存）** 分頁 → **Cookies → https://claude.ai**。
3. 複製 `sessionKey` 的值。

**把它送到 iPhone**

- 最安全的做法是看著電腦螢幕自己在 iPhone 上輸入。
- 如果要用傳的，只用自己信任的私人管道傳給自己，貼上後立刻刪掉那則訊息。不要貼到群組、公開或會長期保存的地方。

### 4. 執行首次設定精靈

1. 在 Scriptable 點 **ClaudeUsage** 執行。
2. 依照畫面說明按「我已複製，開始貼上」。想先看看效果，可以按「先看示範畫面」，用假資料預覽各種尺寸。
3. 貼上 sessionKey。整段 Cookie 也可以，程式會自動擷取 `sessionKey=` 後面的值。如果剪貼簿裡剛好是 sessionKey，會自動預填。
4. 按「驗證並儲存」。程式會連到 claude.ai，自動找出你 Claude Pro 的組織 ID。
5. 看到「設定完成 ✅」就成功了。sessionKey 和組織 ID 都存在 Scriptable Keychain，程式碼裡沒有任何寫死的金鑰。
6. 第一次執行時，Scriptable 可能會問能不能傳送通知，請按「允許」，才收得到額度提醒。

### 5. 加入主畫面小工具

1. 長按主畫面空白處，進入編輯模式。
2. 按左上角「＋」（或「編輯 → 加入小工具」），搜尋 **Scriptable**。
3. 選 **小**、**中** 或 **大** 尺寸，按「加入小工具」。
4. 長按剛加入的小工具 → **編輯小工具**：
   - **Script**：選 `ClaudeUsage`
   - **Parameter**：留空顯示 5 小時；輸入 `7d` 主要顯示每週
   - **When Interacting** 不用改，腳本會自己讓「點一下」打開詳細頁
5. 中、大尺寸會同時顯示 5 小時和每週，參數只影響小尺寸與鎖定畫面。
6. 可以同時放好幾個小工具（例如主畫面中尺寸＋鎖定畫面圓環），它們會共用同一份資料，一分鐘內只連一次 claude.ai，通知也不會重複。

### 6. 加入鎖定畫面小工具

1. 在鎖定畫面長按 → **自訂** → 選鎖定畫面。
2. 點時間下方的小工具區 → 搜尋 **Scriptable**。
3. 選圓形（圓環）、長方形（長條），或點時間上方的區域加入單行。
4. 點剛加入的小工具，Script 選 `ClaudeUsage`，Parameter 可填 `7d`。

各尺寸顯示內容：

| 尺寸 | 內容 |
| --- | --- |
| 主畫面・小 | 主要視窗的彩色圓環、另一個視窗的百分比與小進度條、倒數、預估、上次更新 |
| 主畫面・中 | 5 小時與每週兩個圓環、倒數、預估、近 5 小時趨勢、使用量額度（未開啟時改顯示本週節奏） |
| 主畫面・大 | 中尺寸的內容，再加上兩條趨勢圖、用量節奏、額度進度條、模型別用量 |
| 圓環 | 進度圈＋百分比＋「5h」或「週」 |
| 長條 | `Claude 5 小時 42%`、進度條、`3時00分後重置・約 15:45 用完`、另一個視窗的百分比 |
| 單行 | `Claude 5h 42%・3時00分後重置`（參數 7d：`Claude 週 18%・週四 14:00重置`） |

---

## 常見錯誤排除

| 小工具顯示 | 原因 | 怎麼處理 |
| --- | --- | --- |
| 尚未設定 | 還沒跑過設定精靈 | 在 Scriptable App 內執行一次 ClaudeUsage |
| 登入已失效 | sessionKey 過期，或你在 claude.ai 登出了（登出會讓 sessionKey 失效） | 重新用電腦登入並複製新的 sessionKey，在詳細頁選「重設登入資料」再貼上 |
| 被 Cloudflare 擋下 | claude.ai 的防護暫時擋住請求 | 通常過一陣子就好；也可以在手機 Safari 打開一次 claude.ai |
| 無法連線 / 離線 | 手機沒網路，或請求逾時 | 會繼續顯示上次的資料，有網路後會自動更新 |
| 請求太頻繁 | 短時間內更新太多次 | 等幾分鐘再試 |
| 找不到 Claude 組織 | 帳號下沒有 Claude 方案組織 | 確認 sessionKey 是 Claude Pro 那個帳號的 |
| 回應格式不符 | claude.ai 介面改版了 | 到這個 repo 看是否有新版腳本；這是非官方介面，可能會失效 |
| 伺服器錯誤 | claude.ai 暫時出問題 | 等一下會自動重試 |
| 數字很久沒更新 | iOS 會依電量和使用習慣決定小工具多久更新 | 點小工具打開詳細頁按「立即更新」；低耗電模式下更新會更少 |
| 沒收到通知 | 沒允許 Scriptable 通知 | 設定 → 通知 → Scriptable → 允許通知 |
| 使用量額度沒顯示 | claude.ai 沒開啟使用量額度（extra usage） | 正常，開啟後才會顯示 |

| 讀取中… | 另一個小工具剛好在抓資料 | 等下一次更新就會出現；也可以點小工具立刻更新 |
| 發生未預期的錯誤 | 程式遇到沒預料到的狀況 | 點小工具在 App 內執行，會顯示詳細訊息；歡迎回報 |
| 趨勢圖顯示「累積資料中…」 | 剛安裝，紀錄還不夠 | 每次更新會記一筆，大約 15 分鐘後就畫得出來 |

其他說明：

- **速度預估**：有過去一小時的紀錄時用近期速度，否則用「這個 5 小時視窗開始到現在」的平均速度。剛開始的幾分鐘資料不足，不會顯示預估。
- **使用量額度的單位**：介面回傳的 `monthly_limit`、`used_credits` 以「分」為單位（例如 5000 = $50.00），腳本會自動換算。
- **想換帳號**：詳細頁 →「🔑 重設登入資料」，會刪除 Keychain 裡的 sessionKey、組織 ID 和本機快取（通知設定會保留），然後重新跑設定精靈。

---

## 通知設定

在 App 內打開詳細頁 →「🔔 通知設定」，點選項目就會切換，馬上生效：

| 選項 | 可選值（預設粗體） |
| --- | --- |
| 重置提醒 | **有使用就提醒**／用量 ≥ 50% 才提醒／用量 ≥ 80% 才提醒／關閉 |
| 高用量提醒 | 70%／**80%**／90%／關閉 |
| 每週用量也提醒 | **開**／關 |
| 登入失效提醒 | **開**／關 |

把重置提醒關掉或調高門檻時，已經預約、還沒響的「額度回來了」會一起取消。

## 搭配「捷徑」App

1. 打開「捷徑」→ 新增捷徑 → 加入動作 **Scriptable → Run Script**。
2. Script 選 `ClaudeUsage`，**關閉**「Run In App」。
3. 執行後會輸出一段文字，例如：
   `Claude 用量：5 小時 42%（3 小時後重置，約 15:45 用完）；每週 18%（週四 14:00 重置）；使用量額度 $3.20 / $50.00`
4. 可以接「朗讀文字」「顯示通知」，或放進「個人自動化」（例如每天早上 9 點）。用 Siri 執行時還會顯示中尺寸小工具。

## 從舊版升級

把 Scriptable 裡 ClaudeUsage 的內容整個換成新版就好。Keychain 裡的 sessionKey、組織 ID 和舊快取都能直接沿用，不用重新設定。

---

## 技術細節

- 請求的介面（都是 claude.ai 網頁自己在用的）：
  - `GET https://claude.ai/api/organizations`：取得組織 ID（優先選 `claude_max` → `claude_pro` → `chat`）
  - `GET https://claude.ai/api/organizations/{組織ID}/usage`：取得 `five_hour`、`seven_day`（`utilization`、`resets_at`）與 `extra_usage`（`is_enabled`、`monthly_limit`、`used_credits`、`utilization`、`currency`）
- Header：`Cookie: sessionKey=…`、`Accept: application/json`、iPhone Safari 的 `User-Agent`、`Referer`、`Origin`。
- 參考過的開源專案：[diglitch1/claude-usage-widget](https://github.com/diglitch1/claude-usage-widget)、[hendrilee/claude-usage-widget](https://github.com/hendrilee/claude-usage-widget)。
- 儲存位置：sessionKey、組織 ID → Scriptable Keychain；用量快取、用量紀錄、通知狀態 → Scriptable 本機文件夾的 `claude-usage-tw-cache.json`；通知設定 → `claude-usage-tw-settings.json`（兩個檔案都不含金鑰）。
- 讀快取時會逐欄驗證，檔案損毀或來自舊版都不會讓小工具壞掉。

## 更新紀錄

**v2.0.0**

- 新增：主畫面大尺寸、彩色圓環、近 5 小時／7 天趨勢圖、用量節奏、模型別用量、通知設定、登入失效提醒、捷徑文字輸出、示範畫面、詳細頁圓環總覽。
- 修正：深色模式下進度條顏色可能跟背景不搭（改用會自動換色的元件）。
- 修正：4.7 吋等較小的 iPhone 上，中、小尺寸的進度條會超出邊界被裁切。
- 修正：同時放多個小工具時會各自打 API，還可能同時發出兩次 80% 通知。
- 修正：「上次更新」在小工具裡永遠顯示「剛剛」，現在改成顯示絕對時間。
- 修正：小工具「When Interacting」維持預設時，點了不會打開詳細頁。
- 修正：claude.ai 回傳 6 位小數秒的時間時，部分 iOS 版本可能解析失敗，導致沒有倒數。
- 修正：5 小時與每週視窗都還沒開始（回傳 null）時，誤顯示「回應格式不符」。
- 修正：時間欄位出現不合理的數值時，畫面會出現「NaN」。
- 修正：重設登入資料後，已預約的「額度回來了」通知還會響。
- 改善：任何未預期的錯誤都會顯示成友善訊息，不會出現 Scriptable 的紅色錯誤畫面；被限流時自動拉長更新間隔；請求逾時縮短為 10 秒。

## 開發與測試

測試用 Node 跑，以假的 API 回應模擬 Scriptable 的 `ListWidget`、`Request`、`Keychain`、`FileManager`、`Notification`、`Alert` 等物件，不會連網路。

每次 push 和 PR 都會在 GitHub Actions 自動跑一次（`.github/workflows/ci.yml`）。要注意測試的限制：`test/fixtures/` 裡的 API 回應是照 2026-10 看到的格式自己寫的假資料，不是從 claude.ai 錄下來的。測試全過只代表程式跟這些假資料一致；claude.ai 真的改版時測試不會發現，要靠小工具上的「回應格式不符」才知道。

```bash
cd claude-widget
npm test   # 需要 Node 18 以上
```

測試涵蓋：

- 回應解析（含 6 位小數秒的時間、時區位移、null 視窗、模型別用量）、百分比、倒數與台灣時間格式
- 速度預估、用量節奏、顏色門檻、趨勢圖
- 通知不重複、通知設定（門檻、關閉後取消預約）、登入失效只通知一次
- 離線保留資料、格式不符與損毀快取的錯誤處理、最後一道錯誤防線
- 多個小工具同時更新時共用快取、不重複打 API
- 首次設定精靈（含示範畫面）、App 詳細頁的按鈕、通知設定、重設登入資料、捷徑輸出
- 各尺寸小工具的輸出
- **亂數測試**：用固定種子產生幾千種奇怪的 API 回應和損毀的快取，確認每種尺寸都畫得出來，不會出現 `NaN`、`undefined` 或「未預期的錯誤」

## 檔案結構

```
claude-widget/
├── ClaudeUsage.js          # Scriptable 腳本本體（放進 Scriptable 的就是這個）
├── README.md               # 本說明
├── package.json            # npm test
└── test/
    ├── scriptable-mock.js  # Scriptable 環境模擬＋假 claude.ai 伺服器
    ├── logic.test.js       # 純邏輯測試
    ├── widget.test.js      # 整合測試（小工具、通知、設定精靈）
    ├── v2.test.js          # v2 新功能與防呆（並行、損毀快取、詳細頁、捷徑…）
    ├── fuzz.test.js        # 亂數測試
    └── fixtures/           # 假的 API 回應
```
