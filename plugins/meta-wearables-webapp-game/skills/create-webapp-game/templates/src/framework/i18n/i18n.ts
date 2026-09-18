/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * license file distributed with this framework directory.
 */

/**
 * i18next setup for a webapp game. Managed framework code — it owns the
 * locale-detection policy so every game behaves the same, and imports no game code: the game
 * injects its own translation resources (see src/i18n/). This module only decides how a locale is
 * picked and how translated text reaches the DOM.
 *
 * Detection order (see the plugin's docs/localization.md): `?lng=` querystring (to test a locale)
 * -> localStorage (persist a choice) -> navigator (the device/browser language — the runtime
 * default on-glasses) -> `<html lang>`. Untranslated keys fall back to English. Resources are
 * bundled (no async backend), so `initImmediate: false` makes t() usable synchronously, before
 * first paint.
 */
import i18next, { type i18n as I18n, type Resource } from 'i18next';
import LanguageDetector from 'i18next-browser-languagedetector';

export interface InitI18nOptions {
  /** Bundled translations keyed by language, e.g. `{ en: { translation: { title: '…' } } }`. */
  resources: Resource;
  /** Language used when the detected one lacks a key. Defaults to `'en'`. */
  fallbackLng?: string;
}

/** Initialize the shared i18next singleton with bundled resources. Call once at boot. */
export function initI18n(options: InitI18nOptions): I18n {
  i18next.use(LanguageDetector).init({
    resources: options.resources,
    fallbackLng: options.fallbackLng ?? 'en',
    supportedLngs: Object.keys(options.resources),
    nonExplicitSupportedLngs: true,
    // Bundled resources -> init resolves synchronously, so t() works before first paint.
    initImmediate: false,
    // We write translated text via textContent (never innerHTML), so HTML escaping is redundant.
    interpolation: { escapeValue: false },
    detection: {
      order: ['querystring', 'localStorage', 'navigator', 'htmlTag'],
      lookupQuerystring: 'lng',
      caches: ['localStorage'],
    },
  }).catch((error: unknown) => {
    // Bundled resources init synchronously, so init() never rejects here; this only fires if the
    // synchronous contract below is ever broken (e.g. an async backend is added).
    console.error('i18next initialization failed:', error);
  });
  // initImmediate: false + bundled resources guarantees init resolves synchronously, so the
  // singleton is ready the moment this returns. Assert it: if that contract ever breaks, callers
  // must not silently read an uninitialized i18next — fail loudly at boot instead.
  if (!i18next.isInitialized) {
    throw new Error(
      'i18next did not initialize synchronously. With initImmediate:false and bundled resources ' +
        'this should never happen — did an async backend or loader get added? See docs/localization.md.',
    );
  }
  return i18next;
}

/**
 * Translate a key using the active language. Thin wrapper over the singleton so callers always
 * read the current locale — importing `i18next.t` directly can capture a stale binding.
 */
export function t(key: string, options?: Record<string, unknown>): string {
  return i18next.t(key, options) as string;
}

/**
 * Fill every `[data-i18n]` element's text from its key (a `<title data-i18n>` in `<head>` updates
 * the document title too). This is DOM OUTPUT only — it attaches no listeners, so it complies with
 * the no-input-through-DOM rule. Call once after initI18n(), at first paint.
 */
export function applyStaticTranslations(root: ParentNode = document): void {
  for (const el of root.querySelectorAll<HTMLElement>('[data-i18n]')) {
    const key = el.dataset.i18n;
    if (key) {
      el.textContent = t(key);
    }
  }
}
