/**
 * Game translations + i18n bootstrap. This is GAME code — edit it freely.
 *
 * All user-facing text lives in `en.json`. To add a string: add a key there, then reference it
 * with `t('key')` (dynamic text in TS) or `data-i18n="key"` (static text in index.html). Only
 * English is implemented; to localize later, add `./<lang>.json` and list it in `resources`
 * below — no game logic changes needed. The detection policy (how a locale is chosen, and how to
 * test one with `?lng=`) lives in the framework wrapper; see the plugin's docs/localization.md.
 */
import { initI18n, t } from '@/framework/i18n/i18n';
import en from './en.json';

initI18n({ resources: { en: { translation: en } } });

export { t };
