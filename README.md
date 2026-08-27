# 家系圖快速製作器 V5.1.0

發布日期：2026-07-28

## V5.1 修正重點

- 每一名子女會記錄其所屬的婚姻／伴侶聯結 `unionId`。
- 多次婚配時，第一任、第二任、第三任所生子女會分別接在正確的婚姻線上。
- 子女線固定從該段婚姻線的水平中點向下，再接至手足線或單一子女。
- 舊版專案首次在 V5.1 開啟時，會自動修補可辨識的家庭聯結並重新依社工原則排列。

## 部署到 GitHub Pages

將下列檔案放在 `FamilyTree` 儲存庫根目錄：

```text
FamilyTree/
├─ index.html
├─ styles.css
└─ app.js
```

GitHub：Settings → Pages → Deploy from a branch → `main` / `/(root)`。

## 個資提醒

JSON 專案會保留原始姓名與資料，即使畫布開啟匿名模式也一樣。請依單位規範妥善保存。
