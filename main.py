import os
import asyncio
from datetime import datetime, timezone, timedelta
from fastapi import FastAPI, Request
from fastapi.responses import HTMLResponse
import httpx
from dotenv import load_dotenv

load_dotenv()

app = FastAPI()

# Parse up to 10 Cloudflare accounts from environment variables dynamically
ACCOUNTS = []
for i in range(1, 11):
    account_id = os.getenv(f"CF_ACCOUNT_ID_{i}") or os.getenv(f"CF_ACCOUNT_{i}_ID") or ""
    api_token = os.getenv(f"CF_API_TOKEN_{i}") or ""

    # Fallback to general environment variables for index 1 if not set
    if i == 1:
        if not account_id:
            account_id = os.getenv("CF_ACCOUNT_ID") or ""
        if not api_token:
            api_token = os.getenv("CF_API_TOKEN") or ""

    if account_id:
        name = os.getenv(f"CF_ACCOUNT_{i}_NAME") or f"Account {i}"
        ACCOUNTS.append({
            "name": name,
            "account_id": account_id,
            "api_token": api_token,
            "index": i,
        })

WORKERS_LIMIT = 100_000

# Fixed GraphQL Query using viewer -> accounts -> workersInvocationsAdaptive
GRAPHQL_QUERY = """
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
"""

# In-memory Cache Configuration
CACHE = {}
CACHE_TTL = timedelta(minutes=15)
CACHE_LOCK = asyncio.Lock()

async def fetch_account_info(client: httpx.AsyncClient, account_id: str, api_token: str) -> dict:
    """
    Fetches user email and account details from Cloudflare API.
    Returns a dict with 'email' (str or None) and 'cf_account_name' (str or None).
    """
    headers = {
        "Authorization": f"Bearer {api_token}",
        "Content-Type": "application/json",
    }
    email = None
    cf_account_name = None

    # Try fetching user details first
    try:
        user_res = await client.get("https://api.cloudflare.com/client/v4/user", headers=headers, timeout=5.0)
        if user_res.status_code == 200:
            user_data = user_res.json()
            if user_data.get("success"):
                email = user_data.get("result", {}).get("email")
    except Exception:
        pass

    # Try fetching account details next
    try:
        acc_res = await client.get(f"https://api.cloudflare.com/client/v4/accounts/{account_id}", headers=headers, timeout=5.0)
        if acc_res.status_code == 200:
            acc_data = acc_res.json()
            if acc_data.get("success"):
                cf_account_name = acc_data.get("result", {}).get("name")
    except Exception:
        pass

    return {
        "email": email,
        "cf_account_name": cf_account_name
    }

async def fetch_account_usage(client: httpx.AsyncClient, account: dict) -> dict:
    """
    Queries Cloudflare GraphQL API for today's workers usage.
    """
    today_utc = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    headers = {
        "Authorization": f"Bearer {account['api_token']}",
        "Content-Type": "application/json",
    }
    payload = {
        "query": GRAPHQL_QUERY,
        "variables": {
            "accountTag": account["account_id"],
            "date": today_utc
        }
    }
    
    try:
        response = await client.post("https://api.cloudflare.com/client/v4/graphql", json=payload, headers=headers, timeout=10.0)
        data = response.json()

        # Catch Cloudflare API GraphQL errors directly
        if "errors" in data and data["errors"]:
            err_msg = data["errors"][0].get("message", "GraphQL Error")
            return {"requests": 0, "limit": WORKERS_LIMIT, "pct": 0, "error": f"API Error: {err_msg}"}
        
        accounts_data = data.get("data", {}).get("viewer", {}).get("accounts", [])
        if not accounts_data:
            return {"requests": 0, "limit": WORKERS_LIMIT, "pct": 0, "error": "Account ID not found or Token lacks permissions"}
            
        invocations = accounts_data[0].get("workersInvocationsAdaptive", [])
        total_requests = sum(item.get("sum", {}).get("requests", 0) for item in invocations)
        
        pct = min(round((total_requests / WORKERS_LIMIT) * 100, 1), 100)
        
        return {
            "requests": total_requests,
            "limit": WORKERS_LIMIT,
            "pct": pct,
            "error": None
        }
    except Exception as e:
        return {
            "requests": 0,
            "limit": WORKERS_LIMIT,
            "pct": 0,
            "error": f"Connection Error: {str(e)}"
        }

async def fetch_full_account_data(client: httpx.AsyncClient, account: dict) -> dict:
    """
    Aggregates user info and workers usage metrics for a given account.
    """
    if os.getenv("MOCK_CF") == "true":
        return {
            "account_id": account["account_id"],
            "name": f"Mocked {account['name']}",
            "email": f"user{account['index']}@example.com",
            "requests": 42000 + account['index'] * 5000,
            "limit": WORKERS_LIMIT,
            "pct": 42.0 + account['index'] * 5.0,
            "error": None
        }

    # 1. Fetch info (user email & account name)
    info = await fetch_account_info(client, account["account_id"], account["api_token"])

    # 2. Fetch usage
    usage = await fetch_account_usage(client, account)

    # 3. Resolve display name (Priority fallback)
    name = info["cf_account_name"] or account["name"]
    email = info["email"]

    return {
        "account_id": account["account_id"],
        "name": name,
        "email": email,
        "requests": usage["requests"],
        "limit": usage["limit"],
        "pct": usage["pct"],
        "error": usage["error"]
    }

@app.get("/", response_class=HTMLResponse)
async def dashboard(request: Request):
    now = datetime.now(timezone.utc)
    results_map = {}

    # Use CACHE_LOCK to safely read/write cache in a concurrency-safe manner
    async with CACHE_LOCK:
        accounts_to_fetch = []
        for acc in ACCOUNTS:
            acc_id = acc["account_id"]
            if acc_id in CACHE and CACHE[acc_id]["expires_at"] > now:
                results_map[acc_id] = CACHE[acc_id]["data"]
            else:
                accounts_to_fetch.append(acc)

        if accounts_to_fetch:
            async with httpx.AsyncClient() as client:
                tasks = [fetch_full_account_data(client, acc) for acc in accounts_to_fetch]
                fetched_results = await asyncio.gather(*tasks)

                for acc, res in zip(accounts_to_fetch, fetched_results):
                    # Cache the result with a 15-minute expiration
                    CACHE[acc["account_id"]] = {
                        "data": res,
                        "expires_at": datetime.now(timezone.utc) + CACHE_TTL
                    }
                    results_map[acc["account_id"]] = res

    # Retrieve and preserve the parsed order of ACCOUNTS
    results = [results_map[acc["account_id"]] for acc in ACCOUNTS if acc["account_id"] in results_map]

    now_utc = datetime.now(timezone.utc)
    utc_hours = now_utc.hour
    utc_minutes = now_utc.minute
    utc_seconds = now_utc.second
    total_seconds_passed = utc_hours * 3600 + utc_minutes * 60 + utc_seconds
    day_progress_pct = round(min(100.0, max(0.0, (total_seconds_passed / 86400.0) * 100.0)), 1)
    remaining_seconds = 86400 - total_seconds_passed
    rem_h = remaining_seconds // 3600
    rem_m = (remaining_seconds % 3600) // 60

    time_formatted = f"{utc_hours:02d}:{utc_minutes:02d}:{utc_seconds:02d} UTC"
    time_elapsed_formatted = f"{utc_hours}h {utc_minutes}m"

    if not results:
        return HTMLResponse(f"""<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Cloudflare Workers Usage</title>
    <link rel="preconnect" href="https://fonts.googleapis.com">
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
    <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
    <style>
        :root {{
            --bg-color: #090d16;
            --card-bg: rgba(17, 24, 39, 0.75);
            --border-color: rgba(255, 255, 255, 0.08);
            --text-primary: #f3f4f6;
            --text-secondary: #9ca3af;
            --cf-orange: #f38020;
        }}
        * {{ box-sizing: border-box; margin: 0; padding: 0; }}
        body {{
            font-family: 'Inter', system-ui, -apple-system, sans-serif;
            background: var(--bg-color);
            color: var(--text-primary);
            min-height: 100vh;
            display: flex;
            flex-direction: column;
            justify-content: space-between;
            padding: 2rem 1rem;
        }}
        .empty-container {{
            max-width: 500px;
            margin: 4rem auto;
            text-align: center;
            background: var(--card-bg);
            border: 1px solid var(--border-color);
            border-radius: 16px;
            padding: 2.5rem 1.5rem;
            backdrop-filter: blur(12px);
        }}
        h2 {{ font-size: 1.4rem; margin-bottom: 0.75rem; color: #ef4444; }}
        p {{ color: var(--text-secondary); font-size: 0.95rem; line-height: 1.5; }}
        footer {{
            text-align: center;
            padding: 2rem 1rem;
            color: var(--text-secondary);
            font-size: 0.85rem;
            border-top: 1px solid var(--border-color);
            margin-top: 3rem;
        }}
        .footer-content {{ max-width: 800px; margin: 0 auto; display: flex; flex-direction: column; gap: 0.5rem; align-items: center; }}
        .dev-link {{ color: var(--cf-orange); text-decoration: none; font-weight: 500; }}
        .dev-link:hover {{ text-decoration: underline; }}
    </style>
</head>
<body>
    <div class="empty-container">
        <h2>No Accounts Configured</h2>
        <p>No Cloudflare accounts configured in Environment Variables.</p>
    </div>
    <footer>
        <div class="footer-content">
            <p>© <span id="year">2026</span> Cloudflare Workers Usage Dashboard. All rights reserved.</p>
            <p>Developed with ❤️ by <a href="#" class="dev-link">[Developer Name]</a></p>
        </div>
    </footer>
    <script>document.getElementById('year').textContent = new Date().getFullYear();</script>
</body>
</html>""")

    total_requests = 0
    total_limit = 0

    cards_html = ""
    for res in results:
        req = res.get("requests", 0)
        lim = res.get("limit", WORKERS_LIMIT)
        pct = res.get("pct", 0.0)
        err = res.get("error")

        total_requests += req
        total_limit += lim

        display_header = res["name"]
        if res.get("email"):
            name_lower = res["name"].lower()
            email_lower = res["email"].lower()
            if email_lower not in name_lower and name_lower not in email_lower:
                display_header = f"{res['name']} ({res['email']})"
        err_badge = f'<div class="error-badge"><span>⚠️</span> {err}</div>' if err else ""

        bar_gradient = "linear-gradient(90deg, #3b82f6, #06b6d4)"
        badge_class = "badge-normal"
        if pct > 90:
            bar_gradient = "linear-gradient(90deg, #f43f5e, #ef4444)"
            badge_class = "badge-danger"
        elif pct > 75:
            bar_gradient = "linear-gradient(90deg, #f59e0b, #f97316)"
            badge_class = "badge-warning"

        cards_html += f"""
        <div class="card">
            <div class="card-header">
                <div class="account-title">
                    <svg class="account-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <path stroke-linecap="round" stroke-linejoin="round" d="M19 21v-2a4 4 0 00-4-4H9a4 4 0 00-4 4v2" />
                        <circle cx="12" cy="7" r="4" />
                    </svg>
                    <span class="account-name">{display_header}</span>
                </div>
                <div class="usage-stats">
                    <span class="usage-count">{req:,} / {lim:,}</span>
                    <span class="pct-badge {badge_class}">{pct}%</span>
                </div>
            </div>
            <div class="bar-bg">
                <div class="bar-fill" style="width: {pct}%; background: {bar_gradient};"></div>
            </div>
            {err_badge}
        </div>
        """

    overall_pct = round((total_requests / total_limit * 100), 1) if total_limit > 0 else 0.0

    return HTMLResponse(f"""
    <!DOCTYPE html>
    <html lang="en">
    <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Cloudflare Workers Usage Dashboard</title>
        <link rel="preconnect" href="https://fonts.googleapis.com">
        <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
        <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
        <style>
            :root {{
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
            }}

            * {{ box-sizing: border-box; margin: 0; padding: 0; }}

            body {{
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
            }}

            .container {{
                max-width: 860px;
                margin: 0 auto;
                width: 100%;
            }}

            /* Top Header */
            header {{
                margin-bottom: 1.5rem;
                display: flex;
                justify-content: space-between;
                align-items: center;
                flex-wrap: wrap;
                gap: 1rem;
            }}

            .brand {{
                display: flex;
                align-items: center;
                gap: 0.75rem;
            }}

            .cf-logo {{
                width: 38px;
                height: 38px;
                background: linear-gradient(135deg, #f38020, #faad3f);
                border-radius: 10px;
                display: flex;
                align-items: center;
                justify-content: center;
                box-shadow: 0 4px 12px var(--cf-orange-glow);
            }}

            .cf-logo svg {{ width: 22px; height: 22px; fill: #ffffff; }}

            h1 {{
                font-size: 1.5rem;
                font-weight: 700;
                letter-spacing: -0.02em;
                background: linear-gradient(180deg, #ffffff 0%, #cbd5e1 100%);
                -webkit-background-clip: text;
                -webkit-text-fill-color: transparent;
            }}

            .status-badge {{
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
            }}

            .pulse-dot {{
                width: 8px;
                height: 8px;
                background-color: #10b981;
                border-radius: 50%;
                box-shadow: 0 0 8px #10b981;
                animation: pulse 2s infinite;
            }}

            @keyframes pulse {{
                0% {{ transform: scale(0.95); box-shadow: 0 0 0 0 rgba(16, 185, 129, 0.7); }}
                70% {{ transform: scale(1); box-shadow: 0 0 0 6px rgba(16, 185, 129, 0); }}
                100% {{ transform: scale(0.95); box-shadow: 0 0 0 0 rgba(16, 185, 129, 0); }}
            }}

            /* UTC Time Reset Bar Card */
            .reset-card {{
                background: var(--card-bg);
                border: 1px solid var(--border-color);
                border-radius: 14px;
                padding: 1.25rem;
                margin-bottom: 1.5rem;
                backdrop-filter: blur(12px);
                box-shadow: 0 10px 25px -5px rgba(0, 0, 0, 0.3);
                position: relative;
                overflow: hidden;
            }}

            .reset-card::before {{
                content: '';
                position: absolute;
                top: 0; left: 0; right: 0;
                height: 2px;
                background: linear-gradient(90deg, #f38020, #06b6d4);
            }}

            .reset-header {{
                display: flex;
                justify-content: space-between;
                align-items: center;
                margin-bottom: 0.75rem;
                flex-wrap: wrap;
                gap: 0.5rem;
            }}

            .reset-title {{
                display: flex;
                align-items: center;
                gap: 0.5rem;
                font-size: 0.95rem;
                font-weight: 600;
                color: #f3f4f6;
            }}

            .reset-title svg {{ width: 18px; height: 18px; color: var(--cf-orange); }}

            .reset-meta {{
                display: flex;
                align-items: center;
                gap: 1rem;
                font-size: 0.85rem;
                color: var(--text-secondary);
            }}

            .clock-pill {{
                background: rgba(255, 255, 255, 0.05);
                padding: 0.25rem 0.6rem;
                border-radius: 6px;
                font-family: monospace;
                font-weight: 600;
                color: #38bdf8;
                border: 1px solid rgba(56, 189, 248, 0.2);
            }}

            /* Animated Progress Bars */
            .bar-bg {{
                background: rgba(30, 41, 59, 0.6);
                height: 12px;
                border-radius: 9999px;
                overflow: hidden;
                position: relative;
                box-shadow: inset 0 2px 4px rgba(0, 0, 0, 0.4);
            }}

            .bar-fill {{
                height: 100%;
                border-radius: 9999px;
                transition: width 1s cubic-bezier(0.4, 0, 0.2, 1);
                animation: fillBar 1.2s cubic-bezier(0.16, 1, 0.3, 1) ease-out;
                position: relative;
                overflow: hidden;
            }}

            .bar-fill::after {{
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
            }}

            .time-bar-fill {{
                background: linear-gradient(90deg, #f38020, #3b82f6);
            }}

            @keyframes fillBar {{
                from {{ width: 0%; }}
            }}

            @keyframes shimmer {{
                0% {{ background-position: -200px 0; }}
                100% {{ background-position: 200px 0; }}
            }}

            .reset-sub {{
                display: flex;
                justify-content: space-between;
                margin-top: 0.5rem;
                font-size: 0.8rem;
                color: var(--text-muted);
            }}

            /* Overview Metrics Grid */
            .metrics-grid {{
                display: grid;
                grid-template-columns: repeat(auto-fit, minmax(160px, 1fr));
                gap: 0.75rem;
                margin-bottom: 1.5rem;
            }}

            .metric-card {{
                background: var(--card-bg);
                border: 1px solid var(--border-color);
                border-radius: 12px;
                padding: 1rem;
                backdrop-filter: blur(12px);
            }}

            .metric-label {{
                font-size: 0.78rem;
                color: var(--text-secondary);
                margin-bottom: 0.35rem;
                text-transform: uppercase;
                letter-spacing: 0.04em;
            }}

            .metric-value {{
                font-size: 1.25rem;
                font-weight: 700;
                color: #ffffff;
            }}

            .section-title {{
                font-size: 1.1rem;
                font-weight: 600;
                margin-bottom: 1rem;
                display: flex;
                align-items: center;
                gap: 0.5rem;
            }}

            /* Account Cards */
            .card {{
                background: var(--card-bg);
                border: 1px solid var(--border-color);
                border-radius: 12px;
                padding: 1.25rem;
                margin-bottom: 1rem;
                backdrop-filter: blur(12px);
                transition: transform 0.2s ease, border-color 0.2s ease, box-shadow 0.2s ease;
            }}

            .card:hover {{
                transform: translateY(-2px);
                border-color: rgba(255, 255, 255, 0.18);
                box-shadow: 0 12px 20px -5px rgba(0, 0, 0, 0.4);
                background: var(--card-hover);
            }}

            .card-header {{
                display: flex;
                justify-content: space-between;
                align-items: center;
                margin-bottom: 0.85rem;
                flex-wrap: wrap;
                gap: 0.75rem;
            }}

            .account-title {{
                display: flex;
                align-items: center;
                gap: 0.6rem;
            }}

            .account-icon {{
                width: 18px;
                height: 18px;
                color: var(--text-secondary);
                flex-shrink: 0;
            }}

            .account-name {{
                font-weight: 600;
                font-size: 1rem;
                color: #f9fafb;
                word-break: break-word;
            }}

            .usage-stats {{
                display: flex;
                align-items: center;
                gap: 0.75rem;
            }}

            .usage-count {{
                font-size: 0.9rem;
                font-weight: 600;
                color: var(--text-secondary);
                font-family: monospace;
            }}

            .pct-badge {{
                font-size: 0.78rem;
                font-weight: 700;
                padding: 0.2rem 0.55rem;
                border-radius: 6px;
                letter-spacing: 0.02em;
            }}

            .badge-normal {{ background: rgba(59, 130, 246, 0.15); color: #60a5fa; border: 1px solid rgba(59, 130, 246, 0.3); }}
            .badge-warning {{ background: rgba(245, 158, 11, 0.15); color: #fbbf24; border: 1px solid rgba(245, 158, 11, 0.3); }}
            .badge-danger  {{ background: rgba(239, 68, 68, 0.15); color: #f87171; border: 1px solid rgba(239, 68, 68, 0.3); }}

            .error-badge {{
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
            }}

            /* Footer */
            footer {{
                margin-top: 3rem;
                padding: 2rem 0 1rem 0;
                border-top: 1px solid var(--border-color);
                text-align: center;
                color: var(--text-secondary);
                font-size: 0.85rem;
            }}

            .footer-container {{
                display: flex;
                flex-direction: column;
                gap: 0.6rem;
                align-items: center;
            }}

            .footer-credits {{
                display: flex;
                align-items: center;
                gap: 0.35rem;
                flex-wrap: wrap;
                justify-content: center;
            }}

            .dev-link {{
                color: var(--cf-orange);
                text-decoration: none;
                font-weight: 500;
                transition: color 0.2s ease;
            }}

            .dev-link:hover {{
                color: #faad3f;
                text-decoration: underline;
            }}

            .heart {{ color: #ef4444; }}

            .footer-badge {{
                font-size: 0.75rem;
                color: var(--text-muted);
                background: rgba(255, 255, 255, 0.03);
                padding: 0.25rem 0.6rem;
                border-radius: 9999px;
                border: 1px solid var(--border-color);
                margin-top: 0.25rem;
            }}

            /* Responsive Breakpoints */
            @media (max-width: 640px) {{
                body {{ padding: 1rem 0.75rem; }}
                h1 {{ font-size: 1.25rem; }}
                .card-header {{ flex-direction: column; align-items: flex-start; gap: 0.4rem; }}
                .usage-stats {{ width: 100%; justify-content: space-between; margin-top: 0.25rem; }}
                .reset-header {{ flex-direction: column; align-items: flex-start; }}
                .reset-meta {{ width: 100%; justify-content: space-between; margin-top: 0.25rem; }}
                .metrics-grid {{ grid-template-columns: repeat(2, 1fr); }}
            }}
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
                <div class="status-badge">
                    <span class="pulse-dot"></span>
                    <span>Live Edge Data</span>
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
                        <span id="utc-clock" class="clock-pill">{time_formatted}</span>
                        <span id="utc-pct-badge" class="pct-badge badge-normal" style="background: rgba(243, 128, 32, 0.15); color: #f38020; border-color: rgba(243, 128, 32, 0.3);">{day_progress_pct}%</span>
                    </div>
                </div>
                <div class="bar-bg">
                    <div id="utc-bar-fill" class="bar-fill time-bar-fill" style="width: {day_progress_pct}%;"></div>
                </div>
                <div class="reset-sub">
                    <span id="utc-elapsed">⏱️ {time_elapsed_formatted} elapsed</span>
                    <span id="utc-remaining">⏳ {rem_h}h {rem_m}m until 00:00 UTC reset</span>
                </div>
            </div>

            <!-- Metrics Overview Grid -->
            <div class="metrics-grid">
                <div class="metric-card">
                    <div class="metric-label">Monitored Accounts</div>
                    <div class="metric-value">{len(results)}</div>
                </div>
                <div class="metric-card">
                    <div class="metric-label">Total Requests Today</div>
                    <div class="metric-value">{total_requests:,}</div>
                </div>
                <div class="metric-card">
                    <div class="metric-label">Total Free Quota</div>
                    <div class="metric-value">{total_limit:,}</div>
                </div>
                <div class="metric-card">
                    <div class="metric-label">Overall Usage</div>
                    <div class="metric-value" style="color: {'#f97316' if overall_pct > 75 else '#38bdf8'}">{overall_pct}%</div>
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

            <div class="account-list">
                {cards_html}
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
                    <a href="#" class="dev-link" target="_blank" rel="noopener">[Developer Name / Portfolio]</a>
                </div>
                <div class="footer-badge">
                    Powered by Cloudflare Workers & GraphQL API
                </div>
            </div>
        </footer>

        <script>
            // Set dynamic copyright year
            document.getElementById('year').textContent = new Date().getFullYear();

            // Real-time Cloudflare UTC Reset Clock & Bar updater
            function updateUtcResetBar() {{
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

                if (clockEl) clockEl.textContent = `${{hPad}}:${{mPad}}:${{sPad}} UTC`;
                if (elapsedEl) elapsedEl.textContent = `⏱️ ${{h}}h ${{m}}m elapsed`;
                if (remainingEl) remainingEl.textContent = `⏳ ${{remH}}h ${{remM}}m until 00:00 UTC reset`;
                if (barEl) barEl.style.width = pct + '%';
                if (pctBadgeEl) pctBadgeEl.textContent = pct + '%';
            }}

            setInterval(updateUtcResetBar, 1000);
            updateUtcResetBar();
        </script>
    </body>
    </html>
    """)
