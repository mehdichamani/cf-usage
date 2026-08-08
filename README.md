# Cloudflare Workers Usage Dashboard

A clean, modern, and light/dark theme switchable dashboard to monitor daily Cloudflare Workers usage across multiple accounts. Built entirely as a Cloudflare Worker using Cloudflare KV.

---

## 📋 TODO & Roadmap

- [x] **system/dark/light switchable themes**
  - *Status:* Completed. Implemented responsive theme variables (`:root`, `:root.theme-light`, `:root.theme-dark`), dynamic system scheme media query listeners, and a dropdown switcher that persists preference in `localStorage`.
- [x] **english/farsi switchable language**
  - *Status:* Completed. Integrated Vazirmatn Persian typography font, built a bidirectional translation system (`applyLanguage('fa' | 'en')`), customized RTL layouts, and translated all static labels, dynamic clocks, modals, and prompt alerts.
- [ ] ideas for easier deploy for end users even with phone
- [ ] ideas password set on install or first startup
- [ ] project is pure cloudflare worker cleanup python and render and what is not needed
- [ ] add readme in persian for users + explain they can track panels like https://github.com/bia-pain-bache , https://github.com/itsyebekhe/nahan for bypass iran censorship

---

## 🇮🇷 راهنمای فارسی کاربران (Persian / Farsi Guide)

این پروژه یک داشبورد ساده و زیبا برای مانیتورینگ میزان استفاده از ورکرز (Cloudflare Workers) در اکانت‌های مختلف کلودفلر است.

### ⚡ دور زدن سانسور و فیلترینگ در ایران (Censorship Bypass)
شما می‌توانید با استفاده از این داشبورد و لینک‌های سفارشی پنل‌های خود را مدیریت و پایش کنید. برای دور زدن فیلترینگ و ردیابی پنل‌های فعال و روش‌های جدید بایپس، می‌توانید پروژه‌ها و ریپازیتوری‌های زیر را دنبال کنید:
- **Bia Pain Bache:** [https://github.com/bia-pain-bache](https://github.com/bia-pain-bache)
- **Nahan:** [https://github.com/itsyebekhe/nahan](https://github.com/itsyebekhe/nahan)

این ریپازیتوری‌ها ابزارها، کانفیگ‌ها و پنل‌های به‌روز را جهت تسهیل دسترسی به اینترنت آزاد ارائه می‌دهند.
