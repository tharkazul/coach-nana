/**
 * Spark App i18n Engine
 * Lightweight, zero-dependency multi-lingual management
 */
(function (window) {
    const STORAGE_KEY = 'spark_app_language';
    const DEFAULT_LANG = 'en';

    class I18nManager {
        constructor() {
            this.locales = window.i18nLocales || {};
            this.currentLang = localStorage.getItem(STORAGE_KEY) || this.detectBrowserLanguage();
            if (!this.locales[this.currentLang]) {
                this.currentLang = DEFAULT_LANG;
            }
        }

        detectBrowserLanguage() {
            const browserLang = (navigator.language || navigator.userLanguage || 'en').split('-')[0].toLowerCase();
            return this.locales[browserLang] ? browserLang : DEFAULT_LANG;
        }

        getLanguage() {
            return this.currentLang;
        }

        getLanguageName(lang = this.currentLang) {
            const names = {
                en: 'English',
                nl: 'Nederlands',
                de: 'Deutsch',
                es: 'Español',
                fr: 'Français'
            };
            return names[lang] || lang.toUpperCase();
        }

        setLanguage(lang) {
            if (!this.locales[lang]) {
                console.warn(`[i18n] Language '${lang}' not loaded.`);
                return;
            }
            this.currentLang = lang;
            localStorage.setItem(STORAGE_KEY, lang);
            document.documentElement.lang = lang;
            this.applyTranslations();
            window.dispatchEvent(new CustomEvent('languageChanged', { detail: { language: lang } }));
        }

        /**
         * Retrieve a translation string by nested key e.g. 'nav.dashboard'
         * Supports parameter interpolation: t('chat.dailyMessagesLeft', { count: 5 }) -> "5 messages left"
         */
        t(key, params = {}) {
            let dict = this.locales[this.currentLang] || this.locales[DEFAULT_LANG];
            let fallbackDict = this.locales[DEFAULT_LANG];

            let value = this.getNestedValue(dict, key);
            if (value === undefined && dict !== fallbackDict) {
                value = this.getNestedValue(fallbackDict, key);
            }

            if (value === undefined) {
                return key;
            }

            if (params && typeof params === 'object') {
                Object.keys(params).forEach(paramKey => {
                    const placeholder = new RegExp(`\\{${paramKey}\\}`, 'g');
                    value = String(value).replace(placeholder, params[paramKey]);
                });
            }

            return value;
        }

        getNestedValue(obj, path) {
            if (!obj || typeof obj !== 'object') return undefined;
            const keys = path.split('.');
            let current = obj;
            for (let i = 0; i < keys.length; i++) {
                if (current[keys[i]] === undefined) return undefined;
                current = current[keys[i]];
            }
            return current;
        }

        /**
         * Scan DOM for data-i18n attributes and translate
         */
        applyTranslations(root = document) {
            // Text content
            root.querySelectorAll('[data-i18n]').forEach(el => {
                const key = el.getAttribute('data-i18n');
                if (key) {
                    el.textContent = this.t(key);
                }
            });

            // HTML content
            root.querySelectorAll('[data-i18n-html]').forEach(el => {
                const key = el.getAttribute('data-i18n-html');
                if (key) {
                    el.innerHTML = this.t(key);
                }
            });

            // Input placeholders
            root.querySelectorAll('[data-i18n-placeholder]').forEach(el => {
                const key = el.getAttribute('data-i18n-placeholder');
                if (key) {
                    el.placeholder = this.t(key);
                }
            });

            // Tooltips / Titles
            root.querySelectorAll('[data-i18n-title]').forEach(el => {
                const key = el.getAttribute('data-i18n-title');
                if (key) {
                    el.title = this.t(key);
                }
            });

            // Image alt text
            root.querySelectorAll('[data-i18n-alt]').forEach(el => {
                const key = el.getAttribute('data-i18n-alt');
                if (key) {
                    el.alt = this.t(key);
                }
            });
        }

        init() {
            document.documentElement.lang = this.currentLang;
            this.applyTranslations();
        }
    }

    window.i18n = new I18nManager();
    window.t = (key, params) => window.i18n.t(key, params);

    document.addEventListener('DOMContentLoaded', () => {
        window.i18n.init();
    });
})(window);
