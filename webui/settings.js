import { LANGUAGES, DICTIONARIES } from './i18n.js';

// The studio's language and theme. Both are choices of the person using it,
// so they live in this browser, not in the project.

const STORAGE_KEY = 'tgpilot.studio';

const DEFAULTS = {
  lang: 'en',
  theme: 'system',
  fontSize: 13,
  backupBeforePush: false,
};

let settings = { ...DEFAULTS, ...read() };

function read() {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
  } catch {
    return {};
  }
}

function write() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  } catch {
    /* a private window without storage still works, it just forgets */
  }
}

export function getSettings() {
  return { ...settings };
}

export function setSetting(key, value) {
  settings = { ...settings, [key]: value };
  write();
  applySettings();
  return getSettings();
}

export function currentLanguage() {
  return LANGUAGES.find((l) => l.code === settings.lang) || LANGUAGES[0];
}

// The text of a key, with {placeholders} filled in.
export function t(key, vars) {
  const dict = DICTIONARIES[settings.lang] || DICTIONARIES.en;
  let text = dict[key] ?? DICTIONARIES.en[key] ?? key;
  if (vars) {
    for (const [name, value] of Object.entries(vars)) {
      text = text.replaceAll(`{${name}}`, String(value));
    }
  }
  return text;
}

// Walks the markup and replaces every marked text with the translation.
export function applyTranslations(root = document) {
  for (const el of root.querySelectorAll('[data-i18n]')) {
    const key = el.dataset.i18n;
    const value = t(key);
    if (el.dataset.i18nAttr) el.setAttribute(el.dataset.i18nAttr, value);
    else el.textContent = value;
  }
  for (const el of root.querySelectorAll('[data-i18n-placeholder]')) {
    el.setAttribute('placeholder', t(el.dataset.i18nPlaceholder));
  }
  for (const el of root.querySelectorAll('[data-i18n-title]')) {
    el.setAttribute('title', t(el.dataset.i18nTitle));
  }
}

export function applySettings() {
  const html = document.documentElement;
  const theme = settings.theme;
  html.dataset.theme = theme;
  html.dataset.lang = settings.lang;

  const language = currentLanguage();
  html.lang = language.code;
  html.dir = language.dir;

  const editor = document.getElementById('editor');
  if (editor) editor.style.fontSize = `${settings.fontSize}px`;

  applyTranslations();
}

// Picks the language the browser asks for, the first time.
export function guessLanguage() {
  const wanted = (navigator.language || 'en').toLowerCase();
  const found = LANGUAGES.find((l) => wanted.startsWith(l.code));
  if (found) return found.code;
  if (wanted.startsWith('fa') || wanted.startsWith('ar') || wanted.startsWith('ur')) return 'fa';
  if (wanted.startsWith('zh')) return 'zh';
  if (wanted.startsWith('ru')) return 'ru';
  return 'en';
}
