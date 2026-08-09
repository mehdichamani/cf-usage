🌐 **Languages:** **English** | [فارسی](DEPLOYMENT.fa.md)

# Deploying `cf-usage` to Cloudflare Workers

Deploying `cf-usage` to Cloudflare Workers ensures **0ms cold start latency**, **no idle sleep**, and **100,000 free requests per day**.

---

## 1. Quick Local Development

Test the Cloudflare Worker locally on your machine:

```bash
# 1. Install dependencies (Wrangler CLI)
npm install

# 2. Start the local Worker dev server (uses local storage by default)
npm run dev
```

Open `http://localhost:8787` in your browser. Wrangler will automatically load variables from `.dev.vars`.

> **Note on Local Storage vs Remote KV:**
> - **Local Storage (Default):** `npm run dev` uses Wrangler's built-in local KV storage (persisted in `.wrangler/state/`). No Cloudflare login or remote KV connection is required.
> - **Remote KV:** If you want local development to connect to your live remote Cloudflare KV namespace, run `npx wrangler dev --remote`.

---

## 2. Setting Up Cloudflare KV (Required for Web Administration)

This dashboard uses Cloudflare KV (`CF_USAGE_KV`) to store and manage accounts and metadata server-side without redeploying.

### Step 1: Create the KV Namespace

Run the following command to create the KV namespace:

```bash
npx wrangler kv:namespace create CF_USAGE_KV
```

This will output something like:

```text
🌀 Creating namespace with title "cf-usage-CF_USAGE_KV"
✨ Success! Added the following to your wrangler.json:
{
  "kv_namespaces": [
    {
      "binding": "CF_USAGE_KV",
      "id": "abc123def456..."
    }
  ]
}
```

### Step 2: Bind the KV Namespace in `wrangler.toml`

Open `wrangler.toml` and update the `kv_namespaces` array with your new KV namespace ID:

```toml
[[kv_namespaces]]
binding = "CF_USAGE_KV"
id = "YOUR_KV_NAMESPACE_ID"
```


---

## 3. Deploy to Cloudflare Workers

Choose one of the following deployment options:

### Option A: Manual CLI Deployment (Wrangler)

1. **Login to Cloudflare CLI**:
   ```bash
   npx wrangler login
   ```
   *(This opens a browser window asking to authorize Wrangler with your Cloudflare account)*

2. **Deploy the Worker**:
   ```bash
   npm run deploy
   ```

---

### Option B: Automated GitHub Actions Deployment (CI/CD)

The repository includes a GitHub Actions workflow located at [`.github/workflows/deploy.yml`](../.github/workflows/deploy.yml) that uses `cloudflare/wrangler-action` to automatically deploy changes whenever you push to the `main` branch.

1. **Set up GitHub Secrets**:
   Go to your GitHub Repository $\rightarrow$ **Settings** $\rightarrow$ **Secrets and variables** $\rightarrow$ **Actions** $\rightarrow$ **New repository secret**:
   - `CLOUDFLARE_API_TOKEN`: Your Cloudflare API Token (Create easily using the [Pre-Configured Token Creation Link](guide.md#-quick-setup-one-click-token-creation) or manually under **Cloudflare Dashboard** $\rightarrow$ **My Profile** $\rightarrow$ **API Tokens**).
   - `CLOUDFLARE_ACCOUNT_ID`: Your Cloudflare Account ID (Found on the Cloudflare Dashboard overview page or URL).

2. **Deploy via Git Push**:
   Push your code to the `main` branch. The action will automatically run and deploy your worker.

---

### Option C: Cloudflare Dashboard Git Repository Integration

1. Go to **Cloudflare Dashboard** $\rightarrow$ **Workers & Pages**.
2. Click **Create Application** $\rightarrow$ **Workers**.
3. Under deployment options, select **Connect Git Repository** (or setup GitHub Actions deployment via `.github/workflows/deploy.yml` using `cloudflare/wrangler-action`).
4. Select your GitHub repository and target branch (`main`).
5. Configure build settings (Build command: `npm run deploy` or leave standard, Root directory: `/`).
6. Click **Save and Deploy**.

---

## 4. Administrative Password & First Startup Setup

No environment secrets or `DASHBOARD_PASSWORD` environment variables are required!

When you deploy and open the dashboard for the first time:
1. A **Create Admin Password** setup modal will automatically prompt you on startup.
2. Enter and confirm your administrative password.
3. Your password is securely saved to Cloudflare KV (`CF_USAGE_KV`), enabling full access to account management, notes, and custom links.

---

## Benefits of Cloudflare Workers vs Render Free Tier

| Feature | Render Free Tier | Cloudflare Workers |
| :--- | :--- | :--- |
| **Cold Start Delay** | 50s – 90s (sleeps after 15 mins) | **0ms (Instant)** |
| **Free Requests** | Limited runtime hours | **100,000 requests / day** |
| **Storage & Sync** | Local DB / In-memory | **Global Cloudflare KV Sync** |
| **Cost** | Free (with sleep) | **100% Free** |
