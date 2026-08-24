/**
 * i18next configuration for the Sardeenz dashboard.
 *
 * Uses a namespace-per-page pattern:
 *   common     — shared strings (nav, actions, status labels)
 *   cluster    — Cluster Overview page
 *   models     — Model list, detail, and deploy pages
 *   workers    — Worker list and detail pages
 *   metrics    — Metrics dashboard
 *   auth       — Login and OAuth callback
 *   catalog    — Runner catalog page
 *   playground — Chatbot Playground page
 */

import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import LanguageDetector from 'i18next-browser-languagedetector';

import commonEn from './locales/en/common.json';
import clusterEn from './locales/en/cluster.json';
import modelsEn from './locales/en/models.json';
import workersEn from './locales/en/workers.json';
import metricsEn from './locales/en/metrics.json';
import authEn from './locales/en/auth.json';
import catalogEn from './locales/en/catalog.json';
import playgroundEn from './locales/en/playground.json';

void i18n
  .use(LanguageDetector)
  .use(initReactI18next)
  .init({
    fallbackLng: 'en',
    defaultNS: 'common',
    ns: ['common', 'cluster', 'models', 'workers', 'metrics', 'auth', 'catalog', 'playground'],
    resources: {
      en: {
        common: commonEn,
        cluster: clusterEn,
        models: modelsEn,
        workers: workersEn,
        metrics: metricsEn,
        auth: authEn,
        catalog: catalogEn,
        playground: playgroundEn,
      },
    },
    interpolation: {
      escapeValue: false, // React already escapes
    },
    detection: {
      order: ['navigator', 'htmlTag'],
      caches: [],
    },
  });

export default i18n;
