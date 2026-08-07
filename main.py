import os
import asyncio
from datetime import datetime, timezone
from fastapi import FastAPI, Request
from fastapi.responses import HTMLResponse
from fastapi.templating import Jinja2Templates
import httpx

app = FastAPI()

# Cloudflare accounts setup
# In production, pass these via environment variables or JSON string
ACCOUNTS = [
    {
        "name": "Account 1",
        "account_id": os.getenv("CF_ACCOUNT_ID_1", "YOUR_ACCOUNT_ID_1"),
        "api_token": os.getenv("CF_API_TOKEN_1", "YOUR_API_TOKEN_1"),
    },
    {
        "name": "Account 2",
        "account_id": os.getenv("CF_ACCOUNT_ID_2", "YOUR_ACCOUNT_ID_2"),
        "api_token": os.getenv("CF_API_TOKEN_2", "YOUR_API_TOKEN_2"),
    },
]

WORKERS_LIMIT = 100_000

GRAPHQL_QUERY = """
query GetWorkersUsage($accountTag: string, $date: string) {
  viewer {
    accounts(filter: {accountTag: $accountTag}) {
      workersInvocationsAdaptive(limit: 10, filter: {date: $date}) {
        sum {
          requests
        }
      }
    }
  }
}
"""

async def fetch_account_usage(client: httpx.AsyncClient, account: dict) -> dict:
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
        
        # Parse workers daily sum
        invocations = data.get("data", {}).get("viewer", {}).get("accounts", [{}])[0].get("workersInvocationsAdaptive", [])
        requests_today = invocations[0]["sum"]["requests"] if invocations else 0
        
        pct = min(round((requests_today / WORKERS_LIMIT) * 100, 1), 100)
        
        return {
            "name": account["name"],
            "requests": requests_today,
            "limit": WORKERS_LIMIT,
            "pct": pct,
            "status": "ok"
        }
    except Exception as e:
        return {
            "name": account["name"],
            "requests": 0,
            "limit": WORKERS_LIMIT,
            "pct": 0,
            "status": f"Error: {str(e)}"
        }

@app.get("/", response_class=HTMLResponse)
async def dashboard(request: Request):
    async with httpx.AsyncClient() as client:
        tasks = [fetch_account_usage(client, acc) for acc in ACCOUNTS]
        results = await asyncio.gather(*tasks)

    # Simple inline dark mode HTML template
    html_content = f"""
    <!DOCTYPE html>
    <html lang="en">
    <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Cloudflare Usage Monitor</title>
        <style>
            body {{ font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; background: #0f0f10; color: #f3f3f3; margin: 0; padding: 2rem; }}
            .container {{ max-width: 800px; margin: 0 auto; }}
            h1 {{ font-size: 1.8rem; margin-bottom: 1.5rem; }}
            .card {{ background: #18181b; border: 1px solid #27272a; border-radius: 8px; padding: 1.25rem; margin-bottom: 1rem; }}
            .card-header {{ display: flex; justify-content: space-between; font-weight: 600; margin-bottom: 0.75rem; }}
            .bar-bg {{ background: #27272a; height: 10px; border-radius: 5px; overflow: hidden; }}
            .bar-fill {{ height: 100%; transition: width 0.3s ease; }}
            .status-err {{ color: #ef4444; font-size: 0.85rem; margin-top: 0.5rem; }}
        </style>
    </head>
    <body>
        <div class="container">
            <h1>Cloudflare Workers Usage (Today)</h1>
            {"".join([f'''
            <div class="card">
                <div class="card-header">
                    <span>{res['name']}</span>
                    <span>{res['requests']:,} / {res['limit']:,}</span>
                </div>
                <div class="bar-bg">
                    <div class="bar-fill" style="width: {res['pct']}%; background: {'#ef4444' if res['pct'] > 90 else '#f97316' if res['pct'] > 75 else '#3b82f6'};"></div>
                </div>
                {f'<div class="status-err">{res["status"]}</div>' if res['status'] != 'ok' else ''}
            </div>
            ''' for res in results])}
        </div>
    </body>
    </html>
    """
    return HTMLResponse(content=html_content)