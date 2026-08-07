import os
import asyncio
from datetime import datetime, timezone
from fastapi import FastAPI, Request
from fastapi.responses import HTMLResponse
import httpx
from dotenv import load_dotenv

load_dotenv()

app = FastAPI()

# Configuration: Parse from environment variables or fallback
ACCOUNTS = [
    {
        "name": os.getenv("CF_ACCOUNT_1_NAME", "Account 1"),
        "account_id": os.getenv("CF_ACCOUNT_ID_1", ""),
        "api_token": os.getenv("CF_API_TOKEN_1", ""),
    },
    {
        "name": os.getenv("CF_ACCOUNT_2_NAME", "Account 2"),
        "account_id": os.getenv("CF_ACCOUNT_ID_2", ""),
        "api_token": os.getenv("CF_API_TOKEN_2", ""),
    },
]

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

async def fetch_account_usage(client: httpx.AsyncClient, account: dict) -> dict:
    if not account["account_id"] or not account["api_token"]:
        return {
            "name": account["name"],
            "requests": 0,
            "limit": WORKERS_LIMIT,
            "pct": 0,
            "error": "Missing Environment Variables (ID or Token)"
        }

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
            return {"name": account["name"], "requests": 0, "limit": WORKERS_LIMIT, "pct": 0, "error": f"API Error: {err_msg}"}
        
        accounts_data = data.get("data", {}).get("viewer", {}).get("accounts", [])
        if not accounts_data:
            return {"name": account["name"], "requests": 0, "limit": WORKERS_LIMIT, "pct": 0, "error": "Account ID not found or Token lacks permissions"}
            
        invocations = accounts_data[0].get("workersInvocationsAdaptive", [])
        total_requests = sum(item.get("sum", {}).get("requests", 0) for item in invocations)
        
        pct = min(round((total_requests / WORKERS_LIMIT) * 100, 1), 100)
        
        return {
            "name": account["name"],
            "requests": total_requests,
            "limit": WORKERS_LIMIT,
            "pct": pct,
            "error": None
        }
    except Exception as e:
        return {
            "name": account["name"],
            "requests": 0,
            "limit": WORKERS_LIMIT,
            "pct": 0,
            "error": f"Connection Error: {str(e)}"
        }

@app.get("/", response_class=HTMLResponse)
async def dashboard(request: Request):
    async with httpx.AsyncClient() as client:
        tasks = [fetch_account_usage(client, acc) for acc in ACCOUNTS if acc["account_id"]]
        results = await asyncio.gather(*tasks) if tasks else []

    if not results:
        return HTMLResponse("<h2>No Cloudflare accounts configured in Environment Variables.</h2>")

    cards_html = ""
    for res in results:
        err_badge = f'<div style="color: #ef4444; font-size: 0.85rem; margin-top: 0.5rem;">⚠️ {res["error"]}</div>' if res["error"] else ""
        cards_html += f"""
        <div class="card">
            <div class="card-header">
                <span>{res['name']}</span>
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