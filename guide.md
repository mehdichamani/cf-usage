To read the **user email** and **Workers/Account usage metrics**, configure the following permissions when creating or editing your **Cloudflare API Token** (in **My Profile** $\rightarrow$ **API Tokens**):

---

### Required Token Permissions

**1. To Read User Details (Email)**

* **Category:** `User`
* **Permission:** `User Details` $\rightarrow$ **`Read`**

**2. To Read Workers Usage & Analytics**

* **Category:** `Account`
* **Permission:** `Account Analytics` $\rightarrow$ **`Read`**
* **Category:** `Account`
* **Permission:** `Workers Scripts` $\rightarrow$ **`Read`**

---

### Resource Scope Settings

* **User Resources:** Set to **Include** $\rightarrow$ **All user resources** (or select your specific user account)
* **Account Resources:** Set to **Include** $\rightarrow$ **All accounts** (or select specific accounts)

---

### How to Retrieve User Email via API

Query the `GET /client/v4/user` REST endpoint using the API Token:

```bash
curl -X GET "https://api.cloudflare.com/client/v4/user" \
     -H "Authorization: Bearer YOUR_API_TOKEN" \
     -H "Content-Type: application/json"

```

Response payload:

```json
{
  "result": {
    "id": "1234567890abcdef1234567890abcdef",
    "email": "user@example.com",
    "first_name": "John",
    "last_name": "Doe"
  },
  "success": true
}

```