🌐 **زبان‌ها:** [English](DEPLOYMENT.md) | **فارسی**

# راهنمای دیپلوی پروژه `cf-usage` روی Cloudflare Workers

استقرار پروژه `cf-usage` روی کلودفلر ورکرز باعث **تاخیر صفر در Cold Start**، **عدم خوابیدن سرور (No Idle Sleep)** و **۱۰۰,۰۰۰ درخواست رایگان در روز** می‌شود.

---

## ۱. توسعه سریع محلی (Local Development)

تست محلی کلودفلر ورکر روی سیستم خودتان:

```bash
# ۱. نصب پیش‌نیازها (Wrangler CLI)
npm install

# ۲. اجرای سرور توسعه محلی (با حافظه محلی به صورت پیش‌فرض)
npm run dev
```

آدرس `http://localhost:8787` را در مرورگر باز کنید. برنامه به طور خودکار متغیرها را از `.dev.vars` بارگذاری می‌کند.

> **نکته درباره حافظه محلی در برابر Cloudflare KV ریموت:**
> - **حافظه محلی (پیش‌فرض):** دستور `npm run dev` به طور کامل از حافظه محلی Wrangler (واقع در مسیر `.wrangler/state/`) استفاده می‌کند و نیازی به اتصال به اینترنت یا حساب کلودفلر ندارد.
> - **KV ریموت:** در صورتی که می‌خواهید تست محلی به KV واقعی کلودفلر متصل شود، دستور `npx wrangler dev --remote` را اجرا کنید.

---

## ۲. راه‌اندازی Cloudflare KV (مورد نیاز جهت مدیریت وب)

این داشبورد از Cloudflare KV (`CF_USAGE_KV`) برای ذخیره و مدیریت اکانت‌ها و متغیرها در سمت سرور بدون نیاز به انتشار مجدد استفاده می‌کند.

### گام اول: ساخت KV Namespace

دستور زیر را برای ساخت KV namespace اجرا کنید:

```bash
npx wrangler kv:namespace create CF_USAGE_KV
```

خروجی مشابه زیر خواهد بود:

```text
🌀 Creating namespace with title "cf-usage-CF_USAGE_KV"
✨ Success! Added the following to your wrangler.json:
{
  "kv_namespaces": [
    {
      "binding": "CF_USAGE_KV",
      "id": "abc123def456..."
    }
  ]
}
```

### گام دوم: اتصال (Bind) کردن KV در `wrangler.toml`

فایل `wrangler.toml` را باز کرده و شناسه (ID) جدید KV namespace خود را در بخش `kv_namespaces` قرار دهید:

```toml
[[kv_namespaces]]
binding = "CF_USAGE_KV"
id = "YOUR_KV_NAMESPACE_ID"
```


---

## ۳. انتشار و دیپلوی روی Cloudflare Workers

یکی از روش‌های زیر را انتخاب کنید:

### روش اول: دیپلوی دستی با CLI (Wrangler)

1. **ورود به حساب کلودفلر در CLI**:
   ```bash
   npx wrangler login
   ```
   *(یک پنجره مرورگر برای تایید دسترسی به حساب کلودفلر شما باز می‌شود)*

2. **دیپلوی ورکر**:
   ```bash
   npm run deploy
   ```

---

### روش دوم: دیپلوی خودکار با GitHub Actions (CI/CD)

این ریپازیتوری شامل اکشن گیت‌هاب در مسیر [`.github/workflows/deploy.yml`](../.github/workflows/deploy.yml) است که با هر Push به شاخه `main` به طور خودکار پروژه را دیپلوی می‌کند.

1. **تنظیم Secrets در گیت‌هاب**:
   به ریپازیتوری گیت‌هاب بروید $\rightarrow$ **Settings** $\rightarrow$ **Secrets and variables** $\rightarrow$ **Actions** $\rightarrow$ **New repository secret**:
   - `CLOUDFLARE_API_TOKEN`: توکن API کلودفلر شما (از بخش **Cloudflare Dashboard** $\rightarrow$ **My Profile** $\rightarrow$ **API Tokens** با قالب **Edit Cloudflare Workers**).
   - `CLOUDFLARE_ACCOUNT_ID`: شناسه اکانت کلودفلر شما (موجود در صفحه اصلی داشبورد کلودفلر یا آدرس URL).

2. **دیپلوی با Git Push**:
   کدهای خود را به شاخه `main` پش کنید تا به طور خودکار مستقر شود.

---

### روش سوم: اتصال مستقیم ریپازیتوری در داشبورد کلودفلر

1. وارد **Cloudflare Dashboard** $\rightarrow$ **Workers & Pages** شوید.
2. روی **Create Application** $\rightarrow$ **Workers** کلیک کنید.
3. در گزینه‌های دیپلوی، **Connect Git Repository** را انتخاب کنید.
4. ریپازیتوری و شاخه هدف (`main`) را انتخاب کنید.
5. تنظیمات ساخت را انجام داده (Build command: `npm run deploy` یا پیش‌فرض) و روی **Save and Deploy** کلیک کنید.

---

## ۴. تنظیم رمز عبور مدیر و راه‌اندازی اولیه

هیچ متغیر محیطی یا رمزی از قبل لازم نیست!

هنگامی که برای اولین بار داشبورد را باز می‌کنید:
1. مدال تنظیم رمز عبور مدیر به‌طور خودکار ظاهر می‌شود.
2. رمز عبور دلخواه خود را وارد و تایید کنید.
3. رمز شما به‌طور امن در Cloudflare KV (`CF_USAGE_KV`) ذخیره شده و امکانات کامل مدیریت اکانت‌ها، یادداشت‌ها و لینک‌های سفارشی فعال می‌شود.

---

## مزایای کلودفلر ورکرز در مقایسه با Render Free Tier

| ویژگی | Render Free Tier | Cloudflare Workers |
| :--- | :--- | :--- |
| **تاخیر Cold Start** | ۵۰ تا ۹۰ ثانیه (خواب پس از ۱۵ دقیقه) | **۰ میلی‌ثانیه (آنی)** |
| **درخواست‌های رایگان** | محدودیت ساعات اجرا | **۱۰۰,۰۰۰ درخواست در روز** |
| **ذخیره‌سازی و سینک** | دیتابیس محلی / حافظه موقت | **سینک جهانی Cloudflare KV** |
| **هزینه** | رایگان (با تاخیر خواب) | **۱۰۰٪ رایگان** |
