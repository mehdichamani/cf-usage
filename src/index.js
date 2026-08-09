/**
 * Cloudflare Worker: Cloudflare Workers Usage Dashboard
 * 
 * Fetches and displays daily Cloudflare Workers invocation metrics for multiple accounts.
 */

const WORKERS_LIMIT = 100000;
const CACHE_TTL_SECONDS = 900; // 15 minutes

const GRAPHQL_QUERY = `
query GetWorkersUsage($accountTag: String, $date: String) {
  viewer {
    accounts(filter: {accountTag: $accountTag}) {
      workersInvocationsAdaptive(limit: 100, filter: {date: $date}) {
        sum {
          requests
        }
      }
    }
  }
}
`;

// In-memory cache fallback for worker isolate lifecycle
const MEMORY_CACHE = new Map();

function parseEnvAccounts(env) {
  const accounts = [];
  for (let i = 1; i <= 10; i++) {
    let accountId = env[`CF_ACCOUNT_ID_${i}`] || env[`CF_ACCOUNT_${i}_ID`] || "";
    let apiToken = env[`CF_API_TOKEN_${i}`] || "";

    if (i === 1) {
      if (!accountId) accountId = env["CF_ACCOUNT_ID"] || "";
      if (!apiToken) apiToken = env["CF_API_TOKEN"] || "";
    }

    if (accountId) {
      const name = env[`CF_ACCOUNT_${i}_NAME`] || env[`CF_ACCOUNT_NAME_${i}`] || `Account ${i}`;
      accounts.push({
        name,
        account_id: accountId,
        api_token: apiToken,
        index: i,
      });
    }
  }
  return accounts;
}

async function getAccounts(env) {
  if (env.CF_USAGE_KV) {
    try {
      const kvData = await env.CF_USAGE_KV.get("ACCOUNTS_CONFIG");
      if (kvData) {
        const parsed = JSON.parse(kvData);
        if (Array.isArray(parsed)) {
          return parsed.map((acc, index) => ({
            ...acc,
            index: index + 1
          }));
        }
      }
    } catch (e) {
      console.error("Error reading ACCOUNTS_CONFIG from KV:", e);
    }
  }
  return parseEnvAccounts(env);
}

async function getAccountMeta(accountId, env) {
  if (env.CF_USAGE_KV) {
    try {
      const kvMeta = await env.CF_USAGE_KV.get("META_" + accountId);
      if (kvMeta) {
        return JSON.parse(kvMeta);
      }
    } catch (e) {
      console.error("Error reading metadata for " + accountId + ":", e);
    }
  }
  return { note: "", links: [] };
}

async function getAdminPassword(env) {
  if (env.CF_USAGE_KV) {
    try {
      const pass = await env.CF_USAGE_KV.get("ADMIN_PASSWORD");
      if (pass) return pass;
    } catch (e) {
      console.error("Error reading ADMIN_PASSWORD from KV:", e);
    }
  }
  return null;
}

async function verifyPassword(request, env) {
  const adminPassword = await getAdminPassword(env);
  if (!adminPassword) {
    return false; // Deny edits completely if admin password is not configured in KV
  }
  const authHeader = request.headers.get("Authorization");
  if (authHeader && authHeader.startsWith("Bearer ")) {
    const token = authHeader.substring(7);
    return token === adminPassword;
  }
  return false;
}

async function fetchAccountInfo(accountId, apiToken) {
  const headers = {
    "Authorization": `Bearer ${apiToken}`,
    "Content-Type": "application/json",
    "User-Agent": "CF-Usage-Worker/1.0"
  };

  let email = null;
  let cfAccountName = null;

  try {
    const userRes = await fetch("https://api.cloudflare.com/client/v4/user", { headers });
    if (userRes.ok) {
      const userData = await userRes.json();
      if (userData?.success) {
        email = userData.result?.email || null;
      }
    }
  } catch (e) {
    // Ignore fetch errors for user info
  }

  try {
    const accRes = await fetch(`https://api.cloudflare.com/client/v4/accounts/${accountId}`, { headers });
    if (accRes.ok) {
      const accData = await accRes.json();
      if (accData?.success) {
        cfAccountName = accData.result?.name || null;
      }
    }
  } catch (e) {
    // Ignore fetch errors for account details
  }

  return { email, cfAccountName };
}

async function fetchAccountUsage(account) {
  const todayUtc = new Date().toISOString().split("T")[0];
  const headers = {
    "Authorization": `Bearer ${account.api_token}`,
    "Content-Type": "application/json",
    "User-Agent": "CF-Usage-Worker/1.0"
  };

  const payload = {
    query: GRAPHQL_QUERY,
    variables: {
      accountTag: account.account_id,
      date: todayUtc
    }
  };

  try {
    const response = await fetch("https://api.cloudflare.com/client/v4/graphql", {
      method: "POST",
      headers,
      body: JSON.stringify(payload)
    });

    const data = await response.json();

    if (data.errors && data.errors.length > 0) {
      const errMsg = data.errors[0]?.message || "GraphQL Error";
      return { requests: 0, limit: WORKERS_LIMIT, pct: 0, error: `API Error: ${errMsg}` };
    }

    const accountsData = data?.data?.viewer?.accounts || [];
    if (accountsData.length === 0) {
      return { requests: 0, limit: WORKERS_LIMIT, pct: 0, error: "Account ID not found or Token lacks permissions" };
    }

    const invocations = accountsData[0]?.workersInvocationsAdaptive || [];
    const totalRequests = invocations.reduce((acc, item) => acc + (item?.sum?.requests || 0), 0);

    const pct = Math.min(Math.round((totalRequests / WORKERS_LIMIT) * 1000) / 10, 100);

    return {
      requests: totalRequests,
      limit: WORKERS_LIMIT,
      pct,
      error: null
    };
  } catch (e) {
    return {
      requests: 0,
      limit: WORKERS_LIMIT,
      pct: 0,
      error: `Connection Error: ${e.message}`
    };
  }
}

async function fetchFullAccountData(account, env) {
  if (env.MOCK_CF === "true") {
    return {
      account_id: account.account_id,
      name: `Mocked ${account.name}`,
      email: `user${account.index}@example.com`,
      requests: 42000 + account.index * 5000,
      limit: WORKERS_LIMIT,
      pct: 42.0 + account.index * 5.0,
      error: null
    };
  }

  const [info, usage] = await Promise.all([
    fetchAccountInfo(account.account_id, account.api_token),
    fetchAccountUsage(account)
  ]);

  const name = info.cfAccountName || account.name;
  const email = info.email;

  return {
    account_id: account.account_id,
    name,
    email,
    requests: usage.requests,
    limit: usage.limit,
    pct: usage.pct,
    error: usage.error
  };
}

function renderDashboard(results, env, hasPasswordConfigured) {
  // SSR UTC time calculation for initial render fallback
  const nowUtc = new Date();
  const utcHours = nowUtc.getUTCHours();
  const utcMinutes = nowUtc.getUTCMinutes();
  const utcSeconds = nowUtc.getUTCSeconds();
  const totalSecondsPassed = utcHours * 3600 + utcMinutes * 60 + utcSeconds;
  const dayProgressPct = Math.min(100, Math.max(0, (totalSecondsPassed / 86400) * 100)).toFixed(1);
  const remainingSeconds = 86400 - totalSecondsPassed;
  const remH = Math.floor(remainingSeconds / 3600);
  const remM = Math.floor((remainingSeconds % 3600) / 60);

  const timeFormatted = `${String(utcHours).padStart(2, '0')}:${String(utcMinutes).padStart(2, '0')}:${String(utcSeconds).padStart(2, '0')} UTC`;
  const timeElapsedFormatted = `${utcHours}h ${utcMinutes}m`;

  let emptyStateHtml = "";
  if (!results || results.length === 0) {
    emptyStateHtml = `
    <div class="empty-container">
        <h2>No Accounts Configured</h2>
        <p>No Cloudflare accounts configured. Click <strong>⚙️ Manage Accounts</strong> in the top-right to add accounts.</p>
    </div>`;
  }

  let totalRequests = 0;
  let totalLimit = 0;

  let cardsHtml = "";
  for (const res of results) {
    totalRequests += Number(res.requests || 0);
    totalLimit += Number(res.limit || WORKERS_LIMIT);

    let displayHeader = res.name;
    if (res.email) {
      const nameLower = res.name.toLowerCase();
      const emailLower = res.email.toLowerCase();
      if (!nameLower.includes(emailLower) && !emailLower.includes(nameLower)) {
        displayHeader = `${res.name} (${res.email})`;
      }
    }
    const errBadge = res.error
      ? `<div class="error-badge"><span>⚠️</span> ${res.error}</div>`
      : "";

    let barGradient = "linear-gradient(90deg, #3b82f6, #06b6d4)";
    let badgeClass = "badge-normal";
    if (res.pct > 90) {
      barGradient = "linear-gradient(90deg, #f43f5e, #ef4444)";
      badgeClass = "badge-danger";
    } else if (res.pct > 75) {
      barGradient = "linear-gradient(90deg, #f59e0b, #f97316)";
      badgeClass = "badge-warning";
    }

    const formattedRequests = Number(res.requests).toLocaleString('en-US');
    const formattedLimit = Number(res.limit).toLocaleString('en-US');

    // Render static note and link slots
    const meta = res.meta || { note: "", links: [] };
    const noteText = meta.note || "No notes added yet.";

    let linksHtml = "";
    (meta.links || []).forEach((link, idx) => {
      linksHtml += `
        <div class="link-slot" data-index="${idx}">
          <a href="${link.url}" target="_blank" rel="noopener" class="link-anchor">
            <i class="ti ti-${link.icon || 'link'}"></i>
            <span>${link.title}</span>
          </a>
          <button class="delete-link-btn" onclick="deleteLink('${res.account_id}', ${idx})" title="Delete Link">
            <i class="ti ti-x"></i>
          </button>
        </div>
      `;
    });

    if ((meta.links || []).length < 5) {
      linksHtml += `
        <button class="add-link-btn" onclick="openAddLinkModal('${res.account_id}')" title="Add Link Slot">
          <i class="ti ti-plus"></i>
          <span>Add Link</span>
        </button>
      `;
    }

    cardsHtml += `
      <div class="card" data-account-id="${res.account_id}">
        <div class="card-header">
          <div class="account-title">
            <svg class="account-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path stroke-linecap="round" stroke-linejoin="round" d="M19 21v-2a4 4 0 00-4-4H9a4 4 0 00-4 4v2" />
              <circle cx="12" cy="7" r="4" />
            </svg>
            <span class="account-name">${displayHeader}</span>
          </div>
          <div class="usage-stats">
            <span class="usage-count" data-raw-reqs="${formattedRequests}" data-raw-limit="${formattedLimit}">${formattedRequests} / ${formattedLimit}</span>
            <span class="pct-badge ${badgeClass}" data-raw-pct="${res.pct}%">${res.pct}%</span>
          </div>
        </div>
        <div class="bar-bg">
          <div class="bar-fill" style="width: ${res.pct}%; background: ${barGradient};"></div>
        </div>
        ${errBadge}

        <!-- Note & Links Section -->
        <div class="card-meta-section">
          <div class="note-container" id="note-container-${res.account_id}">
            <i class="ti ti-notes note-icon"></i>
            <div class="note-content" onclick="enableNoteEdit('${res.account_id}')" id="note-display-${res.account_id}">${noteText}</div>
            <div class="note-edit-wrapper" id="note-edit-wrapper-${res.account_id}" style="display: none; width: 100%;">
              <textarea class="note-input" id="note-input-${res.account_id}">${meta.note || ""}</textarea>
              <div class="note-actions">
                <button class="btn btn-primary btn-sm note-save-btn" onclick="saveNote('${res.account_id}')">
                  <i class="ti ti-check"></i>
                  <span data-i18n="btn-save-note">Save</span>
                </button>
                <button class="btn btn-sm note-cancel-btn" onclick="cancelNoteEdit('${res.account_id}')">
                  <i class="ti ti-x"></i>
                  <span data-i18n="btn-cancel">Cancel</span>
                </button>
              </div>
            </div>
            <i class="ti ti-edit note-edit-icon" id="note-edit-icon-${res.account_id}" onclick="enableNoteEdit('${res.account_id}')"></i>
          </div>
          <div class="links-row">
            ${linksHtml}
          </div>
        </div>
      </div>
    `;
  }

  const overallPct = totalLimit > 0 ? ((totalRequests / totalLimit) * 100).toFixed(1) : "0.0";
  const formattedTotalReqs = totalRequests.toLocaleString('en-US');
  const formattedTotalLimit = totalLimit.toLocaleString('en-US');

  // Create accounts data payload to pass to the frontend safely
  const frontendAccountsData = results.map(r => ({
    account_id: r.account_id,
    name: r.name,
    api_token: r.api_token ? "••••••••••••" : ""
  }));

  const frontendFullData = results.map(r => ({
    account_id: r.account_id,
    meta: r.meta || { note: "", links: [] }
  }));

  return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Cloudflare Workers Usage Dashboard</title>
    <link rel="preconnect" href="https://fonts.googleapis.com">
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
    <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=Vazirmatn:wght@400;500;600;700&display=swap" rel="stylesheet">
    <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/@tabler/icons-webfont@latest/dist/tabler-icons.min.css" />
    <style>
        :root {
            /* Global Typography System (No Monospace Fonts) */
            --font-english: 'Inter', system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            --font-persian: 'Vazirmatn', 'Inter', system-ui, -apple-system, sans-serif;
            --font-main: var(--font-english);
        }

        :root[dir="rtl"], body.rtl-mode {
            --font-main: var(--font-persian);
        }

        :root, :root.theme-dark {
            --bg-color: #090d16;
            --card-bg: rgba(17, 24, 39, 0.75);
            --card-hover: rgba(30, 41, 59, 0.85);
            --border-color: rgba(255, 255, 255, 0.08);
            --text-primary: #f3f4f6;
            --text-secondary: #9ca3af;
            --text-muted: #6b7280;
            --cf-orange: #f38020;
            --cf-orange-glow: rgba(243, 128, 32, 0.25);
            --accent-cyan: #06b6d4;
            --modal-bg: #0f172a;
            --input-bg: rgba(255, 255, 255, 0.03);
            --btn-bg: rgba(255, 255, 255, 0.05);
            --btn-hover: rgba(255, 255, 255, 0.1);
            --note-bg: rgba(255, 255, 255, 0.02);
            --note-border: rgba(255, 255, 255, 0.04);
            --scrollbar-thumb: rgba(255, 255, 255, 0.1);
            --text-highlight: #ffffff;
            --h1-color: linear-gradient(180deg, #ffffff 0%, #cbd5e1 100%);
            --clock-text: #38bdf8;
            --clock-border: rgba(56, 189, 248, 0.2);
        }

        :root.theme-light {
            --bg-color: #f3f4f6;
            --card-bg: rgba(255, 255, 255, 0.85);
            --card-hover: rgba(249, 250, 251, 0.95);
            --border-color: rgba(0, 0, 0, 0.08);
            --text-primary: #111827;
            --text-secondary: #4b5563;
            --text-muted: #9ca3af;
            --cf-orange: #f38020;
            --cf-orange-glow: rgba(243, 128, 32, 0.12);
            --accent-cyan: #0891b2;
            --modal-bg: #ffffff;
            --input-bg: rgba(0, 0, 0, 0.02);
            --btn-bg: rgba(0, 0, 0, 0.04);
            --btn-hover: rgba(0, 0, 0, 0.08);
            --note-bg: rgba(0, 0, 0, 0.01);
            --note-border: rgba(0, 0, 0, 0.03);
            --scrollbar-thumb: rgba(0, 0, 0, 0.1);
            --text-highlight: #111827;
            --h1-color: linear-gradient(180deg, #111827 0%, #374151 100%);
            --clock-text: #0284c7;
            --clock-border: rgba(2, 132, 199, 0.25);
        }

        *, *::before, *::after {
            box-sizing: border-box;
            margin: 0;
            padding: 0;
        }

        /* Strict Universal Typography Enforcement for all elements, inputs, buttons & badges */
        *, html, body, button, input, textarea, select, optgroup, code, kbd, samp, pre {
            font-family: var(--font-main) !important;
        }

        body {
            background: var(--bg-color);
            background-image: 
                radial-gradient(at 0% 0%, rgba(243, 128, 32, 0.08) 0px, transparent 50%),
                radial-gradient(at 100% 100%, rgba(6, 182, 212, 0.06) 0px, transparent 50%);
            background-attachment: fixed;
            color: var(--text-primary);
            min-height: 100vh;
            display: flex;
            flex-direction: column;
            justify-content: space-between;
            padding: 1.5rem 1rem;
            -webkit-font-smoothing: antialiased;
        }

        .container {
            max-width: 860px;
            margin: 0 auto;
            width: 100%;
        }

        /* Top Header */
        header {
            margin-bottom: 1.5rem;
            display: flex;
            justify-content: space-between;
            align-items: center;
            flex-wrap: wrap;
            gap: 1rem;
        }

        .brand {
            display: flex;
            align-items: center;
            gap: 0.75rem;
        }

        .cf-logo {
            width: 38px;
            height: 38px;
            background: linear-gradient(135deg, #f38020, #faad3f);
            border-radius: 10px;
            display: flex;
            align-items: center;
            justify-content: center;
            box-shadow: 0 4px 12px var(--cf-orange-glow);
        }

        .cf-logo svg { width: 22px; height: 22px; fill: #ffffff; }

        h1 {
            font-size: 1.5rem;
            font-weight: 700;
            letter-spacing: -0.02em;
            background: var(--h1-color);
            -webkit-background-clip: text;
            -webkit-text-fill-color: transparent;
        }

        .header-actions {
            display: flex;
            align-items: center;
            gap: 0.75rem;
            flex-wrap: wrap;
        }

        .btn {
            background: var(--btn-bg);
            color: var(--text-primary);
            border: 1px solid var(--border-color);
            padding: 0.5rem 1rem;
            border-radius: 8px;
            font-size: 0.85rem;
            font-weight: 500;
            cursor: pointer;
            display: inline-flex;
            align-items: center;
            gap: 0.4rem;
            transition: all 0.2s ease;
        }

        .btn:hover {
            background: var(--btn-hover);
            border-color: rgba(255, 255, 255, 0.15);
        }

        :root.theme-light .btn:hover {
            border-color: rgba(0, 0, 0, 0.15);
        }

        /* Selector Group */
        .selector-group {
            display: flex;
            gap: 0.5rem;
            align-items: center;
        }

        .btn-primary {
            background: var(--cf-orange);
            color: #ffffff;
            border-color: transparent;
        }

        .btn-primary:hover {
            background: #e0731a;
            box-shadow: 0 4px 12px rgba(243, 128, 32, 0.3);
        }

        .status-badge {
            display: inline-flex;
            align-items: center;
            gap: 0.5rem;
            padding: 0.4rem 0.8rem;
            background: rgba(16, 185, 129, 0.1);
            border: 1px solid rgba(16, 185, 129, 0.2);
            border-radius: 9999px;
            font-size: 0.8rem;
            font-weight: 500;
            color: #34d399;
        }

        .pulse-dot {
            width: 8px;
            height: 8px;
            background-color: #10b981;
            border-radius: 50%;
            box-shadow: 0 0 8px #10b981;
            animation: pulse 2s infinite;
        }

        @keyframes pulse {
            0% { transform: scale(0.95); box-shadow: 0 0 0 0 rgba(16, 185, 129, 0.7); }
            70% { transform: scale(1); box-shadow: 0 0 0 6px rgba(16, 185, 129, 0); }
            100% { transform: scale(0.95); box-shadow: 0 0 0 0 rgba(16, 185, 129, 0); }
        }

        /* UTC Time Reset Bar Card */
        .reset-card {
            background: var(--card-bg);
            border: 1px solid var(--border-color);
            border-radius: 14px;
            padding: 1.25rem;
            margin-bottom: 1.5rem;
            backdrop-filter: blur(12px);
            box-shadow: 0 10px 25px -5px rgba(0, 0, 0, 0.3);
            position: relative;
            overflow: hidden;
        }

        .reset-card::before {
            content: '';
            position: absolute;
            top: 0; left: 0; right: 0;
            height: 2px;
            background: linear-gradient(90deg, #f38020, #06b6d4);
        }

        .reset-header {
            display: flex;
            justify-content: space-between;
            align-items: center;
            margin-bottom: 0.75rem;
            flex-wrap: wrap;
            gap: 0.5rem;
        }

        .reset-title {
            display: flex;
            align-items: center;
            gap: 0.5rem;
            font-size: 0.95rem;
            font-weight: 600;
            color: var(--text-primary);
        }

        .reset-title svg { width: 18px; height: 18px; color: var(--cf-orange); }

        .reset-meta {
            display: flex;
            align-items: center;
            gap: 1rem;
            font-size: 0.85rem;
            color: var(--text-secondary);
        }

        .clock-pill {
            background: var(--btn-bg);
            padding: 0.25rem 0.6rem;
            border-radius: 6px;
            font-family: var(--font-main);
            font-weight: 600;
            color: var(--clock-text);
            border: 1px solid var(--clock-border);
        }

        /* Animated Progress Bars */
        .bar-bg {
            background: var(--input-bg);
            height: 12px;
            border-radius: 9999px;
            overflow: hidden;
            position: relative;
            box-shadow: inset 0 2px 4px rgba(0, 0, 0, 0.2);
        }

        .bar-fill {
            height: 100%;
            border-radius: 9999px;
            transition: width 1s cubic-bezier(0.4, 0, 0.2, 1);
            animation: fillBar 1.2s cubic-bezier(0.16, 1, 0.3, 1) ease-out;
            position: relative;
            overflow: hidden;
        }

        .bar-fill::after {
            content: '';
            position: absolute;
            top: 0; left: 0; right: 0; bottom: 0;
            background: linear-gradient(
                90deg, 
                rgba(255,255,255,0) 0%, 
                rgba(255,255,255,0.25) 50%, 
                rgba(255,255,255,0) 100%
            );
            background-size: 200px 100%;
            animation: shimmer 2.5s infinite;
        }

        .time-bar-fill {
            background: linear-gradient(90deg, #f38020, #3b82f6);
        }

        @keyframes fillBar {
            from { width: 0%; }
        }

        @keyframes shimmer {
            0% { background-position: -200px 0; }
            100% { background-position: 200px 0; }
        }

        .reset-sub {
            display: flex;
            justify-content: space-between;
            margin-top: 0.5rem;
            font-size: 0.8rem;
            color: var(--text-muted);
        }

        /* Overview Metrics Grid */
        .metrics-grid {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(160px, 1fr));
            gap: 0.75rem;
            margin-bottom: 1.5rem;
        }

        .metric-card {
            background: var(--card-bg);
            border: 1px solid var(--border-color);
            border-radius: 12px;
            padding: 1rem;
            backdrop-filter: blur(12px);
        }

        .metric-label {
            font-size: 0.78rem;
            color: var(--text-secondary);
            margin-bottom: 0.35rem;
            text-transform: uppercase;
            letter-spacing: 0.04em;
        }

        .metric-value {
            font-size: 1.25rem;
            font-weight: 700;
            color: var(--text-highlight);
        }

        .section-title {
            font-size: 1.1rem;
            font-weight: 600;
            margin-bottom: 1rem;
            display: flex;
            align-items: center;
            gap: 0.5rem;
        }

        /* Account Cards */
        .card {
            background: var(--card-bg);
            border: 1px solid var(--border-color);
            border-radius: 12px;
            padding: 1.25rem;
            margin-bottom: 1rem;
            backdrop-filter: blur(12px);
            transition: transform 0.2s ease, border-color 0.2s ease, box-shadow 0.2s ease;
        }

        .card:hover {
            border-color: var(--text-muted);
            box-shadow: 0 12px 20px -5px rgba(0, 0, 0, 0.2);
            background: var(--card-hover);
        }

        .card-header {
            display: flex;
            justify-content: space-between;
            align-items: center;
            margin-bottom: 0.85rem;
            flex-wrap: wrap;
            gap: 0.75rem;
        }

        .account-title {
            display: flex;
            align-items: center;
            gap: 0.6rem;
        }

        .account-icon {
            width: 18px;
            height: 18px;
            color: var(--text-secondary);
            flex-shrink: 0;
        }

        .account-name {
            font-weight: 600;
            font-size: 1rem;
            color: var(--text-highlight);
            word-break: break-word;
        }

        .usage-stats {
            display: flex;
            align-items: center;
            gap: 0.75rem;
            font-family: var(--font-main);
        }

        .usage-count {
            font-size: 0.9rem;
            font-weight: 600;
            color: var(--text-secondary);
            font-family: inherit;
        }

        .pct-badge {
            font-size: 0.78rem;
            font-weight: 700;
            padding: 0.2rem 0.55rem;
            border-radius: 6px;
            letter-spacing: 0.02em;
        }

        .badge-normal { background: rgba(59, 130, 246, 0.15); color: #60a5fa; border: 1px solid rgba(59, 130, 246, 0.3); }
        .badge-warning { background: rgba(245, 158, 11, 0.15); color: #fbbf24; border: 1px solid rgba(245, 158, 11, 0.3); }
        .badge-danger  { background: rgba(239, 68, 68, 0.15); color: #f87171; border: 1px solid rgba(239, 68, 68, 0.3); }

        .error-badge {
            display: flex;
            align-items: center;
            gap: 0.4rem;
            color: #f87171;
            background: rgba(239, 68, 68, 0.1);
            border: 1px solid rgba(239, 68, 68, 0.25);
            padding: 0.5rem 0.75rem;
            border-radius: 8px;
            font-size: 0.83rem;
            margin-top: 0.75rem;
        }

        /* Note & Links Section inside Card */
        .card-meta-section {
            margin-top: 1.25rem;
            border-top: 1px solid var(--border-color);
            padding-top: 1rem;
            display: flex;
            flex-direction: column;
            gap: 0.75rem;
        }

        .note-container {
            display: flex;
            align-items: flex-start;
            gap: 0.5rem;
            background: var(--note-bg);
            padding: 0.6rem 0.8rem;
            border-radius: 8px;
            border: 1px solid var(--note-border);
            position: relative;
        }

        .note-icon {
            color: var(--cf-orange);
            font-size: 1rem;
            margin-top: 0.1rem;
        }

        .note-content {
            font-size: 0.88rem;
            color: var(--text-primary);
            line-height: 1.4;
            flex-grow: 1;
            cursor: pointer;
            min-height: 1.25rem;
            white-space: pre-wrap;
        }

        .note-edit-wrapper {
            display: flex;
            flex-direction: column;
            gap: 0.5rem;
        }

        .note-input {
            width: 100%;
            background: var(--input-bg);
            border: 1px solid var(--cf-orange);
            border-radius: 6px;
            color: var(--text-primary);
            font-family: inherit;
            font-size: 0.88rem;
            padding: 0.4rem;
            resize: vertical;
            min-height: 3.5rem;
        }

        .note-input:focus {
            outline: none;
            box-shadow: 0 0 8px rgba(243, 128, 32, 0.25);
        }

        .note-actions {
            display: flex;
            gap: 0.4rem;
            justify-content: flex-end;
        }

        .btn-sm {
            padding: 0.25rem 0.6rem;
            font-size: 0.78rem;
            border-radius: 6px;
        }

        .note-edit-icon {
            color: var(--text-muted);
            cursor: pointer;
            font-size: 0.95rem;
            transition: color 0.2s ease;
        }

        .note-container:hover .note-edit-icon {
            color: var(--text-secondary);
        }

        /* Links Row: Horizontal Desktop, wrapped Mobile */
        .links-row {
            display: flex;
            flex-direction: row;
            gap: 0.5rem;
            flex-wrap: nowrap;
            overflow-x: auto;
            padding-bottom: 0.25rem;
        }

        .links-row::-webkit-scrollbar {
            height: 4px;
        }

        .links-row::-webkit-scrollbar-thumb {
            background: var(--scrollbar-thumb);
            border-radius: 2px;
        }

        .link-slot {
            display: flex;
            align-items: center;
            background: var(--input-bg);
            border: 1px solid var(--border-color);
            border-radius: 8px;
            padding: 0.4rem 0.75rem;
            gap: 0.5rem;
            flex-shrink: 0;
            position: relative;
            transition: all 0.2s ease;
        }

        .link-slot:hover {
            border-color: var(--text-muted);
            background: var(--btn-hover);
        }

        .link-anchor {
            color: var(--accent-cyan);
            text-decoration: none;
            font-size: 0.85rem;
            font-weight: 500;
            display: flex;
            align-items: center;
            gap: 0.4rem;
        }

        .link-anchor:hover {
            text-decoration: underline;
        }

        .delete-link-btn {
            background: none;
            border: none;
            color: var(--text-muted);
            cursor: pointer;
            padding: 0.1rem;
            border-radius: 4px;
            display: flex;
            align-items: center;
            justify-content: center;
            font-size: 0.85rem;
            transition: color 0.2s ease, background 0.2s ease;
        }

        .delete-link-btn:hover {
            color: #ef4444;
            background: rgba(239, 68, 68, 0.1);
        }

        .add-link-btn {
            background: rgba(6, 182, 212, 0.05);
            border: 1px dashed rgba(6, 182, 212, 0.3);
            border-radius: 8px;
            color: var(--accent-cyan);
            padding: 0.4rem 0.75rem;
            cursor: pointer;
            font-family: inherit;
            font-size: 0.85rem;
            font-weight: 500;
            display: flex;
            align-items: center;
            gap: 0.4rem;
            transition: all 0.2s ease;
        }

        .add-link-btn:hover {
            background: rgba(6, 182, 212, 0.1);
            border-color: var(--accent-cyan);
        }

        /* Modals & Dialogs */
        .modal {
            display: none;
            position: fixed;
            z-index: 100;
            left: 0;
            top: 0;
            width: 100%;
            height: 100%;
            background-color: rgba(0, 0, 0, 0.6);
            backdrop-filter: blur(4px);
            align-items: center;
            justify-content: center;
            padding: 1rem;
        }

        .modal-content {
            background-color: var(--modal-bg);
            border: 1px solid var(--border-color);
            border-radius: 16px;
            width: 100%;
            max-width: 550px;
            box-shadow: 0 20px 25px -5px rgba(0, 0, 0, 0.5);
            animation: modalFadeIn 0.25s cubic-bezier(0.16, 1, 0.3, 1);
            overflow: hidden;
        }

        @keyframes modalFadeIn {
            from { transform: scale(0.95); opacity: 0; }
            to { transform: scale(1); opacity: 1; }
        }

        .modal-header {
            padding: 1.25rem 1.5rem;
            border-bottom: 1px solid var(--border-color);
            display: flex;
            justify-content: space-between;
            align-items: center;
        }

        .modal-title {
            font-size: 1.1rem;
            font-weight: 600;
            display: flex;
            align-items: center;
            gap: 0.5rem;
        }

        .close-modal-btn {
            background: none;
            border: none;
            color: var(--text-secondary);
            font-size: 1.25rem;
            cursor: pointer;
            transition: color 0.2s ease;
        }

        .close-modal-btn:hover {
            color: var(--text-highlight);
        }

        .modal-body {
            padding: 1.5rem;
            max-height: 70vh;
            overflow-y: auto;
        }

        .modal-footer {
            padding: 1.25rem 1.5rem;
            border-top: 1px solid var(--border-color);
            display: flex;
            justify-content: flex-end;
            gap: 0.75rem;
        }

        /* Form Controls */
        .form-group {
            margin-bottom: 1.25rem;
        }

        .form-group:last-child {
            margin-bottom: 0;
        }

        .form-label {
            display: block;
            font-size: 0.85rem;
            font-weight: 500;
            color: var(--text-secondary);
            margin-bottom: 0.5rem;
        }

        .form-control {
            width: 100%;
            background: var(--input-bg);
            border: 1px solid var(--border-color);
            border-radius: 8px;
            color: var(--text-primary);
            padding: 0.6rem 0.80rem;
            font-family: inherit;
            font-size: 0.9rem;
            transition: border-color 0.2s ease, box-shadow 0.2s ease;
        }

        .form-control:focus {
            outline: none;
            border-color: var(--cf-orange);
            box-shadow: 0 0 8px rgba(243, 128, 32, 0.2);
        }

        /* Manage Accounts UI */
        .accounts-list-container {
            display: flex;
            flex-direction: column;
            gap: 0.75rem;
            margin-bottom: 1.5rem;
        }

        .manage-account-item {
            display: flex;
            align-items: center;
            justify-content: space-between;
            background: var(--note-bg);
            border: 1px solid var(--border-color);
            border-radius: 10px;
            padding: 0.75rem 1rem;
            gap: 1rem;
        }

        .manage-account-info {
            display: flex;
            flex-direction: column;
            gap: 0.25rem;
            flex-grow: 1;
            min-width: 0;
        }

        .manage-account-name {
            font-weight: 600;
            font-size: 0.9rem;
            color: var(--text-highlight);
            white-space: nowrap;
            overflow: hidden;
            text-overflow: ellipsis;
        }

        .manage-account-id {
            font-size: 0.75rem;
            color: var(--text-muted);
            font-family: inherit;
            white-space: nowrap;
            overflow: hidden;
            text-overflow: ellipsis;
        }

        .manage-account-actions {
            display: flex;
            gap: 0.35rem;
            flex-shrink: 0;
        }

        .icon-btn {
            background: var(--input-bg);
            border: 1px solid var(--border-color);
            color: var(--text-secondary);
            width: 32px;
            height: 32px;
            border-radius: 6px;
            display: flex;
            align-items: center;
            justify-content: center;
            cursor: pointer;
            transition: all 0.2s ease;
        }

        .icon-btn:hover {
            background: var(--btn-hover);
            color: var(--text-highlight);
        }

        .icon-btn-danger:hover {
            background: rgba(239, 68, 68, 0.15);
            border-color: rgba(239, 68, 68, 0.3);
            color: #f87171;
        }

        .divider {
            height: 1px;
            background: var(--border-color);
            margin: 1.5rem 0;
        }

        .section-subtitle {
            font-size: 0.9rem;
            font-weight: 600;
            color: var(--text-secondary);
            margin-bottom: 0.75rem;
            text-transform: uppercase;
            letter-spacing: 0.03em;
        }

        /* Empty Container */
        .empty-container {
            max-width: 500px;
            margin: 4rem auto;
            text-align: center;
            background: var(--card-bg);
            border: 1px solid var(--border-color);
            border-radius: 16px;
            padding: 2.5rem 1.5rem;
            backdrop-filter: blur(12px);
        }
        .empty-container h2 { font-size: 1.4rem; margin-bottom: 0.75rem; color: var(--cf-orange); }
        .empty-container p { color: var(--text-secondary); font-size: 0.95rem; line-height: 1.5; }

        /* Footer */
        footer {
            margin-top: 3rem;
            padding: 2rem 0 1rem 0;
            border-top: 1px solid var(--border-color);
            text-align: center;
            color: var(--text-secondary);
            font-size: 0.85rem;
        }

        .footer-container {
            display: flex;
            flex-direction: column;
            gap: 0.6rem;
            align-items: center;
        }

        .footer-credits {
            display: flex;
            align-items: center;
            gap: 0.35rem;
            flex-wrap: wrap;
            justify-content: center;
        }

        .dev-link {
            color: var(--cf-orange);
            text-decoration: none;
            font-weight: 500;
            transition: color 0.2s ease;
        }

        .dev-link:hover {
            color: #faad3f;
            text-decoration: underline;
        }

        .heart { color: #ef4444; }

        .footer-badge {
            font-size: 0.75rem;
            color: var(--text-muted);
            background: var(--input-bg);
            padding: 0.25rem 0.6rem;
            border-radius: 9999px;
            border: 1px solid var(--border-color);
            margin-top: 0.25rem;
        }

        /* Responsive Breakpoints */
        @media (max-width: 640px) {
            body { padding: 1rem 0.75rem; }
            h1 { font-size: 1.25rem; }
            .card-header { flex-direction: column; align-items: flex-start; gap: 0.4rem; }
            .usage-stats { width: 100%; justify-content: space-between; margin-top: 0.25rem; }
            .reset-header { flex-direction: column; align-items: flex-start; }
            .reset-meta { width: 100%; justify-content: space-between; margin-top: 0.25rem; }
            .metrics-grid { grid-template-columns: repeat(2, 1fr); }

            /* Wrap link slots on Mobile cleanly */
            .links-row {
                flex-wrap: wrap;
            }
        }
    </style>
</head>
<body>
    <div class="container">
        <header>
            <div class="brand">
                <div class="cf-logo">
                    <svg viewBox="0 0 24 24">
                        <path d="M19.35 10.04C18.67 6.59 15.64 4 12 4 9.11 4 6.6 5.64 5.35 8.04 2.34 8.36 0 10.91 0 14c0 3.31 2.69 6 6 6h13c2.76 0 5-2.24 5-5 0-2.64-2.05-4.78-4.65-4.96z"/>
                    </svg>
                </div>
                <div>
                    <h1 data-i18n="brand-title">Cloudflare Workers Usage</h1>
                    <span style="font-size: 0.8rem; color: var(--text-secondary);" data-i18n="brand-subtitle">Daily Invocation Tracker</span>
                </div>
            </div>
            <div class="header-actions">
                <div class="selector-group">
                    <button class="btn" id="theme-toggle-btn" onclick="toggleTheme()" title="Switch Theme">
                        <i class="ti ti-device-desktop" id="theme-toggle-icon"></i>
                        <span id="theme-toggle-text" data-i18n="theme-system">System</span>
                    </button>
                    <button class="btn" id="lang-toggle-btn" onclick="toggleLanguage()" title="Switch Language">
                        <i class="ti ti-language"></i>
                        <span id="lang-toggle-text">English</span>
                    </button>
                </div>
                <button class="btn" id="lock-btn" onclick="openPasswordModal()">
                    <i class="ti ti-lock"></i>
                    <span id="lock-text" data-i18n="unlock-settings">Unlock Settings</span>
                </button>
                <button class="btn btn-primary" onclick="openManageAccountsModal()">
                    <i class="ti ti-settings"></i>
                    <span data-i18n="manage-accounts">Manage Accounts</span>
                </button>
                <div class="status-badge">
                    <span class="pulse-dot"></span>
                    <span data-i18n="live-edge-data">Live Edge Data</span>
                </div>
            </div>
        </header>

        <!-- Top Reset Clock & Time Passed Bar -->
        <div class="reset-card">
            <div class="reset-header">
                <div class="reset-title">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <circle cx="12" cy="12" r="10" />
                        <polyline points="12 6 12 12 16 14" />
                    </svg>
                    <span data-i18n="quota-title">Cloudflare Quota Day Progress (UTC Reset)</span>
                </div>
                <div class="reset-meta">
                    <span id="utc-clock" class="clock-pill">${timeFormatted}</span>
                    <span id="utc-pct-badge" class="pct-badge badge-normal" style="background: rgba(243, 128, 32, 0.15); color: #f38020; border-color: rgba(243, 128, 32, 0.3);">${dayProgressPct}%</span>
                </div>
            </div>
            <div class="bar-bg">
                <div id="utc-bar-fill" class="bar-fill time-bar-fill" style="width: ${dayProgressPct}%;"></div>
            </div>
            <div class="reset-sub">
                <span id="utc-elapsed">⏱️ ${timeElapsedFormatted} elapsed</span>
                <span id="utc-remaining">⏳ ${remH}h ${remM}m until 00:00 UTC reset</span>
            </div>
        </div>

        <!-- Metrics Overview Grid -->
        <div class="metrics-grid">
            <div class="metric-card">
                <div class="metric-label" data-i18n="metric-monitored">Monitored Accounts</div>
                <div class="metric-value" data-raw-val="${results.length}">${results.length}</div>
            </div>
            <div class="metric-card">
                <div class="metric-label" data-i18n="metric-requests">Total Requests Today</div>
                <div class="metric-value" data-raw-val="${formattedTotalReqs}">${formattedTotalReqs}</div>
            </div>
            <div class="metric-card">
                <div class="metric-label" data-i18n="metric-free">Total Free Quota</div>
                <div class="metric-value" data-raw-val="${formattedTotalLimit}">${formattedTotalLimit}</div>
            </div>
            <div class="metric-card">
                <div class="metric-label" data-i18n="metric-usage">Overall Usage</div>
                <div class="metric-value" data-raw-val="${overallPct}%" style="color: ${overallPct > 75 ? '#f97316' : '#38bdf8'}">${overallPct}%</div>
            </div>
        </div>

        <div class="section-title">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <rect x="3" y="3" width="7" height="7" rx="1" />
                <rect x="14" y="3" width="7" height="7" rx="1" />
                <rect x="14" y="14" width="7" height="7" rx="1" />
                <rect x="3" y="14" width="7" height="7" rx="1" />
            </svg>
            <span data-i18n="breakdown-title">Account Usage Breakdown</span>
        </div>

        ${emptyStateHtml}

        <div class="account-list">
            ${cardsHtml}
        </div>
    </div>

    <!-- Setup Password Modal (Startup) -->
    <div class="modal" id="setup-password-modal">
        <div class="modal-content" style="max-width: 420px;">
            <div class="modal-header">
                <div class="modal-title">
                    <i class="ti ti-shield-lock"></i>
                    <span data-i18n="modal-setup-title">Create Admin Password</span>
                </div>
            </div>
            <div class="modal-body">
                <p style="font-size: 0.85rem; color: var(--text-secondary); margin-bottom: 1rem;" data-i18n="modal-setup-desc">
                    Welcome! Set an administrator password to secure your dashboard settings and Cloudflare accounts.
                </p>
                <div class="form-group">
                    <label class="form-label" for="setup-password-input" data-i18n="setup-password-label">New Admin Password</label>
                    <input type="password" class="form-control" id="setup-password-input" placeholder="••••••••" />
                </div>
                <div class="form-group">
                    <label class="form-label" for="setup-password-confirm-input" data-i18n="setup-confirm-label">Confirm Password</label>
                    <input type="password" class="form-control" id="setup-password-confirm-input" placeholder="••••••••" onkeydown="if(event.key === 'Enter') submitSetupPassword()" />
                </div>
                <div style="color: #f87171; font-size: 0.8rem; margin-top: 0.5rem; display: none;" id="setup-password-error"></div>
            </div>
            <div class="modal-footer">
                <button class="btn btn-primary" style="width: 100%;" onclick="submitSetupPassword()" data-i18n="btn-create-password">Create Password</button>
            </div>
        </div>
    </div>

    <!-- Password Modal -->
    <div class="modal" id="password-modal">
        <div class="modal-content" style="max-width: 400px;">
            <div class="modal-header">
                <div class="modal-title">
                    <i class="ti ti-lock"></i>
                    <span data-i18n="modal-password-title">Enter Admin Password</span>
                </div>
                <button class="close-modal-btn" onclick="closeModal('password-modal')">×</button>
            </div>
            <div class="modal-body">
                <p style="font-size: 0.85rem; color: var(--text-secondary); margin-bottom: 1rem;" data-i18n="modal-password-desc">
                    Enter your administrator password to unlock settings and manage accounts.
                </p>
                <div class="form-group">
                    <label class="form-label" for="admin-password-input" data-i18n="password-label">Password</label>
                    <input type="password" class="form-control" id="admin-password-input" placeholder="••••••••" onkeydown="if(event.key === 'Enter') submitPassword()" />
                </div>
                <div style="color: #f87171; font-size: 0.8rem; margin-top: 0.5rem; display: none;" id="password-error" data-i18n="password-error">
                    Invalid password.
                </div>
            </div>
            <div class="modal-footer">
                <button class="btn" onclick="closeModal('password-modal')" data-i18n="btn-cancel">Cancel</button>
                <button class="btn btn-primary" onclick="submitPassword()" data-i18n="btn-unlock">Unlock</button>
            </div>
        </div>
    </div>

    <!-- Add Link Modal -->
    <div class="modal" id="add-link-modal">
        <div class="modal-content" style="max-width: 420px;">
            <div class="modal-header">
                <div class="modal-title">
                    <i class="ti ti-plus"></i>
                    <span data-i18n="modal-add-link-title">Add Custom Link</span>
                </div>
                <button class="close-modal-btn" onclick="closeModal('add-link-modal')">×</button>
            </div>
            <div class="modal-body">
                <input type="hidden" id="add-link-account-id" />
                <div class="form-group">
                    <label class="form-label" for="link-title-input" data-i18n="link-title-label">Link Title</label>
                    <input type="text" class="form-control" id="link-title-input" placeholder="e.g. Workers Logs" />
                </div>
                <div class="form-group">
                    <label class="form-label" for="link-url-input" data-i18n="link-url-label">URL</label>
                    <input type="url" class="form-control" id="link-url-input" placeholder="https://..." />
                </div>
                <div class="form-group">
                    <label class="form-label" for="link-icon-input" data-i18n="link-icon-label">Tabler Icon Name</label>
                    <input type="text" class="form-control" id="link-icon-input" placeholder="e.g. server, link, cloud, brand-github" />
                    <span style="font-size: 0.75rem; color: var(--text-muted); margin-top: 0.25rem; display: block;" data-i18n="link-icon-desc">
                        Supported icons list: <a href="https://tabler.io/icons" target="_blank" rel="noopener" style="color: var(--cf-orange);">tabler.io/icons</a>
                    </span>
                </div>
            </div>
            <div class="modal-footer">
                <button class="btn" onclick="closeModal('add-link-modal')" data-i18n="btn-cancel">Cancel</button>
                <button class="btn btn-primary" onclick="submitAddLink()" data-i18n="btn-add-link">Add Link</button>
            </div>
        </div>
    </div>

    <!-- Manage Accounts Modal -->
    <div class="modal" id="manage-accounts-modal">
        <div class="modal-content">
            <div class="modal-header">
                <div class="modal-title">
                    <i class="ti ti-settings"></i>
                    <span data-i18n="modal-manage-title">Manage Cloudflare Accounts</span>
                </div>
                <button class="close-modal-btn" onclick="closeModal('manage-accounts-modal')">×</button>
            </div>
            <div class="modal-body">
                <div class="section-subtitle" data-i18n="active-accounts-title">Active Accounts</div>
                <div class="accounts-list-container" id="manage-accounts-list">
                    <!-- Dynamic -->
                </div>

                <div class="divider"></div>

                <div class="section-subtitle" id="add-edit-account-title" data-i18n="add-new-account-title">Add New Account</div>
                <input type="hidden" id="edit-account-index" value="-1" />
                <div class="form-group">
                    <label class="form-label" for="account-name-input" data-i18n="account-name-label">Display Name</label>
                    <input type="text" class="form-control" id="account-name-input" placeholder="Production Main" />
                </div>
                <div class="form-group">
                    <label class="form-label" for="account-id-input" data-i18n="account-id-label">Cloudflare Account ID</label>
                    <input type="text" class="form-control" id="account-id-input" placeholder="bc5e10cea180fa82..." />
                </div>
                <div class="form-group">
                    <label class="form-label" for="account-token-input" data-i18n="account-token-label">Cloudflare API Token</label>
                    <input type="password" class="form-control" id="account-token-input" placeholder="••••••••••••••••••••••••••••••••" />
                </div>
                <div style="display: flex; gap: 0.5rem; justify-content: flex-end;">
                    <button class="btn" id="cancel-account-edit-btn" onclick="resetAccountForm()" data-i18n="btn-cancel-edit" style="display: none;">Cancel Edit</button>
                    <button class="btn btn-primary" onclick="saveAccountItem()" data-i18n="btn-save-account">Save Account</button>
                </div>
            </div>
            <div class="modal-footer">
                <button class="btn" onclick="closeModal('manage-accounts-modal')" data-i18n="btn-close">Close</button>
            </div>
        </div>
    </div>

    <!-- Footer with Developer & Copyright Placeholders -->
    <footer>
        <div class="footer-container">
            <div class="footer-copyright">
                © <span id="year">2026</span> <span data-i18n="footer-rights">Cloudflare Workers Usage Dashboard. All rights reserved.</span>
            </div>
            <div class="footer-credits">
                <span data-i18n="footer-developed">Developed with</span>
                <span class="heart">❤️</span>
                <span data-i18n="footer-by">by</span>
                <a href="https://ajbv.ir" class="dev-link" target="_blank" rel="noopener">Mehdi Chamani</a>
            </div>
            <div class="footer-badge" data-i18n="footer-powered">
                Powered by Cloudflare Workers & Cloudflare KV
            </div>
        </div>
    </footer>

    <script>
        // Set dynamic copyright year
        document.getElementById('year').textContent = new Date().getFullYear();

        // Backend states injected SSR
        const accountsData = ${JSON.stringify(frontendAccountsData)};
        const fullMetaMap = new Map(${JSON.stringify(frontendFullData)}.map(x => [x.account_id, x.meta]));
        const isPasswordConfigured = ${hasPasswordConfigured};

        // 1. Translations dictionary
        const translations = {
            "en": {
                "brand-title": "Cloudflare Workers Usage",
                "brand-subtitle": "Daily Invocation Tracker",
                "theme-system": "System",
                "theme-light": "Light",
                "theme-dark": "Dark",
                "unlock-settings": "Unlock Settings",
                "unlocked": "Unlocked (Lock)",
                "relock-settings": "Lock Settings",
                "btn-save-note": "Save",
                "manage-accounts": "Manage Accounts",
                "live-edge-data": "Live Edge Data",
                "quota-title": "Cloudflare Quota Day Progress (UTC Reset)",
                "metric-monitored": "Monitored Accounts",
                "metric-requests": "Total Requests Today",
                "metric-free": "Total Free Quota",
                "metric-usage": "Overall Usage",
                "breakdown-title": "Account Usage Breakdown",
                "no-notes": "No notes added yet.",
                "no-notes-input-placeholder": "Add any notes here (e.g. environment, tier, custom notes)...",
                "modal-password-title": "Enter Admin Password",
                "modal-password-desc": "Enter your administrator password to unlock settings and manage accounts.",
                "password-label": "Password",
                "password-error": "Invalid password.",
                "modal-setup-title": "Create Admin Password",
                "modal-setup-desc": "Welcome! Set an administrator password to secure your dashboard settings and Cloudflare accounts.",
                "setup-password-label": "New Admin Password",
                "setup-confirm-label": "Confirm Password",
                "btn-create-password": "Create Password",
                "password-mismatch": "Passwords do not match.",
                "password-empty": "Password cannot be empty.",
                "btn-cancel": "Cancel",
                "btn-unlock": "Unlock",
                "modal-add-link-title": "Add Custom Link",
                "link-title-label": "Link Title",
                "link-url-label": "URL",
                "link-icon-label": "Tabler Icon Name",
                "link-icon-desc": "Supported icons list: tabler.io/icons",
                "btn-add-link": "Add Link",
                "modal-manage-title": "Manage Cloudflare Accounts",
                "active-accounts-title": "Active Accounts",
                "add-new-account-title": "Add New Account",
                "account-name-label": "Display Name",
                "account-id-label": "Cloudflare Account ID",
                "account-token-label": "Cloudflare API Token",
                "btn-cancel-edit": "Cancel Edit",
                "btn-save-account": "Save Account",
                "btn-close": "Close",
                "footer-rights": "Cloudflare Workers Usage Dashboard. All rights reserved.",
                "footer-developed": "Developed with",
                "footer-by": "by",
                "footer-powered": "Powered by Cloudflare Workers & Cloudflare KV",
                "alert-req-fields": "Title and URL are required.",
                "alert-max-links": "Maximum of 5 links reached.",
                "alert-acc-req": "Account Name and Account ID are required.",
                "alert-token-req": "API Token is required for new accounts.",
                "confirm-delete-link": "Are you sure you want to delete this link?",
                "confirm-delete-acc": "Are you sure you want to delete this account? This will also remove metadata from KV."
            },
            "fa": {
                "brand-title": "میزان مصرف ورکرز کلودفلر",
                "brand-subtitle": "پایشگر مصرف روزانه ورکرها",
                "theme-system": "سیستم",
                "theme-light": "روشن",
                "theme-dark": "تاریک",
                "unlock-settings": "باز کردن قفل تنظیمات",
                "unlocked": "قفل باز شد (قفل مجدد)",
                "relock-settings": "قفل کردن تنظیمات",
                "btn-save-note": "ذخیره",
                "manage-accounts": "مدیریت اکانت‌ها",
                "live-edge-data": "دیتا زنده شبکه",
                "quota-title": "میزان پیشرفت روزانه سهمیه کلودفلر (ریست UTC)",
                "metric-monitored": "اکانت‌های پایش شده",
                "metric-requests": "درخواست‌های امروز",
                "metric-free": "مجموع سهمیه رایگان",
                "metric-usage": "میزان کل مصرف",
                "breakdown-title": "جزئیات مصرف اکانت‌ها",
                "no-notes": "هنوز یادداشتی اضافه نشده است.",
                "no-notes-input-placeholder": "یادداشتی اضافه کنید (مثلاً محیط برنامه‌نویسی، محدودیت‌ها یا یادداشت‌های دیگر)...",
                "modal-password-title": "وارد کردن رمز عبور مدیریت",
                "modal-password-desc": "برای باز کردن قفل تنظیمات و مدیریت اکانت‌ها، رمز عبور مدیریت را وارد کنید.",
                "password-label": "رمز عبور",
                "password-error": "رمز عبور نامعتبر است.",
                "modal-setup-title": "ایجاد رمز عبور مدیریت",
                "modal-setup-desc": "خوش آمدید! لطفاً یک رمز عبور مدیریت برای حفاظت از تنظیمات داشبورد و اکانت‌های کلودفلر تعیین نمایید.",
                "setup-password-label": "رمز عبور جدید مدیریت",
                "setup-confirm-label": "تکرار رمز عبور",
                "btn-create-password": "ایجاد رمز عبور",
                "password-mismatch": "رمز عبور و تکرار آن یکسان نیستند.",
                "password-empty": "رمز عبور نمی‌تواند خالی باشد.",
                "btn-cancel": "لغو",
                "btn-unlock": "باز کردن قفل",
                "modal-add-link-title": "افزودن لینک دلخواه",
                "link-title-label": "عنوان لینک",
                "link-url-label": "آدرس (URL) لینک",
                "link-icon-label": "نام آیکون Tabler",
                "link-icon-desc": "لیست آیکون‌های پشتیبانی شده: tabler.io/icons",
                "btn-add-link": "افزودن لینک",
                "modal-manage-title": "مدیریت اکانت‌های کلودفلر",
                "active-accounts-title": "اکانت‌های فعال",
                "add-new-account-title": "افزودن اکانت جدید",
                "account-name-label": "نام نمایشی اکانت",
                "account-id-label": "شناسه اکانت (Account ID)",
                "account-token-label": "توکن API کلودفلر",
                "btn-cancel-edit": "لغو ویرایش",
                "btn-save-account": "ذخیره اکانت",
                "btn-close": "بستن",
                "footer-rights": "داشبورد پایش مصرف ورکرز کلودفلر. تمامی حقوق محفوظ است.",
                "footer-developed": "توسعه یافته با",
                "footer-by": "توسط",
                "footer-powered": "قدرت گرفته از Cloudflare Workers و Cloudflare KV",
                "alert-req-fields": "وارد کردن عنوان و آدرس لینک الزامی است.",
                "alert-max-links": "حداکثر ظرفیت ۵ لینک تکمیل شده است.",
                "alert-acc-req": "وارد کردن نام و شناسه اکانت الزامی است.",
                "alert-token-req": "برای اکانت‌های جدید وارد کردن توکن API الزامی است.",
                "confirm-delete-link": "آیا از حذف این لینک اطمینان دارید؟",
                "confirm-delete-acc": "آیا از حذف این اکانت اطمینان دارید؟ با این کار تمامی متادیتای اکانت نیز از KV پاک خواهد شد."
            }
        };

        // 2. Language management & digit formatting
        let currentLang = localStorage.getItem('language_preference') || 'en';

        function toPersianDigits(str) {
            const pDigits = ['۰', '۱', '۲', '۳', '۴', '۵', '۶', '۷', '۸', '۹'];
            return String(str)
                .replace(/[0-9]/g, d => pDigits[parseInt(d, 10)])
                .replace(/,/g, '٬');
        }

        function toEnglishDigits(str) {
            const eDigits = { '۰':'0', '۱':'1', '۲':'2', '۳':'3', '۴':'4', '۵':'5', '۶':'6', '۷':'7', '۸':'8', '۹':'9' };
            return String(str)
                .replace(/[۰-۹]/g, d => eDigits[d])
                .replace(/٬/g, ',');
        }

        function formatDigits(str, lang) {
            const l = lang || currentLang;
            if (l === 'fa') {
                return toPersianDigits(str);
            }
            return toEnglishDigits(str);
        }

        function applyLanguage(lang) {
            currentLang = lang;
            localStorage.setItem('language_preference', lang);

            const langTextEl = document.getElementById('lang-toggle-text');
            if (langTextEl) {
                langTextEl.textContent = lang === 'fa' ? 'فارسی' : 'English';
            }

            if (lang === 'fa') {
                document.body.classList.add('rtl-mode');
                document.documentElement.setAttribute('dir', 'rtl');
                document.documentElement.setAttribute('lang', 'fa');
            } else {
                document.body.classList.remove('rtl-mode');
                document.documentElement.setAttribute('dir', 'ltr');
                document.documentElement.setAttribute('lang', 'en');
            }

            // Translate all elements with data-i18n
            document.querySelectorAll('[data-i18n]').forEach(el => {
                const key = el.getAttribute('data-i18n');
                if (translations[lang] && translations[lang][key]) {
                    el.textContent = translations[lang][key];
                }
            });

            // Format numbers in overview metric cards
            document.querySelectorAll('.metric-value[data-raw-val]').forEach(el => {
                const rawVal = el.getAttribute('data-raw-val');
                el.textContent = formatDigits(rawVal, lang);
            });

            // Format numbers in account breakdown card headers
            document.querySelectorAll('.usage-count[data-raw-reqs]').forEach(el => {
                const reqs = formatDigits(el.getAttribute('data-raw-reqs'), lang);
                const limit = formatDigits(el.getAttribute('data-raw-limit'), lang);
                el.textContent = reqs + ' / ' + limit;
            });

            // Format numbers in percentage badges
            document.querySelectorAll('.pct-badge[data-raw-pct]').forEach(el => {
                el.textContent = formatDigits(el.getAttribute('data-raw-pct'), lang);
            });

            // Format footer copyright year
            const yearEl = document.getElementById('year');
            if (yearEl) {
                yearEl.textContent = formatDigits(new Date().getFullYear(), lang);
            }

            // Initialize/translate empty note displays and note placeholders
            fullMetaMap.forEach((meta, accountId) => {
                const displayEl = document.getElementById('note-display-' + accountId);
                if (displayEl) {
                    displayEl.textContent = meta.note || translations[lang]["no-notes"];
                }
                const textareaEl = document.getElementById('note-input-' + accountId);
                if (textareaEl) {
                    textareaEl.setAttribute('placeholder', translations[lang]["no-notes-input-placeholder"]);
                }
            });

            // Update UTC reset clock bars immediately with correct language structure
            updateUtcResetBar();
            updatePasswordUI();
        }

        function toggleLanguage() {
            const nextLang = currentLang === 'en' ? 'fa' : 'en';
            applyLanguage(nextLang);
        }

        function changeLanguagePreference(lang) {
            applyLanguage(lang);
        }

        // 3. Theme management
        let currentTheme = localStorage.getItem('theme_preference') || 'system';

        function applyTheme(theme) {
            currentTheme = theme;
            localStorage.setItem('theme_preference', theme);

            const themeIconEl = document.getElementById('theme-toggle-icon');
            const themeTextEl = document.getElementById('theme-toggle-text');

            if (themeIconEl) {
                if (theme === 'light') {
                    themeIconEl.className = 'ti ti-sun';
                } else if (theme === 'dark') {
                    themeIconEl.className = 'ti ti-moon';
                } else {
                    themeIconEl.className = 'ti ti-device-desktop';
                }
            }

            if (themeTextEl) {
                themeTextEl.setAttribute('data-i18n', 'theme-' + theme);
                if (translations[currentLang] && translations[currentLang]['theme-' + theme]) {
                    themeTextEl.textContent = translations[currentLang]['theme-' + theme];
                }
            }

            const root = document.documentElement;
            root.classList.remove('theme-light', 'theme-dark');

            if (theme === 'light') {
                root.classList.add('theme-light');
            } else if (theme === 'dark') {
                root.classList.add('theme-dark');
            } else {
                // system fallback
                const isSystemDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
                root.classList.add(isSystemDark ? 'theme-dark' : 'theme-light');
            }
        }

        function toggleTheme() {
            const modes = ['system', 'light', 'dark'];
            const currentIndex = modes.indexOf(currentTheme);
            const nextTheme = modes[(currentIndex + 1) % modes.length];
            applyTheme(nextTheme);
        }

        function changeThemePreference(theme) {
            applyTheme(theme);
        }

        // Listen for system theme changes dynamically
        window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', e => {
            if (currentTheme === 'system') {
                applyTheme('system');
            }
        });

        // Initialize theme on load
        applyTheme(currentTheme);

        // Initialize state from local storage or defaults
        let cachedPassword = localStorage.getItem('dashboard_password') || '';

        // Apply Language and Direction on Load (this also triggers clock update and updatePasswordUI)
        applyLanguage(currentLang);

        // On first startup, automatically open setup password modal if no password is configured
        if (!isPasswordConfigured) {
            setTimeout(() => {
                openModal('setup-password-modal');
            }, 200);
        }

        function getAuthHeader() {
            return {
                "Authorization": "Bearer " + cachedPassword,
                "Content-Type": "application/json"
            };
        }

        function updatePasswordUI() {
            const lockBtn = document.getElementById('lock-btn');
            const lockText = document.getElementById('lock-text');
            if (!isPasswordConfigured) {
                lockBtn.style.background = 'rgba(243, 128, 32, 0.15)';
                lockBtn.style.borderColor = 'rgba(243, 128, 32, 0.3)';
                lockBtn.style.color = '#f38020';
                lockText.textContent = translations[currentLang]["btn-create-password"] || "Create Password";
                lockBtn.querySelector('i').className = 'ti ti-shield-lock';
            } else if (cachedPassword) {
                lockBtn.style.background = 'rgba(16, 185, 129, 0.15)';
                lockBtn.style.borderColor = 'rgba(16, 185, 129, 0.3)';
                lockBtn.style.color = '#34d399';
                lockText.textContent = translations[currentLang]["unlocked"];
                lockBtn.querySelector('i').className = 'ti ti-lock-open';
            } else {
                lockBtn.style.background = 'rgba(255, 255, 255, 0.05)';
                lockBtn.style.borderColor = 'var(--border-color)';
                lockBtn.style.color = 'var(--text-primary)';
                lockText.textContent = translations[currentLang]["unlock-settings"];
                lockBtn.querySelector('i').className = 'ti ti-lock';
            }
        }

        function requireUnlock() {
            if (!isPasswordConfigured) {
                openModal('setup-password-modal');
                return false;
            }
            if (!cachedPassword) {
                openPasswordModal();
                return false;
            }
            return true;
        }

        // Real-time Cloudflare UTC Reset Clock & Bar updater
        function updateUtcResetBar() {
            const now = new Date();
            const h = now.getUTCHours();
            const m = now.getUTCMinutes();
            const s = now.getUTCSeconds();
            const secsPassed = h * 3600 + m * 60 + s;
            const pct = ((secsPassed / 86400) * 100).toFixed(1);
            const remSecs = 86400 - secsPassed;
            const remH = Math.floor(remSecs / 3600);
            const remM = Math.floor((remSecs % 3600) / 60);

            const clockEl = document.getElementById('utc-clock');
            const elapsedEl = document.getElementById('utc-elapsed');
            const remainingEl = document.getElementById('utc-remaining');
            const barEl = document.getElementById('utc-bar-fill');
            const pctBadgeEl = document.getElementById('utc-pct-badge');

            const hPad = String(h).padStart(2, '0');
            const mPad = String(m).padStart(2, '0');
            const sPad = String(s).padStart(2, '0');

            if (clockEl) clockEl.textContent = formatDigits(hPad + ':' + mPad + ':' + sPad + ' UTC', currentLang);

            const isFarsi = currentLang === 'fa';
            if (elapsedEl) {
                const elapsedStr = isFarsi
                    ? "⏱️ " + h + " ساعت و " + m + " دقیقه گذشته"
                    : "⏱️ " + h + "h " + m + "m elapsed";
                elapsedEl.textContent = formatDigits(elapsedStr, currentLang);
            }
            if (remainingEl) {
                const remStr = isFarsi
                    ? "⏳ " + remH + " ساعت و " + remM + " دقیقه تا ریست 00:00 UTC"
                    : "⏳ " + remH + "h " + remM + "m until 00:00 UTC reset";
                remainingEl.textContent = formatDigits(remStr, currentLang);
            }
            if (barEl) barEl.style.width = pct + '%';
            if (pctBadgeEl) pctBadgeEl.textContent = formatDigits(pct + '%', currentLang);
        }

        setInterval(updateUtcResetBar, 1000);

        // Modals management
        function openModal(id) {
            document.getElementById(id).style.display = 'flex';
        }

        function closeModal(id) {
            document.getElementById(id).style.display = 'none';
        }

        function openPasswordModal() {
            if (!isPasswordConfigured) {
                openModal('setup-password-modal');
                return;
            }
            if (cachedPassword) {
                // Re-lock when already unlocked
                cachedPassword = '';
                localStorage.removeItem('dashboard_password');
                updatePasswordUI();
                return;
            }
            document.getElementById('admin-password-input').value = '';
            document.getElementById('password-error').style.display = 'none';
            openModal('password-modal');
        }

        async function submitSetupPassword() {
            const pwd = document.getElementById('setup-password-input').value;
            const confirmPwd = document.getElementById('setup-password-confirm-input').value;
            const errorEl = document.getElementById('setup-password-error');
            errorEl.style.display = 'none';

            if (!pwd) {
                errorEl.textContent = translations[currentLang]["password-empty"] || "Password cannot be empty.";
                errorEl.style.display = 'block';
                return;
            }

            if (pwd !== confirmPwd) {
                errorEl.textContent = translations[currentLang]["password-mismatch"] || "Passwords do not match.";
                errorEl.style.display = 'block';
                return;
            }

            try {
                const res = await fetch('/api/setup-password', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ password: pwd })
                });
                const result = await res.json();
                if (result.success) {
                    cachedPassword = pwd;
                    localStorage.setItem('dashboard_password', pwd);
                    closeModal('setup-password-modal');
                    location.reload();
                } else {
                    errorEl.textContent = result.error || "Error setting password.";
                    errorEl.style.display = 'block';
                }
            } catch (e) {
                errorEl.textContent = "Error connecting to server.";
                errorEl.style.display = 'block';
            }
        }

        async function submitPassword() {
            const pwd = document.getElementById('admin-password-input').value;
            const errorEl = document.getElementById('password-error');
            errorEl.style.display = 'none';

            try {
                const res = await fetch('/api/verify-password', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ password: pwd })
                });
                const result = await res.json();
                if (result.success) {
                    cachedPassword = pwd;
                    localStorage.setItem('dashboard_password', pwd);
                    updatePasswordUI();
                    closeModal('password-modal');
                    location.reload();
                } else {
                    errorEl.textContent = result.error || translations[currentLang]["password-error"];
                    errorEl.style.display = 'block';
                }
            } catch (e) {
                errorEl.textContent = "Error connecting to server.";
                errorEl.style.display = 'block';
            }
        }

        // Note Management (Inline Edit)
        function enableNoteEdit(accountId) {
            if (!requireUnlock()) return;
            const displayEl = document.getElementById('note-display-' + accountId);
            const wrapperEl = document.getElementById('note-edit-wrapper-' + accountId);
            const editIcon = document.getElementById('note-edit-icon-' + accountId);
            if (displayEl) displayEl.style.display = 'none';
            if (editIcon) editIcon.style.display = 'none';
            if (wrapperEl) wrapperEl.style.display = 'flex';
            const inputEl = document.getElementById('note-input-' + accountId);
            if (inputEl) inputEl.focus();
        }

        function cancelNoteEdit(accountId) {
            const displayEl = document.getElementById('note-display-' + accountId);
            const wrapperEl = document.getElementById('note-edit-wrapper-' + accountId);
            const editIcon = document.getElementById('note-edit-icon-' + accountId);
            const inputEl = document.getElementById('note-input-' + accountId);
            
            let meta = fullMetaMap.get(accountId) || { note: "", links: [] };
            if (inputEl) inputEl.value = meta.note || "";
            if (displayEl) displayEl.style.display = 'block';
            if (editIcon) editIcon.style.display = 'block';
            if (wrapperEl) wrapperEl.style.display = 'none';
        }

        async function saveNote(accountId) {
            const displayEl = document.getElementById('note-display-' + accountId);
            const wrapperEl = document.getElementById('note-edit-wrapper-' + accountId);
            const editIcon = document.getElementById('note-edit-icon-' + accountId);
            const inputEl = document.getElementById('note-input-' + accountId);
            const noteText = inputEl ? inputEl.value : "";

            if (displayEl) {
                displayEl.textContent = noteText || translations[currentLang]["no-notes"];
                displayEl.style.display = 'block';
            }
            if (editIcon) editIcon.style.display = 'block';
            if (wrapperEl) wrapperEl.style.display = 'none';

            let meta = fullMetaMap.get(accountId) || { note: "", links: [] };
            if (meta.note === noteText) return;

            meta.note = noteText;
            fullMetaMap.set(accountId, meta);

            try {
                const res = await fetch('/api/account-meta', {
                    method: 'POST',
                    headers: getAuthHeader(),
                    body: JSON.stringify({
                        account_id: accountId,
                        note: meta.note,
                        links: meta.links
                    })
                });
                if (!res.ok) {
                    const error = await res.text();
                    alert("Failed to save note: " + error);
                    location.reload();
                }
            } catch (e) {
                alert("Failed to save note due to connection issue.");
            }
        }

        // Links Management & Dynamic Rendering
        function renderAccountLinks(accountId) {
            const cardEl = document.querySelector('.card[data-account-id="' + accountId + '"]');
            if (!cardEl) return;
            const linksRow = cardEl.querySelector('.links-row');
            if (!linksRow) return;

            let meta = fullMetaMap.get(accountId) || { note: "", links: [] };
            let linksHtml = "";
            (meta.links || []).forEach(function(link, idx) {
                linksHtml += \`
                    <div class="link-slot" data-index="\${idx}">
                        <a href="\${link.url}" target="_blank" rel="noopener" class="link-anchor">
                            <i class="ti ti-\${link.icon || 'link'}"></i>
                            <span>\${link.title}</span>
                        </a>
                        <button class="delete-link-btn" onclick="deleteLink('\${accountId}', \${idx})" title="Delete Link">
                            <i class="ti ti-x"></i>
                        </button>
                    </div>
                \`;
            });

            if ((meta.links || []).length < 5) {
                linksHtml += \`
                    <button class="add-link-btn" onclick="openAddLinkModal('\${accountId}')" title="Add Link Slot">
                        <i class="ti ti-plus"></i>
                        <span>Add Link</span>
                    </button>
                \`;
            }

            linksRow.innerHTML = linksHtml;
        }

        function openAddLinkModal(accountId) {
            if (!requireUnlock()) return;
            document.getElementById('add-link-account-id').value = accountId;
            document.getElementById('link-title-input').value = '';
            document.getElementById('link-url-input').value = '';
            document.getElementById('link-icon-input').value = 'link';
            openModal('add-link-modal');
        }

        async function submitAddLink() {
            const accountId = document.getElementById('add-link-account-id').value;
            const title = document.getElementById('link-title-input').value.trim();
            const url = document.getElementById('link-url-input').value.trim();
            const icon = document.getElementById('link-icon-input').value.trim() || 'link';

            if (!title || !url) {
                alert(translations[currentLang]["alert-req-fields"]);
                return;
            }

            let meta = fullMetaMap.get(accountId) || { note: "", links: [] };
            if (!meta.links) meta.links = [];
            if (meta.links.length >= 5) {
                alert(translations[currentLang]["alert-max-links"]);
                return;
            }

            meta.links.push({ title, url, icon });
            fullMetaMap.set(accountId, meta);
            renderAccountLinks(accountId);
            closeModal('add-link-modal');

            try {
                const res = await fetch('/api/account-meta', {
                    method: 'POST',
                    headers: getAuthHeader(),
                    body: JSON.stringify({
                        account_id: accountId,
                        note: meta.note,
                        links: meta.links
                    })
                });
                if (!res.ok) {
                    const err = await res.text();
                    alert("Failed to save link: " + err);
                    location.reload();
                }
            } catch (e) {
                alert("Connection error.");
            }
        }

        async function deleteLink(accountId, index) {
            if (!requireUnlock()) return;
            if (!confirm(translations[currentLang]["confirm-delete-link"])) return;

            let meta = fullMetaMap.get(accountId);
            if (!meta || !meta.links) return;

            meta.links.splice(index, 1);
            fullMetaMap.set(accountId, meta);
            renderAccountLinks(accountId);

            try {
                const res = await fetch('/api/account-meta', {
                    method: 'POST',
                    headers: getAuthHeader(),
                    body: JSON.stringify({
                        account_id: accountId,
                        note: meta.note,
                        links: meta.links
                    })
                });
                if (!res.ok) {
                    const err = await res.text();
                    alert("Failed to delete link: " + err);
                    location.reload();
                }
            } catch (e) {
                alert("Connection error.");
            }
        }

        // Manage Accounts Modal UI list builder
        function openManageAccountsModal() {
            if (!requireUnlock()) return;
            renderManageAccountsList();
            openModal('manage-accounts-modal');
        }

        function renderManageAccountsList() {
            const listEl = document.getElementById('manage-accounts-list');
            listEl.innerHTML = '';

            if (accountsData.length === 0) {
                listEl.innerHTML = '<div style="font-size: 0.85rem; color: var(--text-secondary); text-align: center; padding: 1rem;">No accounts loaded.</div>';
                return;
            }

            accountsData.forEach((acc, idx) => {
                const item = document.createElement('div');
                item.className = 'manage-account-item';
                item.innerHTML = \`
                    <div class="manage-account-info">
                        <div class="manage-account-name">\${acc.name}</div>
                        <div class="manage-account-id">\${acc.account_id}</div>
                    </div>
                    <div class="manage-account-actions">
                        <button class="icon-btn" onclick="editAccountItem(\${idx})" title="Edit Account">
                            <i class="ti ti-edit"></i>
                        </button>
                        <button class="icon-btn icon-btn-danger" onclick="deleteAccountItem(\${idx})" title="Delete Account">
                            <i class="ti ti-trash"></i>
                        </button>
                    </div>
                \`;
                listEl.appendChild(item);
            });
        }

        function editAccountItem(index) {
            const acc = accountsData[index];
            document.getElementById('edit-account-index').value = index;
            document.getElementById('account-name-input').value = acc.name;
            document.getElementById('account-id-input').value = acc.account_id;
            document.getElementById('account-token-input').value = ''; // Don't pre-populate token for security, leave blank to keep unchanged
            document.getElementById('account-token-input').placeholder = "•••••••• (Leave blank to keep unchanged)";
            document.getElementById('add-edit-account-title').textContent = (currentLang === 'fa' ? "ویرایش اکانت: " : "Edit Account: ") + acc.name;
            document.getElementById('cancel-account-edit-btn').style.display = 'inline-flex';
        }

        function resetAccountForm() {
            document.getElementById('edit-account-index').value = "-1";
            document.getElementById('account-name-input').value = '';
            document.getElementById('account-id-input').value = '';
            document.getElementById('account-token-input').value = '';
            document.getElementById('account-token-input').placeholder = "Cloudflare API Token";
            document.getElementById('add-edit-account-title').textContent = translations[currentLang]["add-new-account-title"];
            document.getElementById('cancel-account-edit-btn').style.display = 'none';
        }

        async function saveAccountItem() {
            const index = parseInt(document.getElementById('edit-account-index').value);
            const name = document.getElementById('account-name-input').value.trim();
            const account_id = document.getElementById('account-id-input').value.trim();
            const api_token = document.getElementById('account-token-input').value.trim();

            if (!name || !account_id) {
                alert(translations[currentLang]["alert-acc-req"]);
                return;
            }

            if (index === -1 && !api_token) {
                alert(translations[currentLang]["alert-token-req"]);
                return;
            }

            const updatedAccounts = JSON.parse(JSON.stringify(accountsData));

            if (index >= 0) {
                const existing = updatedAccounts[index];
                existing.name = name;
                existing.account_id = account_id;
                if (api_token) {
                    existing.api_token = api_token;
                } else {
                    existing.keep_existing_token = true;
                }
            } else {
                updatedAccounts.push({ name, account_id, api_token });
            }

            try {
                const res = await fetch('/api/accounts', {
                    method: 'POST',
                    headers: getAuthHeader(),
                    body: JSON.stringify(updatedAccounts)
                });
                if (res.ok) {
                    location.reload();
                } else {
                    const err = await res.text();
                    alert("Failed to save accounts: " + err);
                }
            } catch (e) {
                alert("Connection error.");
            }
        }

        async function deleteAccountItem(index) {
            if (!confirm(translations[currentLang]["confirm-delete-acc"])) return;

            const updatedAccounts = JSON.parse(JSON.stringify(accountsData));
            updatedAccounts.splice(index, 1);

            try {
                const res = await fetch('/api/accounts', {
                    method: 'POST',
                    headers: getAuthHeader(),
                    body: JSON.stringify(updatedAccounts)
                });
                if (res.ok) {
                    location.reload();
                } else {
                    const err = await res.text();
                    alert("Failed to delete account: " + err);
                }
            } catch (e) {
                alert("Connection error.");
            }
        }
</script>
</body>
</html>`;
}

async function purgeEdgeCache(request) {
  try {
    const cache = typeof caches !== "undefined" ? caches.default : null;
    if (cache) {
      const cacheUrl = new URL(request.url);
      cacheUrl.pathname = "/__cached_dashboard";
      const cacheKey = new Request(cacheUrl.toString(), { method: "GET" });
      await cache.delete(cacheKey);
    }
  } catch (e) {
    console.error("Error purging edge cache:", e);
  }
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // Only serve root endpoint or favicon or APIs
    if (url.pathname === "/favicon.ico") {
      return new Response(null, { status: 204 });
    }

    // --- API Endpoints ---
    if (url.pathname === "/api/setup-password") {
      if (request.method !== "POST") {
        return new Response("Method Not Allowed", { status: 405 });
      }
      try {
        const existingPassword = await getAdminPassword(env);
        if (existingPassword) {
          return new Response(JSON.stringify({ success: false, error: "Password has already been set up." }), {
            status: 403,
            headers: { "Content-Type": "application/json" }
          });
        }

        const body = await request.json();
        const newPassword = body.password ? body.password.trim() : "";
        if (!newPassword) {
          return new Response(JSON.stringify({ success: false, error: "Password cannot be empty." }), {
            status: 400,
            headers: { "Content-Type": "application/json" }
          });
        }

        if (!env.CF_USAGE_KV) {
          return new Response(JSON.stringify({ success: false, error: "KV namespace (CF_USAGE_KV) is not bound." }), {
            status: 500,
            headers: { "Content-Type": "application/json" }
          });
        }

        await env.CF_USAGE_KV.put("ADMIN_PASSWORD", newPassword);

        // Clear caches
        MEMORY_CACHE.clear();
        await purgeEdgeCache(request);

        return new Response(JSON.stringify({ success: true }), {
          headers: { "Content-Type": "application/json" }
        });
      } catch (e) {
        return new Response(JSON.stringify({ success: false, error: "Error setting password: " + e.message }), {
          status: 500,
          headers: { "Content-Type": "application/json" }
        });
      }
    }

    if (url.pathname === "/api/verify-password") {
      if (request.method !== "POST") {
        return new Response("Method Not Allowed", { status: 405 });
      }
      try {
        const body = await request.json();
        const serverPassword = await getAdminPassword(env);
        if (!serverPassword) {
          return new Response(JSON.stringify({ success: false, error: "Admin password is not set up yet." }), {
            status: 400,
            headers: { "Content-Type": "application/json" }
          });
        }
        if (body.password === serverPassword) {
          return new Response(JSON.stringify({ success: true }), {
            headers: { "Content-Type": "application/json" }
          });
        } else {
          return new Response(JSON.stringify({ success: false, error: "Incorrect password." }), {
            headers: { "Content-Type": "application/json" }
          });
        }
      } catch (e) {
        return new Response(JSON.stringify({ success: false, error: "Invalid Request: " + e.message }), {
          status: 400,
          headers: { "Content-Type": "application/json" }
        });
      }
    }

    if (url.pathname === "/api/accounts") {
      if (request.method !== "POST") {
        return new Response("Method Not Allowed", { status: 405 });
      }
      if (!await verifyPassword(request, env)) {
        return new Response("Unauthorized or admin password not configured.", { status: 401 });
      }

      try {
        const inputAccounts = await request.json();
        if (!Array.isArray(inputAccounts)) {
          return new Response("Accounts must be an array.", { status: 400 });
        }

        if (!env.CF_USAGE_KV) {
          return new Response("KV namespace (CF_USAGE_KV) is not bound.", { status: 500 });
        }

        // Merge old tokens for security so they are not wiped when editing display names or IDs
        const existingAccounts = await getAccounts(env);
        const existingMap = new Map(existingAccounts.map(a => [a.account_id, a.api_token]));

        const sanitizedAccounts = inputAccounts.map(acc => {
          let token = acc.api_token;
          if (acc.keep_existing_token || !token || token === "••••••••••••") {
            token = existingMap.get(acc.account_id) || "";
          }
          return {
            account_id: acc.account_id,
            api_token: token,
            name: acc.name
          };
        });

        await env.CF_USAGE_KV.put("ACCOUNTS_CONFIG", JSON.stringify(sanitizedAccounts));

        // Clear caches
        MEMORY_CACHE.clear();
        await purgeEdgeCache(request);

        return new Response(JSON.stringify({ success: true }), {
          headers: { "Content-Type": "application/json" }
        });
      } catch (e) {
        return new Response("Error updating accounts: " + e.message, { status: 500 });
      }
    }

    if (url.pathname === "/api/account-meta") {
      if (request.method !== "POST") {
        return new Response("Method Not Allowed", { status: 405 });
      }
      if (!await verifyPassword(request, env)) {
        return new Response("Unauthorized or admin password not configured.", { status: 401 });
      }

      try {
        const body = await request.json();
        const { account_id, note, links } = body;
        if (!account_id) {
          return new Response("account_id is required.", { status: 400 });
        }

        if (!env.CF_USAGE_KV) {
          return new Response("KV namespace (CF_USAGE_KV) is not bound.", { status: 500 });
        }

        // Limit link count to maximum 5
        const trimmedLinks = (links || []).slice(0, 5);

        await env.CF_USAGE_KV.put("META_" + account_id, JSON.stringify({
          note: note || "",
          links: trimmedLinks
        }));

        // Clear cache for this specific account and purge Edge Cache
        const cached = MEMORY_CACHE.get(account_id);
        if (cached) {
          MEMORY_CACHE.delete(account_id);
        }
        await purgeEdgeCache(request);

        return new Response(JSON.stringify({ success: true }), {
          headers: { "Content-Type": "application/json" }
        });
      } catch (e) {
        return new Response("Error saving account metadata: " + e.message, { status: 500 });
      }
    }

    if (url.pathname === "/api/config") {
      // Return both accounts and all metadata if password matches
      if (!await verifyPassword(request, env)) {
        return new Response("Unauthorized or admin password not configured.", { status: 401 });
      }

      try {
        const accounts = await getAccounts(env);
        const configData = {
          accounts: accounts.map(a => ({ account_id: a.account_id, api_token: a.api_token, name: a.name })),
          metadata: {}
        };

        for (const acc of accounts) {
          configData.metadata[acc.account_id] = await getAccountMeta(acc.account_id, env);
        }

        return new Response(JSON.stringify(configData, null, 2), {
          headers: { "Content-Type": "application/json" }
        });
      } catch (e) {
        return new Response("Error fetching configuration: " + e.message, { status: 500 });
      }
    }

    // --- HTML RENDER PIPELINE ---
    const accounts = await getAccounts(env);

    // Check Cloudflare Edge Cache API first if not in MOCK mode, not on local dev, and request is a GET
    const isLocalDev = url.hostname === "localhost" || url.hostname === "127.0.0.1";
    const cache = (typeof caches !== "undefined" && !isLocalDev) ? caches.default : null;
    const cacheUrl = new URL(request.url);
    cacheUrl.pathname = "/__cached_dashboard";
    const cacheKey = new Request(cacheUrl.toString(), { method: "GET" });

    if (cache && env.MOCK_CF !== "true" && request.method === "GET" && !request.headers.get("Authorization")) {
      const cachedResponse = await cache.match(cacheKey);
      if (cachedResponse) {
        return cachedResponse;
      }
    }

    // Check in-memory isolate cache
    const now = Date.now();
    const accountsToFetch = [];
    const resultsMap = {};

    for (const acc of accounts) {
      const cached = MEMORY_CACHE.get(acc.account_id);
      if (cached && cached.expiresAt > now && env.MOCK_CF !== "true") {
        resultsMap[acc.account_id] = cached.data;
      } else {
        accountsToFetch.push(acc);
      }
    }

    if (accountsToFetch.length > 0) {
      const fetchedResults = await Promise.all(
        accountsToFetch.map(acc => fetchFullAccountData(acc, env))
      );

      for (let i = 0; i < accountsToFetch.length; i++) {
        const acc = accountsToFetch[i];
        const res = fetchedResults[i];
        MEMORY_CACHE.set(acc.account_id, {
          data: res,
          expiresAt: now + CACHE_TTL_SECONDS * 1000
        });
        resultsMap[acc.account_id] = res;
      }
    }

    // Load metadata for each account and attach to results
    const results = [];
    for (const acc of accounts) {
      const res = resultsMap[acc.account_id];
      if (res) {
        const meta = await getAccountMeta(acc.account_id, env);
        results.push({
          ...res,
          meta,
          api_token: acc.api_token
        });
      }
    }

    const hasPasswordConfigured = !!(await getAdminPassword(env));
    const html = renderDashboard(results, env, hasPasswordConfigured);

    // Bypass Edge cache if authorized request (always serve fresh for unlocked clients)
    const responseHeaders = {
      "Content-Type": "text/html; charset=utf-8"
    };

    if (isLocalDev || request.headers.get("Authorization")) {
      responseHeaders["Cache-Control"] = "no-cache, no-store, must-revalidate";
    } else {
      responseHeaders["Cache-Control"] = `public, max-age=0, s-maxage=${CACHE_TTL_SECONDS}, must-revalidate`;
    }

    const response = new Response(html, {
      headers: responseHeaders
    });

    // Save to Cloudflare Edge Cache asynchronously if not mocking, not authorized, and request was a GET
    if (cache && env.MOCK_CF !== "true" && request.method === "GET" && !request.headers.get("Authorization") && results.length > 0) {
      ctx.waitUntil(cache.put(cacheKey, response.clone()));
    }

    return response;
  }
};
