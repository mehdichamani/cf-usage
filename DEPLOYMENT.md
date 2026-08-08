# Deploying `cf-usage` to Cloudflare Workers

Deploying `cf-usage` to Cloudflare Workers ensures **0ms cold start latency**, **no idle sleep**, and **100,000 free requests per day**.

---

## 1. Quick Local Development

Test the Cloudflare Worker locally on your machine:

```bash
# 1. Install dependencies (Wrangler CLI)
npm install

# 2. Start the local Worker dev server
npm run dev
```

Open `http://localhost:8787` in your browser. Wrangler will automatically load variables from `.dev.vars`.

---

## 2. Deploy to Cloudflare Workers (Recommended)

### Step 1: Login to Cloudflare CLI
Run the following command once to link Wrangler with your Cloudflare account:

```bash
npx wrangler login
```
*(This opens a browser window asking to authorize Wrangler with your Cloudflare account)*

### Step 2: Deploy the Worker
Deploy the worker with a single command:

```bash
npm run deploy
```

---

## 3. Setting Environment Secrets in Production

You have two options for setting secrets (`CF_ACCOUNT_ID_1`, `CF_API_TOKEN_1`, etc.) in Cloudflare Workers:

### Option A: Using Wrangler CLI (Easiest)

Run `wrangler secret put` for each environment variable:

```bash
npx wrangler secret put CF_ACCOUNT_ID_1
# Paste your Account ID when prompted

npx wrangler secret put CF_API_TOKEN_1
# Paste your API Token when prompted

npx wrangler secret put CF_ACCOUNT_NAME_1
# Type: main
```

Repeat for any additional accounts (`CF_ACCOUNT_ID_2`, `CF_API_TOKEN_2`, etc.).

---

### Option B: Cloudflare Web Dashboard

1. Log in to the [Cloudflare Dashboard](https://dash.cloudflare.com/).
2. Go to **Workers & Pages** $\rightarrow$ Click on **`cf-usage`**.
3. Navigate to **Settings** $\rightarrow$ **Variables and Secrets**.
4. Click **Add / Edit Variables** under **Environment Variables**.
5. Add your environment variables:
   - `CF_ACCOUNT_ID_1` = `...`
   - `CF_API_TOKEN_1` = `...`
   - `CF_ACCOUNT_NAME_1` = `...`
   - `CF_ACCOUNT_ID_2` = `...`
   - ...
6. Click **Save and Deploy**.

---

## Benefits of Cloudflare Workers vs Render Free Tier

| Feature | Render Free Tier | Cloudflare Workers |
| :--- | :--- | :--- |
| **Cold Start Delay** | 50s – 90s (sleeps after 15 mins) | **0ms (Instant)** |
| **Free Requests** | Limited runtime hours | **100,000 requests / day** |
| **Edge Cache** | Manual / Memory only | **Global Edge Cache built-in** |
| **Cost** | Free (with sleep) | **100% Free** |
