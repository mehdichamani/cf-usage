🌐 **زبان‌ها:** [English](guide.md) | **فارسی**

# راهنمای مجوزهای توکن API کلودفلر (Cloudflare API Token)

### ⚡ ساخت سریع توکن (با یک کلیک)

شما می‌توانید با کلیک روی لینک زیر، توکن API کلودفلر را به همراه تمامی مجوزها و تنظیمات لازم که از قبل اعمال شده‌اند بسازید:

👉 **[ساخت توکن پیش‌فرض API کلودفلر](https://dash.cloudflare.com/profile/api-tokens?accountId=%2A&name=cf-usage&permissionGroupKeys=%5B%7B%22key%22%3A%22account_analytics%22%2C%22type%22%3A%22read%22%7D%2C%7B%22key%22%3A%22workers_scripts%22%2C%22type%22%3A%22read%22%7D%2C%7B%22key%22%3A%22user_details%22%2C%22type%22%3A%22read%22%7D%5D&zoneId=all)**

#### ویژگی‌های لینک از پیش تنظیم‌شده:
- **نام توکن (Token Name):** به طور خودکار `cf-usage` تنظیم شده است.
- **مجوزهای انتخاب‌شده:**
  - `User` $\rightarrow$ `User Details` $\rightarrow$ **`Read`** (جهت دریافت ایمیل مالک حساب)
  - `Account` $\rightarrow$ `Account Analytics` $\rightarrow$ **`Read`** (جهت دریافت نمودارها و آمار مصرف روزانه)
  - `Account` $\rightarrow$ `Workers Scripts` $\rightarrow$ **`Read`** (جهت دریافت آمار مصرف اسکریپت‌های Workers)
- **محدوده دسترسی (Resource Scope):** به طور پیش‌فرض روی تمامی منابع و اکانت‌ها (`accountId=*` و `zoneId=all`) تنظیم شده است.

**نحوه استفاده:**
۱. روی **[لینک ساخت سریع توکن](https://dash.cloudflare.com/profile/api-tokens?accountId=%2A&name=cf-usage&permissionGroupKeys=%5B%7B%22key%22%3A%22account_analytics%22%2C%22type%22%3A%22read%22%7D%2C%7B%22key%22%3A%22workers_scripts%22%2C%22type%22%3A%22read%22%7D%2C%7B%22key%22%3A%22user_details%22%2C%22type%22%3A%22read%22%7D%5D&zoneId=all)** کلیک کنید (در صورت نیاز وارد حساب کلودفلر خود شوید).
۲. مجوزهای انتخاب‌شده را بررسی کرده و در پایین صفحه روی **Continue to summary** کلیک کنید.
۳. روی **Create Token** کلیک کنید و توکن API تولیدشده را کپی نمایید.

---

### راهنمای تنظیم دستی مجوزهای توکن

در صورتی که مایل هستید **توکن API کلودفلر** را به صورت دستی (در بخش **Cloudflare Dashboard** $\rightarrow$ **My Profile** $\rightarrow$ **API Tokens**) بسازید یا بررسی کنید، مجوزهای زیر را تنظیم نمایید:

**۱. جهت خواندن اطلاعات کاربر (ایمیل)**

* **دسته‌بندی (Category):** `User`
* **مجوز (Permission):** `User Details` $\rightarrow$ **`Read`**

**۲. جهت خواندن آمار و میزان استفاده از Workers**

* **دسته‌بندی (Category):** `Account`
* **مجوز (Permission):** `Account Analytics` $\rightarrow$ **`Read`**
* **دسته‌بندی (Category):** `Account`
* **مجوز (Permission):** `Workers Scripts` $\rightarrow$ **`Read`**

---

### تنظیمات محدوده دسترسی (Resource Scope)

* **منابع کاربر (User Resources):** روی **Include** $\rightarrow$ **All user resources** تنظیم کنید (یا اکانت کاربر مشخص خود را انتخاب کنید).
* **منابع اکانت (Account Resources):** روی **Include** $\rightarrow$ **All accounts** تنظیم کنید (یا اکانت‌های مشخص را انتخاب کنید).

---

### نحوه تست دریافت ایمیل کاربر از طریق API

ارسال درخواست به endpoint مسیر `GET /client/v4/user` با استفاده از توکن API:

```bash
curl -X GET "https://api.cloudflare.com/client/v4/user" \
     -H "Authorization: Bearer YOUR_API_TOKEN" \
     -H "Content-Type: application/json"
```

نمونه پاسخ دریافت شده:

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
