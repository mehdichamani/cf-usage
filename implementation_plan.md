# Replanned Implementation Plan - Cloudflare KV Storage & Account Management

This plan incorporates your updated feedback:
1. **Cloudflare KV Integration**: Storing all accounts and metadata server-side in Cloudflare KV.
2. **Account Web Management**: Migrating static environment variables (`CF_ACCOUNT_ID_*`) to KV so accounts can be added, edited, or removed directly from the web interface.
3. **Card Layout Structure**:
   - **1 Static Text Box** (Notes/Description) with inline editing.
   - **Up to 5 Link Slots** (Icons & Links) displayed horizontally in **1 row on PC** and **wrapped on Mobile**.
   - Direct inline **Add Link** into empty slots and **Delete Link** on existing slots.

---

## 🏛️ Architecture & Storage Design (Cloudflare KV)

### 1. KV Namespace (`CF_USAGE_KV`)
We bind a Cloudflare KV namespace named `CF_USAGE_KV` in `wrangler.json`.

- **Key `ACCOUNTS_CONFIG`**: Stores JSON array of managed accounts:
  ```json
  [
    {
      "account_id": "bc5e10cea180fa824cae66f8c71be7a0",
      "api_token": "token_123",
      "name": "Production Main"
    }
  ]
  ```
  *(Fallback: If KV is empty or not bound, automatically populates from environment variables `CF_ACCOUNT_ID_1`, etc.)*

- **Key `META_<account_id>`**: Stores note and link slots for each account:
  ```json
  {
    "note": "Primary US-East Production Zone",
    "links": [
      { "title": "CF Dashboard", "url": "https://dash.cloudflare.com", "icon": "link" },
      { "title": "Worker Logs", "url": "https://dash.cloudflare.com/.../logs", "icon": "server" }
    ]
  }
  ```

---

## 🎨 UI / UX & Layout Breakdown

```
+---------------------------------------------------------------------------------------------------+
| 👤 Production Main (user@example.com)                                             45,000 / 100,000 |
| [======================================-------------------------------] 45.0%   [⚙️ Manage Cards] |
|                                                                                                   |
|  📝 Static Note: "Primary US-East Production Zone" [✏️ Edit Note]                                  |
|                                                                                                   |
|  Horizontal Link Slots (1 Row PC / Wrapped Mobile):                                               |
|  +-------------------+  +-------------------+  +-------------------+  +---------------+           |
|  | 🔗 CF Dashboard ❌|  | ⚡ Worker Logs  ❌|  | 🌐 Prod Site    ❌|  | ➕ Add Link   | (Max 5)   |
|  +-------------------+  +-------------------+  +-------------------+  +---------------+           |
+---------------------------------------------------------------------------------------------------+
```

### Layout Specifications:
1. **Desktop (PC)**:
   - Link slots are rendered in **1 horizontal row** (`display: flex; flex-direction: row; gap: 0.5rem; flex-wrap: nowrap; overflow-x: auto;`).
2. **Mobile**:
   - Link slots wrap cleanly into multiple lines (`@media (max-width: 640px) { flex-wrap: wrap; }`).
3. **Static Text Box**:
   - Placed directly above or beside the link slots.
   - Displays custom text (e.g. Zone details, owner, tier).
   - Clicking text or the ✏️ pencil icon opens inline edit input.
4. **5 Link Slots**:
   - Displays up to 5 custom link cards.
   - Hovering/touching displays `❌` delete icon to remove existing link.
   - If total links $< 5$, displays a `➕ Add Link` empty slot button.

---

## ⚙️ Web-Based Account Management (Web KV Migration)

Top header will include a **"⚙️ Manage Accounts"** button:
- Clicking opens a Web Modal / Drawer.
- Lists all active Cloudflare accounts.
- Allows users to **Add New Account** (`Name`, `Account ID`, `API Token`).
- Allows users to **Edit** or **Delete** existing accounts.
- Saves directly to Cloudflare KV (`POST /api/accounts`).
- Updates dashboard instantly without redeploying Worker or editing environment variables!

---

## 🔌 API Endpoints on Cloudflare Worker (`src/index.js`)

We will add API endpoint handling directly inside `src/index.js` `fetch()`:

1. `POST /api/accounts`:
   - Saves account array to `CF_USAGE_KV.put("ACCOUNTS_CONFIG", JSON.stringify(accounts))`.
2. `POST /api/account-meta`:
   - Saves static text note & link slots to `CF_USAGE_KV.put("META_" + account_id, JSON.stringify(meta))`.
3. `GET /api/config`:
   - Returns accounts & metadata JSON for export or sync.

---

## Proposed File Changes

### [Wrangler Configuration]

#### [MODIFY] [wrangler.json](file:///c:/Users/Mehdi/projects/cf-usage/wrangler.json)
- Add `kv_namespaces` binding for `CF_USAGE_KV`.

#### [MODIFY] [DEPLOYMENT.md](file:///c:/Users/Mehdi/projects/cf-usage/DEPLOYMENT.md)
- Add quick 1-step guide for creating and binding KV namespace (`npx wrangler kv:namespace create CF_USAGE_KV`).

---

### [Worker Application & UI]

#### [MODIFY] [src/index.js](file:///c:/Users/Mehdi/projects/cf-usage/src/index.js)
- Implement KV storage lookup (`parseAccounts` KV fallback to env).
- Implement API routing (`/api/accounts`, `/api/account-meta`).
- Update HTML template:
  - Render static note box and horizontal link row (1 row PC / wrap mobile).
  - Add **Add Link Slot** modal and **Inline Note Editing** JS.
  - Add **Manage Accounts Modal** for web account CRUD operations.

---

### [Python Local Mirror]

#### [MODIFY] [main.py](file:///c:/Users/Mehdi/projects/cf-usage/main.py)
- Sync HTML/CSS and client-side KV simulation/local persistence so python backend matches Worker UI.

---

## Verification Plan

### Automated Verification
- Check syntax for `src/index.js`: `node -c src/index.js`
- Check syntax for `main.py`: `python -m py_compile main.py`

### Manual Verification
1. Run local dev server (`npm run dev` or `wrangler dev`).
2. Test inline static text note editing for an account.
3. Add up to 5 link slots under an account, check that on desktop they sit in 1 horizontal row.
4. Resize window to mobile width (<640px) and verify link slots wrap gracefully.
5. Delete a link slot and verify empty slot `➕ Add Link` button reappears.
6. Open **⚙️ Manage Accounts** modal, add/edit an account, and verify KV update.
