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

function parseAccounts(env) {
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

function renderDashboard(results) {
  if (!results || results.length === 0) {
    return `
      <!DOCTYPE html>
      <html lang="en">
      <head><meta charset="UTF-8"><title>Cloudflare Workers Usage</title></head>
      <body style="font-family: system-ui, sans-serif; background: #0f0f10; color: #f3f3f3; padding: 2rem;">
        <h2>No Cloudflare accounts configured in Environment Variables.</h2>
      </body>
      </html>
    `;
  }

  let cardsHtml = "";
  for (const res of results) {
    const displayHeader = res.email ? `${res.name} (${res.email})` : res.name;
    const errBadge = res.error
      ? `<div style="color: #ef4444; font-size: 0.85rem; margin-top: 0.5rem;">⚠️ ${res.error}</div>`
      : "";
    const barColor = res.pct > 90 ? "#ef4444" : res.pct > 75 ? "#f97316" : "#3b82f6";
    const formattedRequests = Number(res.requests).toLocaleString();
    const formattedLimit = Number(res.limit).toLocaleString();

    cardsHtml += `
      <div class="card">
        <div class="card-header">
          <span>${displayHeader}</span>
          <span>${formattedRequests} / ${formattedLimit}</span>
        </div>
        <div class="bar-bg">
          <div class="bar-fill" style="width: ${res.pct}%; background: ${barColor};"></div>
        </div>
        ${errBadge}
      </div>
    `;
  }

  return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Cloudflare Workers Usage</title>
    <style>
        body { font-family: system-ui, -apple-system, sans-serif; background: #0f0f10; color: #f3f3f3; margin: 0; padding: 2rem; }
        .container { max-width: 800px; margin: 0 auto; }
        h1 { font-size: 1.8rem; margin-bottom: 1.5rem; }
        .card { background: #18181b; border: 1px solid #27272a; border-radius: 8px; padding: 1.25rem; margin-bottom: 1rem; }
        .card-header { display: flex; justify-content: space-between; font-weight: 600; margin-bottom: 0.75rem; flex-wrap: wrap; gap: 0.5rem; }
        .bar-bg { background: #27272a; height: 10px; border-radius: 5px; overflow: hidden; }
        .bar-fill { height: 100%; transition: width 0.3s ease; }
    </style>
</head>
<body>
    <div class="container">
        <h1>Cloudflare Workers Usage (Today)</h1>
        ${cardsHtml}
    </div>
</body>
</html>`;
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // Only serve root endpoint or favicon
    if (url.pathname === "/favicon.ico") {
      return new Response(null, { status: 204 });
    }

    const accounts = parseAccounts(env);

    // 1. Check Cloudflare Edge Cache API first if not in MOCK mode
    const cache = typeof caches !== "undefined" ? caches.default : null;
    const cacheUrl = new URL(request.url);
    cacheUrl.pathname = "/__cached_dashboard";
    const cacheKey = new Request(cacheUrl.toString(), request);

    if (cache && env.MOCK_CF !== "true") {
      const cachedResponse = await cache.match(cacheKey);
      if (cachedResponse) {
        return cachedResponse;
      }
    }

    // 2. Check in-memory isolate cache
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

    const results = accounts.map(acc => resultsMap[acc.account_id]).filter(Boolean);
    const html = renderDashboard(results);

    const response = new Response(html, {
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": `public, max-age=${CACHE_TTL_SECONDS}, s-maxage=${CACHE_TTL_SECONDS}`
      }
    });

    // Save to Cloudflare Edge Cache asynchronously if not mocking
    if (cache && env.MOCK_CF !== "true") {
      ctx.waitUntil(cache.put(cacheKey, response.clone()));
    }

    return response;
  }
};
