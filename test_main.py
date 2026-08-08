import os
import asyncio
from datetime import datetime, timezone, timedelta
import pytest
import respx
import httpx
from fastapi.testclient import TestClient

# We can import app, CACHE, CACHE_TTL, fetch_account_info, etc. from main
import main

@pytest.fixture(autouse=True)
def clear_cache_and_setup_env(monkeypatch):
    # Reset CACHE
    main.CACHE.clear()
    # Mock Accounts list in main to avoid external dependency issues
    monkeypatch.setattr(main, "ACCOUNTS", [
        {
            "name": "Manual Name 1",
            "account_id": "acc_id_1",
            "api_token": "token_1",
            "index": 1,
        },
        {
            "name": "Manual Name 2",
            "account_id": "acc_id_2",
            "api_token": "token_2",
            "index": 2,
        }
    ])

@pytest.mark.asyncio
async def test_fetch_account_info_priority():
    user_url = "https://api.cloudflare.com/client/v4/user"
    acc_url_1 = "https://api.cloudflare.com/client/v4/accounts/acc_id_1"

    # 1. Success case: returns both user email and account name
    with respx.mock:
        respx.get(user_url).mock(return_value=httpx.Response(200, json={
            "success": True,
            "result": {"email": "hello@example.com"}
        }))
        respx.get(acc_url_1).mock(return_value=httpx.Response(200, json={
            "success": True,
            "result": {"name": "Cloudflare Account 1"}
        }))

        async with httpx.AsyncClient() as client:
            info = await main.fetch_account_info(client, "acc_id_1", "token_1")
            assert info["email"] == "hello@example.com"
            assert info["cf_account_name"] == "Cloudflare Account 1"

    # 2. Failure case for user, success for accounts
    with respx.mock:
        respx.get(user_url).mock(return_value=httpx.Response(403, json={"success": False}))
        respx.get(acc_url_1).mock(return_value=httpx.Response(200, json={
            "success": True,
            "result": {"name": "Cloudflare Account 1"}
        }))

        async with httpx.AsyncClient() as client:
            info = await main.fetch_account_info(client, "acc_id_1", "token_1")
            assert info["email"] is None
            assert info["cf_account_name"] == "Cloudflare Account 1"

@pytest.mark.asyncio
async def test_fetch_account_usage():
    graphql_url = "https://api.cloudflare.com/client/v4/graphql"

    # Success case: returns some invocations
    with respx.mock:
        respx.post(graphql_url).mock(return_value=httpx.Response(200, json={
            "data": {
                "viewer": {
                    "accounts": [
                        {
                            "workersInvocationsAdaptive": [
                                {"sum": {"requests": 45000}}
                            ]
                        }
                    ]
                }
            }
        }))

        async with httpx.AsyncClient() as client:
            usage = await main.fetch_account_usage(client, main.ACCOUNTS[0])
            assert usage["requests"] == 45000
            assert usage["pct"] == 45.0
            assert usage["error"] is None

    # Error case: API returns Graphql errors
    with respx.mock:
        respx.post(graphql_url).mock(return_value=httpx.Response(200, json={
            "errors": [{"message": "Invalid query parameters"}]
        }))

        async with httpx.AsyncClient() as client:
            usage = await main.fetch_account_usage(client, main.ACCOUNTS[0])
            assert usage["requests"] == 0
            assert usage["error"] == "API Error: Invalid query parameters"

def test_dashboard_endpoint_caching_and_display():
    client = TestClient(main.app)

    user_url = "https://api.cloudflare.com/client/v4/user"
    acc_url_1 = "https://api.cloudflare.com/client/v4/accounts/acc_id_1"
    acc_url_2 = "https://api.cloudflare.com/client/v4/accounts/acc_id_2"
    graphql_url = "https://api.cloudflare.com/client/v4/graphql"

    with respx.mock:
        # Mock API calls for first load
        respx.get(user_url).mock(return_value=httpx.Response(200, json={"success": True, "result": {"email": "acc1@example.com"}}))
        respx.get(acc_url_1).mock(return_value=httpx.Response(200, json={"success": True, "result": {"name": "Fetched Acc 1"}}))
        respx.get(acc_url_2).mock(return_value=httpx.Response(200, json={"success": True, "result": {"name": "Fetched Acc 2"}}))
        respx.post(graphql_url).mock(return_value=httpx.Response(200, json={
            "data": {"viewer": {"accounts": [{"workersInvocationsAdaptive": [{"sum": {"requests": 15000}}]}]}}
        }))

        response = client.get("/")
        assert response.status_code == 200
        html = response.text
        # Verify Fallback/Fetched Name & Email are present in card headers
        assert "Fetched Acc 1 (acc1@example.com)" in html
        assert "Fetched Acc 2 (acc1@example.com)" in html # shared mock user detail endpoint

        # Verify usage requests are displayed
        assert "15,000 / 100,000" in html

        # Verify CACHE is filled
        assert "acc_id_1" in main.CACHE
        assert "acc_id_2" in main.CACHE

        # Let's change the mock responses for the API endpoints.
        # Since the cache is active for 15 minutes, hitting "/" again should NOT trigger API requests,
        # and should serve old results directly from the cache.
        respx.get(user_url).mock(return_value=httpx.Response(200, json={"success": True, "result": {"email": "should_not_fetch@example.com"}}))

        response2 = client.get("/")
        assert response2.status_code == 200
        html2 = response2.text
        assert "Fetched Acc 1 (acc1@example.com)" in html2 # Served from cache!
        assert "should_not_fetch" not in html2

        # Manually expire the cache for acc_id_1
        main.CACHE["acc_id_1"]["expires_at"] = datetime.now(timezone.utc) - timedelta(seconds=1)

        # Now, call "/" again. acc_id_1 should fetch fresh data (and see "should_not_fetch@example.com"),
        # while acc_id_2 should still be served from the cache!
        response3 = client.get("/")
        assert response3.status_code == 200
        html3 = response3.text
        assert "Fetched Acc 1 (should_not_fetch@example.com)" in html3 # Fresh fetch
        assert "Fetched Acc 2 (acc1@example.com)" in html3 # Still cached!
