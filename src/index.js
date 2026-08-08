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

function verifyPassword(request, env) {
  const adminPassword = env.DASHBOARD_PASSWORD;
  if (!adminPassword) {
    return false; // Deny edits completely if DASHBOARD_PASSWORD is not set
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

    const formattedRequests = Number(res.requests).toLocaleString();
    const formattedLimit = Number(res.limit).toLocaleString();

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
            <span class="usage-count">${formattedRequests} / ${formattedLimit}</span>
            <span class="pct-badge ${badgeClass}">${res.pct}%</span>
          </div>
        </div>
        <div class="bar-bg">
          <div class="bar-fill" style="width: ${res.pct}%; background: ${barGradient};"></div>
        </div>
        ${errBadge}

        <!-- Note & Links Section -->
        <div class="card-meta-section">
          <div class="note-container">
            <i class="ti ti-notes note-icon"></i>
            <div class="note-content" onclick="enableNoteEdit('${res.account_id}')" id="note-display-${res.account_id}">${noteText}</div>
            <textarea class="note-input" id="note-input-${res.account_id}" onblur="saveNote('${res.account_id}')" style="display: none;">${meta.note || ""}</textarea>
            <i class="ti ti-edit note-edit-icon" onclick="enableNoteEdit('${res.account_id}')"></i>
          </div>
          <div class="links-row">
            ${linksHtml}
          </div>
        </div>
      </div>
    `;
  }

  const overallPct = totalLimit > 0 ? ((totalRequests / totalLimit) * 100).toFixed(1) : "0.0";
  const formattedTotalReqs = totalRequests.toLocaleString();
  const formattedTotalLimit = totalLimit.toLocaleString();

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
    <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
    <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/@tabler/icons-webfont@latest/dist/tabler-icons.min.css" />
    <style>
        :root {
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
        }

        * { box-sizing: border-box; margin: 0; padding: 0; }

        body {
            font-family: 'Inter', system-ui, -apple-system, sans-serif;
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
            background: linear-gradient(180deg, #ffffff 0%, #cbd5e1 100%);
            -webkit-background-clip: text;
            -webkit-text-fill-color: transparent;
        }

        .header-actions {
            display: flex;
            align-items: center;
            gap: 0.75rem;
        }

        .btn {
            background: rgba(255, 255, 255, 0.05);
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
            background: rgba(255, 255, 255, 0.1);
            border-color: rgba(255, 255, 255, 0.2);
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
            color: #f3f4f6;
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
            background: rgba(255, 255, 255, 0.05);
            padding: 0.25rem 0.6rem;
            border-radius: 6px;
            font-family: monospace;
            font-weight: 600;
            color: #38bdf8;
            border: 1px solid rgba(56, 189, 248, 0.2);
        }

        /* Animated Progress Bars */
        .bar-bg {
            background: rgba(30, 41, 59, 0.6);
            height: 12px;
            border-radius: 9999px;
            overflow: hidden;
            position: relative;
            box-shadow: inset 0 2px 4px rgba(0, 0, 0, 0.4);
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
            color: #ffffff;
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
            border-color: rgba(255, 255, 255, 0.18);
            box-shadow: 0 12px 20px -5px rgba(0, 0, 0, 0.4);
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
            color: #f9fafb;
            word-break: break-word;
        }

        .usage-stats {
            display: flex;
            align-items: center;
            gap: 0.75rem;
        }

        .usage-count {
            font-size: 0.9rem;
            font-weight: 600;
            color: var(--text-secondary);
            font-family: monospace;
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
            background: rgba(255, 255, 255, 0.02);
            padding: 0.6rem 0.8rem;
            border-radius: 8px;
            border: 1px solid rgba(255, 255, 255, 0.04);
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

        .note-input {
            width: 100%;
            background: rgba(0, 0, 0, 0.3);
            border: 1px solid var(--cf-orange);
            border-radius: 6px;
            color: var(--text-primary);
            font-family: inherit;
            font-size: 0.88rem;
            padding: 0.4rem;
            resize: vertical;
            min-height: 3rem;
        }

        .note-input:focus {
            outline: none;
            box-shadow: 0 0 8px rgba(243, 128, 32, 0.25);
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
            background: rgba(255, 255, 255, 0.1);
            border-radius: 2px;
        }

        .link-slot {
            display: flex;
            align-items: center;
            background: rgba(255, 255, 255, 0.03);
            border: 1px solid var(--border-color);
            border-radius: 8px;
            padding: 0.4rem 0.75rem;
            gap: 0.5rem;
            flex-shrink: 0;
            position: relative;
            transition: all 0.2s ease;
        }

        .link-slot:hover {
            border-color: rgba(255, 255, 255, 0.15);
            background: rgba(255, 255, 255, 0.06);
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
            color: #ffffff;
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
            background: rgba(255, 255, 255, 0.03);
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
            background: rgba(255, 255, 255, 0.02);
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
            color: #ffffff;
            white-space: nowrap;
            overflow: hidden;
            text-overflow: ellipsis;
        }

        .manage-account-id {
            font-size: 0.75rem;
            color: var(--text-muted);
            font-family: monospace;
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
            background: rgba(255, 255, 255, 0.04);
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
            background: rgba(255, 255, 255, 0.1);
            color: #ffffff;
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
            background: rgba(255, 255, 255, 0.03);
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
                    <h1>Cloudflare Workers Usage</h1>
                    <span style="font-size: 0.8rem; color: var(--text-secondary);">Daily Invocation Tracker</span>
                </div>
            </div>
            <div class="header-actions">
                <button class="btn" id="lock-btn" onclick="openPasswordModal()">
                    <i class="ti ti-lock"></i>
                    <span id="lock-text">Unlock Settings</span>
                </button>
                <button class="btn btn-primary" onclick="openManageAccountsModal()">
                    <i class="ti ti-settings"></i>
                    <span>Manage Accounts</span>
                </button>
                <div class="status-badge">
                    <span class="pulse-dot"></span>
                    <span>Live Edge Data</span>
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
                    <span>Cloudflare Quota Day Progress (UTC Reset)</span>
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
                <div class="metric-label">Monitored Accounts</div>
                <div class="metric-value">${results.length}</div>
            </div>
            <div class="metric-card">
                <div class="metric-label">Total Requests Today</div>
                <div class="metric-value">${formattedTotalReqs}</div>
            </div>
            <div class="metric-card">
                <div class="metric-label">Total Free Quota</div>
                <div class="metric-value">${formattedTotalLimit}</div>
            </div>
            <div class="metric-card">
                <div class="metric-label">Overall Usage</div>
                <div class="metric-value" style="color: ${overallPct > 75 ? '#f97316' : '#38bdf8'}">${overallPct}%</div>
            </div>
        </div>

        <div class="section-title">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <rect x="3" y="3" width="7" height="7" rx="1" />
                <rect x="14" y="3" width="7" height="7" rx="1" />
                <rect x="14" y="14" width="7" height="7" rx="1" />
                <rect x="3" y="14" width="7" height="7" rx="1" />
            </svg>
            <span>Account Usage Breakdown</span>
        </div>

        ${emptyStateHtml}

        <div class="account-list">
            ${cardsHtml}
        </div>
    </div>

    <!-- Password Modal -->
    <div class="modal" id="password-modal">
        <div class="modal-content" style="max-width: 400px;">
            <div class="modal-header">
                <div class="modal-title">
                    <i class="ti ti-lock"></i>
                    <span>Enter Admin Password</span>
                </div>
                <button class="close-modal-btn" onclick="closeModal('password-modal')">×</button>
            </div>
            <div class="modal-body">
                <p style="font-size: 0.85rem; color: var(--text-secondary); margin-bottom: 1rem;">
                    Editing requires the administrator password configured in your environment as <code>DASHBOARD_PASSWORD</code>.
                </p>
                <div class="form-group">
                    <label class="form-label" for="admin-password-input">Password</label>
                    <input type="password" class="form-control" id="admin-password-input" placeholder="••••••••" onkeydown="if(event.key === 'Enter') submitPassword()" />
                </div>
                <div style="color: #f87171; font-size: 0.8rem; margin-top: 0.5rem; display: none;" id="password-error">
                    Invalid password or edits are disabled.
                </div>
            </div>
            <div class="modal-footer">
                <button class="btn" onclick="closeModal('password-modal')">Cancel</button>
                <button class="btn btn-primary" onclick="submitPassword()">Unlock</button>
            </div>
        </div>
    </div>

    <!-- Add Link Modal -->
    <div class="modal" id="add-link-modal">
        <div class="modal-content" style="max-width: 420px;">
            <div class="modal-header">
                <div class="modal-title">
                    <i class="ti ti-plus"></i>
                    <span>Add Custom Link</span>
                </div>
                <button class="close-modal-btn" onclick="closeModal('add-link-modal')">×</button>
            </div>
            <div class="modal-body">
                <input type="hidden" id="add-link-account-id" />
                <div class="form-group">
                    <label class="form-label" for="link-title-input">Link Title</label>
                    <input type="text" class="form-control" id="link-title-input" placeholder="e.g. Workers Logs" />
                </div>
                <div class="form-group">
                    <label class="form-label" for="link-url-input">URL</label>
                    <input type="url" class="form-control" id="link-url-input" placeholder="https://..." />
                </div>
                <div class="form-group">
                    <label class="form-label" for="link-icon-input">Tabler Icon Name</label>
                    <input type="text" class="form-control" id="link-icon-input" placeholder="e.g. server, link, cloud, brand-github" />
                    <span style="font-size: 0.75rem; color: var(--text-muted); margin-top: 0.25rem; display: block;">
                        Supported icons list: <a href="https://tabler.io/icons" target="_blank" rel="noopener" style="color: var(--cf-orange);">tabler.io/icons</a>
                    </span>
                </div>
            </div>
            <div class="modal-footer">
                <button class="btn" onclick="closeModal('add-link-modal')">Cancel</button>
                <button class="btn btn-primary" onclick="submitAddLink()">Add Link</button>
            </div>
        </div>
    </div>

    <!-- Manage Accounts Modal -->
    <div class="modal" id="manage-accounts-modal">
        <div class="modal-content">
            <div class="modal-header">
                <div class="modal-title">
                    <i class="ti ti-settings"></i>
                    <span>Manage Cloudflare Accounts</span>
                </div>
                <button class="close-modal-btn" onclick="closeModal('manage-accounts-modal')">×</button>
            </div>
            <div class="modal-body">
                <div class="section-subtitle">Active Accounts</div>
                <div class="accounts-list-container" id="manage-accounts-list">
                    <!-- Dynamic -->
                </div>

                <div class="divider"></div>

                <div class="section-subtitle" id="add-edit-account-title">Add New Account</div>
                <input type="hidden" id="edit-account-index" value="-1" />
                <div class="form-group">
                    <label class="form-label" for="account-name-input">Display Name</label>
                    <input type="text" class="form-control" id="account-name-input" placeholder="Production Main" />
                </div>
                <div class="form-group">
                    <label class="form-label" for="account-id-input">Cloudflare Account ID</label>
                    <input type="text" class="form-control" id="account-id-input" placeholder="bc5e10cea180fa82..." />
                </div>
                <div class="form-group">
                    <label class="form-label" for="account-token-input">Cloudflare API Token</label>
                    <input type="password" class="form-control" id="account-token-input" placeholder="••••••••••••••••••••••••••••••••" />
                </div>
                <div style="display: flex; gap: 0.5rem; justify-content: flex-end;">
                    <button class="btn" id="cancel-account-edit-btn" onclick="resetAccountForm()" style="display: none;">Cancel Edit</button>
                    <button class="btn btn-primary" onclick="saveAccountItem()">Save Account</button>
                </div>
            </div>
            <div class="modal-footer">
                <button class="btn" onclick="closeModal('manage-accounts-modal')">Close</button>
            </div>
        </div>
    </div>

    <!-- Footer with Developer & Copyright Placeholders -->
    <footer>
        <div class="footer-container">
            <div class="footer-copyright">
                © <span id="year">2026</span> Cloudflare Workers Usage Dashboard. All rights reserved.
            </div>
            <div class="footer-credits">
                <span>Developed with</span>
                <span class="heart">❤️</span>
                <span>by</span>
                <a href="htttps://ajbv.ir" class="dev-link" target="_blank" rel="noopener">Mehdi Chamani</a>
            </div>
            <div class="footer-badge">
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

        // Initialize state from local storage or defaults
        let cachedPassword = localStorage.getItem('dashboard_password') || '';

        // Check password status on load
        updatePasswordUI();

        function getAuthHeader() {
            return {
                "Authorization": "Bearer " + cachedPassword,
                "Content-Type": "application/json"
            };
        }

        function updatePasswordUI() {
            const lockBtn = document.getElementById('lock-btn');
            const lockText = document.getElementById('lock-text');
            if (cachedPassword) {
                lockBtn.style.background = 'rgba(16, 185, 129, 0.15)';
                lockBtn.style.borderColor = 'rgba(16, 185, 129, 0.3)';
                lockBtn.style.color = '#34d399';
                lockText.textContent = 'Unlocked';
                lockBtn.querySelector('i').className = 'ti ti-lock-open';
            } else {
                lockBtn.style.background = 'rgba(255, 255, 255, 0.05)';
                lockBtn.style.borderColor = 'var(--border-color)';
                lockBtn.style.color = 'var(--text-primary)';
                lockText.textContent = 'Unlock Settings';
                lockBtn.querySelector('i').className = 'ti ti-lock';
            }
        }

        function requireUnlock() {
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

            if (clockEl) clockEl.textContent = hPad + ':' + mPad + ':' + sPad + ' UTC';
            if (elapsedEl) elapsedEl.textContent = '⏱️ ' + h + 'h ' + m + 'm elapsed';
            if (remainingEl) remainingEl.textContent = '⏳ ' + remH + 'h ' + remM + 'm until 00:00 UTC reset';
            if (barEl) barEl.style.width = pct + '%';
            if (pctBadgeEl) pctBadgeEl.textContent = pct + '%';
        }

        setInterval(updateUtcResetBar, 1000);
        updateUtcResetBar();

        // Modals management
        function openModal(id) {
            document.getElementById(id).style.display = 'flex';
        }

        function closeModal(id) {
            document.getElementById(id).style.display = 'none';
        }

        function openPasswordModal() {
            document.getElementById('admin-password-input').value = cachedPassword;
            document.getElementById('password-error').style.display = 'none';
            openModal('password-modal');
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
                    // Refresh view to fetch uncached data or simply visual verification
                    location.reload();
                } else {
                    errorEl.textContent = result.error || "Incorrect password.";
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
            const inputEl = document.getElementById('note-input-' + accountId);
            displayEl.style.display = 'none';
            inputEl.style.display = 'block';
            inputEl.focus();
        }

        async function saveNote(accountId) {
            const displayEl = document.getElementById('note-display-' + accountId);
            const inputEl = document.getElementById('note-input-' + accountId);
            const noteText = inputEl.value;

            displayEl.textContent = noteText || "No notes added yet.";
            displayEl.style.display = 'block';
            inputEl.style.display = 'none';

            let meta = fullMetaMap.get(accountId) || { note: "", links: [] };
            if (meta.note === noteText) return; // No change

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
                linksHtml += '<div class="link-slot" data-index="' + idx + '">' +
                    '<a href="' + link.url + '" target="_blank" rel="noopener" class="link-anchor">' +
                    '<i class="ti ti-' + (link.icon || 'link') + '"></i>' +
                    '<span>' + link.title + '</span>' +
                    '</a>' +
                    '<button class="delete-link-btn" onclick="deleteLink(\'' + accountId + '\', ' + idx + ')" title="Delete Link">' +
                    '<i class="ti ti-x"></i>' +
                    '</button>' +
                    '</div>';
            });

            if ((meta.links || []).length < 5) {
                linksHtml += '<button class="add-link-btn" onclick="openAddLinkModal(\'' + accountId + '\')" title="Add Link Slot">' +
                    '<i class="ti ti-plus"></i>' +
                    '<span>Add Link</span>' +
                    '</button>';
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
                alert("Title and URL are required.");
                return;
            }

            let meta = fullMetaMap.get(accountId) || { note: "", links: [] };
            if (!meta.links) meta.links = [];
            if (meta.links.length >= 5) {
                alert("Maximum of 5 links reached.");
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
            if (!confirm("Are you sure you want to delete this link?")) return;

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
            document.getElementById('add-edit-account-title').textContent = "Edit Account: " + acc.name;
            document.getElementById('cancel-account-edit-btn').style.display = 'inline-flex';
        }

        function resetAccountForm() {
            document.getElementById('edit-account-index').value = "-1";
            document.getElementById('account-name-input').value = '';
            document.getElementById('account-id-input').value = '';
            document.getElementById('account-token-input').value = '';
            document.getElementById('account-token-input').placeholder = "Cloudflare API Token";
            document.getElementById('add-edit-account-title').textContent = "Add New Account";
            document.getElementById('cancel-account-edit-btn').style.display = 'none';
        }

        async function saveAccountItem() {
            const index = parseInt(document.getElementById('edit-account-index').value);
            const name = document.getElementById('account-name-input').value.trim();
            const account_id = document.getElementById('account-id-input').value.trim();
            const api_token = document.getElementById('account-token-input').value.trim();

            if (!name || !account_id) {
                alert("Account Name and Account ID are required.");
                return;
            }

            if (index === -1 && !api_token) {
                alert("API Token is required for new accounts.");
                return;
            }

            const updatedAccounts = JSON.parse(JSON.stringify(accountsData));

            if (index >= 0) {
                // Update existing
                const existing = updatedAccounts[index];
                existing.name = name;
                existing.account_id = account_id;
                if (api_token) {
                    existing.api_token = api_token;
                } else {
                    // We must retain the existing API token on the server side.
                    // But wait, the client doesn't have the raw API token from the injected accountsData.
                    // To handle this properly, the API endpoint on the server should merge/keep the old api_token if not provided!
                    // Let's pass a placeholder or keep-token property, e.g., keep_existing_token: true.
                    existing.keep_existing_token = true;
                }
            } else {
                // Add new
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
            if (!confirm("Are you sure you want to delete this account? This will also remove metadata from KV.")) return;

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
    if (url.pathname === "/api/verify-password") {
      if (request.method !== "POST") {
        return new Response("Method Not Allowed", { status: 405 });
      }
      try {
        const body = await request.json();
        const serverPassword = env.DASHBOARD_PASSWORD;
        if (!serverPassword) {
          return new Response(JSON.stringify({ success: false, error: "Admin password is not configured on the server. Edits are disabled." }), {
            status: 403,
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
      if (!verifyPassword(request, env)) {
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
          if (acc.keep_existing_token || !token) {
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
      if (!verifyPassword(request, env)) {
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
      if (!verifyPassword(request, env)) {
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

    // Check Cloudflare Edge Cache API first if not in MOCK mode and request is a GET
    const cache = typeof caches !== "undefined" ? caches.default : null;
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

    const hasPasswordConfigured = !!env.DASHBOARD_PASSWORD;
    const html = renderDashboard(results, env, hasPasswordConfigured);

    // Bypass Edge cache if authorized request (always serve fresh for unlocked clients)
    const responseHeaders = {
      "Content-Type": "text/html; charset=utf-8"
    };

    if (request.headers.get("Authorization")) {
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
