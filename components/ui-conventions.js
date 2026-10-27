/* Browser Kitty shared UI conventions 1.0.0. Build-time embed only; no network. */
(function (root) {
  'use strict';
  const version = '1.0.0';
  const languageKey = 'browser-kitty:ui-language:v1';
  const validLanguage = value => value === 'ja' || value === 'en';
  function safely(read, fallback) { try { return read(); } catch (_) { return fallback; } }
  function dependency(options, key, readDefault, fallback) {
    return safely(() => Object.prototype.hasOwnProperty.call(options, key) ? options[key] : readDefault(), fallback);
  }
  function storageFrom(options) { return dependency(options, 'storage', () => root.localStorage, null); }
  function urlFrom(options) { return dependency(options, 'url', () => root.location.href, ''); }
  function parseUrl(value) { return safely(() => new URL(String(value), 'https://browser-kitty.invalid/'), null); }
  function readLanguage(storage, key) { return safely(() => storage && storage.getItem(key), null); }
  function resolveLanguage(options = {}) {
    const url = parseUrl(urlFrom(options));
    const query = url && url.searchParams.get('lang');
    if (validLanguage(query)) return query;
    const storage = storageFrom(options);
    const shared = readLanguage(storage, languageKey);
    if (validLanguage(shared)) return shared;
    for (const key of options.legacyKeys || []) {
      const legacy = readLanguage(storage, key);
      if (validLanguage(legacy)) return legacy;
    }
    const languages = dependency(options, 'languages', () => root.navigator.languages || [root.navigator.language], []);
    for (const value of languages || []) {
      const language = String(value).toLowerCase().split('-')[0];
      if (validLanguage(language)) return language;
    }
    return 'en';
  }
  function chooseLanguage(language, options = {}) {
    if (!validLanguage(language)) throw new TypeError('Unsupported language: ' + language);
    const storage = storageFrom(options);
    const persisted = safely(() => { if (!storage) return false; storage.setItem(languageKey, language); return true; }, false);
    const url = parseUrl(urlFrom(options));
    const history = dependency(options, 'history', () => root.history, null);
    const urlUpdated = safely(() => {
      if (!url || !url.searchParams.has('lang') || !history) return false;
      url.searchParams.set('lang', language);
      history.replaceState(history.state, '', url.href);
      return true;
    }, false);
    return { language, persisted, urlUpdated };
  }
  const copy = {
    en: {
      sessionOnly: 'Your work will be lost when this tab closes',
      manualSave: 'Your work is not saved automatically. Save a project file to continue editing later.',
      dirty: 'Unsaved changes', saving: 'Saving…', saved: 'Saved in this browser',
      saveFailed: 'Could not save in this browser', downloadStarted: 'Download started',
      previousResult: 'Previous result', stopping: 'Stopping…', stopProcessing: 'Stop processing', cancel: 'Cancel',
      languageSessionOnly: 'Language applies to this screen only'
    },
    ja: {
      sessionOnly: '作業内容はこのタブを閉じると消えます',
      manualSave: '自動保存されません。続きの編集には作業ファイルを保存してください',
      dirty: '未保存の変更があります', saving: '保存しています…', saved: 'このブラウザーに保存済み',
      saveFailed: 'このブラウザーに保存できませんでした', downloadStarted: '保存を開始しました',
      previousResult: '前回の結果', stopping: '中止しています…', stopProcessing: '処理を中止', cancel: 'キャンセル',
      languageSessionOnly: '言語はこの画面だけに適用されます'
    }
  };
  function text(key, language = 'en', values = {}) {
    const locale = validLanguage(language) ? language : 'en';
    let value = copy[locale][key] || copy.en[key] || String(key);
    if (key === 'saved' && values.time) value += (locale === 'ja' ? '・' : ' · ') + String(values.time);
    return value.replace(/\{([a-zA-Z0-9_]+)\}/g, (match, name) => Object.prototype.hasOwnProperty.call(values, name) ? String(values[name]) : match);
  }
  function setButtonState(button, state) {
    if (!['ready', 'unavailable', 'busy', 'stopping'].includes(state)) throw new TypeError('Unsupported button state: ' + state);
    button.disabled = state !== 'ready';
    button.setAttribute('data-bk-state', state);
    if (state === 'busy' || state === 'stopping') button.setAttribute('aria-busy', 'true');
    else button.removeAttribute('aria-busy');
  }
  function setSaveStatus(element, options = {}) {
    const mode = options.mode || 'session';
    const state = options.state || 'dirty';
    if (!['session', 'manual', 'autosave'].includes(mode)) throw new TypeError('Unsupported save mode: ' + mode);
    if (!['dirty', 'saving', 'saved', 'error'].includes(state)) throw new TypeError('Unsupported save state: ' + state);
    const key = mode === 'session' ? 'sessionOnly' : mode === 'manual' ? 'manualSave' : state === 'error' ? 'saveFailed' : state;
    element.textContent = text(key, options.language, { time: options.time });
    element.setAttribute('role', 'status');
    element.setAttribute('aria-live', 'polite');
    element.setAttribute('data-bk-save-status', state);
    element.setAttribute('data-bk-save-mode', mode);
  }
  const api = Object.freeze({ version, languageKey, resolveLanguage, chooseLanguage, text, setButtonState, setSaveStatus });
  root.BrowserKittyUI = api;
  if (typeof module === 'object' && module.exports) module.exports = api;
})(typeof globalThis === 'object' ? globalThis : window);
