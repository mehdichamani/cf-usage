import os
from pathlib import Path
from datetime import datetime, timezone
import httpx

p = Path('.env')
if p.exists():
    for line in p.read_text().splitlines():
        if '=' in line and not line.startswith('#'):
            k, v = line.split('=', 1)
            os.environ[k.strip()] = v.strip()

account_id = os.environ.get('CF_ACCOUNT_ID_1')
apitoken = os.environ.get('CF_API_TOKEN_1')
print('account_id:', account_id)
print('token_len:', len(apitoken) if apitoken else None)
query = '''query GetWorkersUsage($accountTag: string, $date: string) {
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
'''
payload = {'query': query, 'variables': {'accountTag': account_id, 'date': datetime.now(timezone.utc).strftime('%Y-%m-%d')}}
headers = {'Authorization': f'Bearer {apitoken}', 'Content-Type': 'application/json'}
print('payload:', payload)
with httpx.Client(timeout=10.0) as client:
    r = client.post('https://api.cloudflare.com/client/v4/graphql', json=payload, headers=headers)
    print('status:', r.status_code)
    try:
        print('json:', r.json())
    except Exception:
        print('text:', r.text)
