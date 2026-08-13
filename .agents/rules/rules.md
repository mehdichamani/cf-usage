---
trigger: always_on
glob: "**/*.js"
description: "Rules for template literals serving client-side JavaScript"
---

# Template Literal Escaping Rule

When modifying or adding HTML/JS content served inside server-side template literals (such as `return \`...\`` in `src/index.js`):
- Any double quotes (`"`) or single quotes (`'`) nested inside `<script>` blocks or JSON objects parsed on the client side **must** be escaped with double backslashes (`\\"` or `\\'`), not single backslashes (`\"` or `\'`).
- A single backslash escape (e.g. `\"`) is consumed by the server-side template literal execution, resulting in unescaped raw quotes in the served HTML page. This will crash the client-side JavaScript parser (e.g. `SyntaxError: Unexpected identifier`).
