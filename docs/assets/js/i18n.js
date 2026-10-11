// Minimal i18n. String tables live in assets/i18n/<lang>.js and register
// themselves on window.KST_I18N[<lang>]; English is the fallback for any
// missing key. Load the tables, then this file, before the app modules.
//
// Static HTML is tagged with attributes and translated once at load:
//   data-i18n="key"              -> textContent
//   data-i18n-html="key"         -> innerHTML (trusted table strings only)
//   data-i18n-title="key"        -> title attribute
//   data-i18n-placeholder="key"  -> placeholder attribute
//   data-i18n-aria-label="key"   -> aria-label attribute
//   data-i18n-alt="key"          -> alt attribute
//
// From JS use I18n.t('key', { name: value }) to substitute {name} placeholders,
// or I18n.h(...) for the same text HTML-escaped when building markup.
// Changing language reloads the page so dynamic text is rebuilt consistently.
// Language pickers are <select data-lang-select> elements; see bindSelectors().
var I18n = (function () {
  var STORAGE_KEY = 'kst2you_lang';
  var DEFAULT_LANG = 'en';
  var tables = window.KST_I18N || {};

  function pickLang() {
    var candidates = [];
    try {
      var stored = localStorage.getItem(STORAGE_KEY);
      if (stored) candidates.push(stored);
    } catch (e) { /* storage unavailable */ }
    (navigator.languages || [navigator.language || '']).forEach(function (l) {
      if (!l) return;
      candidates.push(l);
      candidates.push(l.split('-')[0]);
    });
    for (var i = 0; i < candidates.length; i++) {
      var code = String(candidates[i]).toLowerCase();
      if (tables[code]) return code;
    }
    return DEFAULT_LANG;
  }

  var lang = pickLang();

  function t(key, params) {
    var table = tables[lang] || {};
    var fallback = tables[DEFAULT_LANG] || {};
    var s = Object.prototype.hasOwnProperty.call(table, key) ? table[key]
          : Object.prototype.hasOwnProperty.call(fallback, key) ? fallback[key]
          : key;
    if (params) {
      s = s.replace(/\{(\w+)\}/g, function (m, name) {
        return Object.prototype.hasOwnProperty.call(params, name) ? String(params[name]) : m;
      });
    }
    return s;
  }

  var HTML_ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

  // t() escaped for building HTML strings, including attribute values.
  function h(key, params) {
    return t(key, params).replace(/[&<>"']/g, function (c) { return HTML_ESCAPES[c]; });
  }

  var ATTRS = ['title', 'placeholder', 'aria-label', 'alt'];

  function apply(root) {
    root = root || document;
    root.querySelectorAll('[data-i18n]').forEach(function (el) {
      el.textContent = t(el.getAttribute('data-i18n'));
    });
    root.querySelectorAll('[data-i18n-html]').forEach(function (el) {
      el.innerHTML = t(el.getAttribute('data-i18n-html'));
    });
    ATTRS.forEach(function (attr) {
      root.querySelectorAll('[data-i18n-' + attr + ']').forEach(function (el) {
        el.setAttribute(attr, t(el.getAttribute('data-i18n-' + attr)));
      });
    });
  }

  function setLang(code) {
    try { localStorage.setItem(STORAGE_KEY, code); } catch (e) { /* ignore */ }
    location.reload();
  }

  // Native names, so every option is readable whatever the current language.
  var NAMES = { en: 'English', fr: 'Français', de: 'Deutsch' };

  // Fill each <select data-lang-select> with the loaded languages. With
  // data-lang-select="confirm", ask first while a KST session is open,
  // because the reload drops the connection.
  function bindSelectors(root) {
    root.querySelectorAll('select[data-lang-select]').forEach(function (select) {
      select.innerHTML = '';
      Object.keys(tables).forEach(function (code) {
        var opt = document.createElement('option');
        opt.value = code;
        opt.textContent = NAMES[code] || code;
        opt.selected = code === lang;
        select.appendChild(opt);
      });
      select.addEventListener('change', function () {
        var connected = typeof ws !== 'undefined' && ws && ws.readyState === 1;
        if (select.getAttribute('data-lang-select') === 'confirm' && connected &&
            !confirm(t('lang.reloadConfirm'))) {
          select.value = lang;
          return;
        }
        setLang(select.value);
      });
    });
  }

  document.documentElement.lang = lang;
  // Scripts load at the end of <body>, so the DOM is already parsed here and
  // this runs before any app module fills in dynamic text.
  apply(document);
  bindSelectors(document);

  return {
    t: t,
    h: h,
    apply: apply,
    setLang: setLang,
    lang: function () { return lang; },
    languages: function () { return Object.keys(tables); }
  };
})();
