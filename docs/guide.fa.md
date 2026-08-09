🌐 **زبان‌ها:** [English](guide.md) | **فارسی**

# راهنمای مجوزهای توکن API کلودفلر (Cloudflare API Token)

برای دریافت **ایمیل کاربر** و **آمارهای مصرف کلودفلر ورکرز/اکانت**، هنگام ساخت یا ویرایش **توکن API کلودفلر** (در بخش **My Profile** $\rightarrow$ **API Tokens**) مجوزهای زیر را تنظیم کنید:

---

### مجوزهای مورد نیاز توکن

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
