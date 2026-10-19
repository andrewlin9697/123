# Claude 用量小工具（iOS Scriptable）

在 iPhone 主畫面和鎖定畫面看 Claude 的用量。介面全部是繁體中文，時間一律用台灣時間（Asia/Taipei）。不需要 Mac，只要 iPhone 上的 Scriptable 加一台能開瀏覽器的電腦（用來複製一次 sessionKey）。

> ⚠️ **兩件事請先知道**
>
> 1. **sessionKey 等於你的 Claude 帳號鑰匙。** 拿到它的人可以用你的帳號。不要貼到聊天室、截圖分享、放進雲端筆記或 GitHub。這個腳本只把它存在手機的 Scriptable Keychain，而且只會送到 `claude.ai`。
> 2. **這是非官方介面。** 資料來自 claude.ai 用量頁背後的 `claude.ai/api/organizations/{組織ID}/usage`，Anthropic 沒有公開或保證這個介面，隨時可能改版。改版時小工具會顯示「回應格式不符」而不會當機，到時候需要更新腳本。

## 功能

| 項目 | 說明 |
| --- | --- |
| 5 小時用量 | 百分比、重置倒數（例如「2 小時 13 分後重置」） |
| 每週用量 | 百分比、重置時間（例如「週四 14:00 重置」） |
| 使用量額度 | 已花 / 每月上限（例如「$3.20 / $50.00」），只在 claude.ai 有開啟時顯示 |
| 顏色 | 未滿 60% 綠色、60～79% 橙色、80% 以上紅色 |
| 速度預估 | 依目前消耗速度預估「約 15:45 用完」，或「重置前用不完」 |
| 更新時間 | 「上次更新 X 分鐘前」 |
| 離線 | 斷線或失敗時保留上次成功的資料，並標示「⚠️ 離線・12 分鐘前資料」 |
| 深淺色 | 跟著系統自動切換 |
| 自動更新 | 每 5 分鐘向 iOS 請求更新，5 小時或每週額度重置後 1 分鐘會再更新一次（實際時間由 iOS 決定，可能延後） |
| 通知 | 5 小時額度重置時提醒「Claude 額度回來了 🎉」；用量超過 80% 時提醒一次，同一個視窗不重複提醒（5 小時、每週各算各的） |
| 點擊 | 點小工具會打開 App 內詳細頁，有「立即更新」「打開 claude.ai 用量頁」「預覽小工具」「重設登入資料」 |

支援的尺寸：主畫面**小**、**中**；鎖定畫面**圓環**、**長條**、**單行**。

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
2. 依照畫面說明按「我已複製，開始貼上」。
3. 貼上 sessionKey。整段 Cookie 也可以，程式會自動擷取 `sessionKey=` 後面的值。如果剪貼簿裡剛好是 sessionKey，會自動預填。
4. 按「驗證並儲存」。程式會連到 claude.ai，自動找出你 Claude Pro 的組織 ID。
5. 看到「設定完成 ✅」就成功了。sessionKey 和組織 ID 都存在 Scriptable Keychain，程式碼裡沒有任何寫死的金鑰。
6. 第一次執行時，Scriptable 可能會問能不能傳送通知，請按「允許」，才收得到額度提醒。

### 5. 加入主畫面小工具

1. 長按主畫面空白處，進入編輯模式。
2. 按左上角「＋」（或「編輯 → 加入小工具」），搜尋 **Scriptable**。
3. 選 **小** 或 **中** 尺寸，按「加入小工具」。
4. 長按剛加入的小工具 → **編輯小工具**：
   - **Script**：選 `ClaudeUsage`
   - **When Interacting**：選 `Run Script`（點了會打開詳細頁）
   - **Parameter**：留空顯示 5 小時；輸入 `7d` 主要顯示每週
5. 中尺寸會同時顯示 5 小時和每週，參數只影響小尺寸與鎖定畫面。

### 6. 加入鎖定畫面小工具

1. 在鎖定畫面長按 → **自訂** → 選鎖定畫面。
2. 點時間下方的小工具區 → 搜尋 **Scriptable**。
3. 選圓形（圓環）、長方形（長條），或點時間上方的區域加入單行。
4. 點剛加入的小工具，Script 選 `ClaudeUsage`，Parameter 可填 `7d`。

各尺寸顯示內容：

| 尺寸 | 內容 |
| --- | --- |
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

其他說明：

- **速度預估**：有過去一小時的紀錄時用近期速度，否則用「這個 5 小時視窗開始到現在」的平均速度。剛開始的幾分鐘資料不足，不會顯示預估。
- **使用量額度的單位**：介面回傳的 `monthly_limit`、`used_credits` 以「分」為單位（例如 5000 = $50.00），腳本會自動換算。
- **想換帳號**：詳細頁 →「🔑 重設登入資料」，會刪除 Keychain 裡的 sessionKey、組織 ID 和本機快取，然後重新跑設定精靈。

---

## 技術細節

- 請求的介面（都是 claude.ai 網頁自己在用的）：
  - `GET https://claude.ai/api/organizations`：取得組織 ID（優先選 `claude_max` → `claude_pro` → `chat`）
  - `GET https://claude.ai/api/organizations/{組織ID}/usage`：取得 `five_hour`、`seven_day`（`utilization`、`resets_at`）與 `extra_usage`（`is_enabled`、`monthly_limit`、`used_credits`、`utilization`、`currency`）
- Header：`Cookie: sessionKey=…`、`Accept: application/json`、iPhone Safari 的 `User-Agent`、`Referer`、`Origin`。
- 參考過的開源專案：[diglitch1/claude-usage-widget](https://github.com/diglitch1/claude-usage-widget)、[hendrilee/claude-usage-widget](https://github.com/hendrilee/claude-usage-widget)。
- 儲存位置：sessionKey、組織 ID → Scriptable Keychain；用量快取、用量紀錄、通知狀態 → Scriptable 本機文件夾的 `claude-usage-tw-cache.json`（不含金鑰）。

## 開發與測試

測試用 Node 跑，以假的 API 回應模擬 Scriptable 的 `ListWidget`、`Request`、`Keychain`、`FileManager`、`Notification`、`Alert` 等物件，不會連網路。

```bash
cd claude-widget
npm test   # 需要 Node 18 以上
```

測試涵蓋：回應解析、百分比、倒數與台灣時間格式、速度預估、顏色門檻、通知不重複、離線保留資料、格式不符的錯誤處理、首次設定精靈、各尺寸小工具的輸出。

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
    └── fixtures/           # 假的 API 回應
```
