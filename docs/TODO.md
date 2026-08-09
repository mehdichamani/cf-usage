🌐 **Languages:** **English** | [فارسی](TODO.fa.md)

# 📋 TODO & Roadmap

- [x] **System/Dark/Light Switchable Themes**
  - *Status:* Completed. Implemented responsive theme variables (`:root`, `:root.theme-light`, `:root.theme-dark`), dynamic system scheme media query listeners, and a dropdown switcher that persists preference in `localStorage`.
- [x] **English/Persian Switchable Language**
  - *Status:* Completed. Integrated Vazirmatn Persian typography font, built a bidirectional translation system (`applyLanguage('fa' | 'en')`), customized RTL layouts, and translated all static labels, dynamic clocks, modals, and prompt alerts.
- [ ] Ideas for easier deployment for end users (e.g. mobile/phone deployment)
- [x] **Setup Password on First Startup**
  - *Status:* Completed. Removed requirement for `DASHBOARD_PASSWORD` environment variable; admin password is created dynamically on first startup via Web UI and persisted safely in Cloudflare KV.
- [x] **Pure Cloudflare Worker Repository Cleanup**
  - *Status:* Completed. Removed all legacy Python files, Dockerfile, render.yaml, and cache files.
- [x] **Persian Documentation & Censorship Bypass Links**
  - *Status:* Completed. Added Persian README and documentation files along with references to panel tools (Bia Pain Bache & Nahan).
