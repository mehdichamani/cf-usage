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

    if not results:
        return HTMLResponse("<h2>No Cloudflare accounts configured in Environment Variables.</h2>")

    cards_html = ""
    for res in results:
        # If email is available, format both name and email in the card header: Name (Email)
        display_header = f"{res['name']} ({res['email']})" if res.get("email") else res["name"]
        err_badge = f'<div style="color: #ef4444; font-size: 0.85rem; margin-top: 0.5rem;">⚠️ {res["error"]}</div>' if res["error"] else ""
        cards_html += f"""
        <div class="card">
            <div class="card-header">
                <span>{display_header}</span>
                <span>{res['requests']:,} / {res['limit']:,}</span>
            </div>
            <div class="bar-bg">
                <div class="bar-fill" style="width: {res['pct']}%; background: {'#ef4444' if res['pct'] > 90 else '#f97316' if res['pct'] > 75 else '#3b82f6'};"></div>
            </div>
            {err_badge}
        </div>
        """

    return HTMLResponse(f"""
    <!DOCTYPE html>
    <html lang="en">
    <head>
        <meta charset="UTF-8">
        <title>Cloudflare Workers Usage</title>
        <style>
            body {{ font-family: system-ui, -apple-system, sans-serif; background: #0f0f10; color: #f3f3f3; margin: 0; padding: 2rem; }}
            .container {{ max-width: 800px; margin: 0 auto; }}
            h1 {{ font-size: 1.8rem; margin-bottom: 1.5rem; }}
            .card {{ background: #18181b; border: 1px solid #27272a; border-radius: 8px; padding: 1.25rem; margin-bottom: 1rem; }}
            .card-header {{ display: flex; justify-content: space-between; font-weight: 600; margin-bottom: 0.75rem; }}
            .bar-bg {{ background: #27272a; height: 10px; border-radius: 5px; overflow: hidden; }}
            .bar-fill {{ height: 100%; transition: width 0.3s ease; }}
        </style>
    </head>
    <body>
        <div class="container">
            <h1>Cloudflare Workers Usage (Today)</h1>
            {cards_html}
        </div>
    </body>
    </html>
    """)
