# KST2You — notes for AI agents

## UI text is internationalised

All user-facing text in the web app (`docs/`) comes from the string tables in
`docs/assets/i18n/` (`en.js` is the source of truth; `fr.js` and `de.js` must
have the same keys). Never hard-code English in `docs/index.html` or
`docs/assets/js/*.js`:

- HTML: tag elements with `data-i18n="key"` (or `data-i18n-html`, `-title`,
  `-placeholder`, `-aria-label`, `-alt`).
- JS: `I18n.t('key', { param })` for text, `I18n.h(...)` inside HTML strings.
- Add every new key to **all** tables, with real translations.

Read [doc/I18N.md](doc/I18N.md) before changing any UI text. It covers the
patterns, what must stay in English, and translation conventions. Then run:

```sh
node scripts/check_i18n.js
```

It must report `0 error(s), 0 warning(s)`.
