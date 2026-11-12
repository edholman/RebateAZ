/*
 * RebateAZ lead forms -> RebateAZ agent/CRM (https://sms.whyrebate.com/leads/rebateaz)
 *
 * Any <form class="lead-form"> on the page is handled here. Form options (data attributes):
 *   data-form-name   sent as form_name (e.g. "home_page", "new_homes_asante")
 *   data-lang        "en" (default) or "es": Spanish messages, inline success instead of redirect
 *   data-success     "redirect" (default, goes to /thankyou.html which fires the Google Ads conversion)
 *                    or "inline" (shows the .lead-success block and fires the conversion event here)
 *
 * On every page this script also remembers first-touch attribution (UTM tags, gclid, fbclid, landing page)
 * for 30 days, so a lead who lands from an ad and fills out a form on another page is still credited.
 */
(function () {
  'use strict';

  var ENDPOINT = 'https://sms.whyrebate.com/leads/rebateaz';
  var STORE_KEY = 'rebateaz_attribution';
  var ATTR_KEYS = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content', 'gclid', 'fbclid'];
  var MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

  var MSG = {
    en: {
      sending: 'Sending...',
      network: 'Something went wrong sending your info. Please try again, or call or text us at (602) 975-2727.',
      phone: 'Please enter a valid US mobile number.',
      consent: 'Please check the consent box so we can text you.'
    },
    es: {
      sending: 'Enviando...',
      network: 'Hubo un problema al enviar su informaci\u00f3n. Intente de nuevo, o ll\u00e1menos o env\u00edenos un mensaje al (602) 975-2727.',
      phone: 'Ingrese un n\u00famero de celular v\u00e1lido de Estados Unidos.',
      consent: 'Marque la casilla de consentimiento para que podamos enviarle mensajes.'
    }
  };

  function safeStorage() {
    try { var s = window.localStorage; s.setItem('__t', '1'); s.removeItem('__t'); return s; } catch (e) { return null; }
  }

  // Untagged visits: work out source/medium from the referrer (google + organic, chatgpt.com + ai, ...).
  function inferSource(data) {
    if (data.utm_source) return { source: data.utm_source, medium: data.utm_medium || '(none)' };
    if (data.gclid) return { source: 'google', medium: 'cpc' };
    if (data.fbclid) return { source: 'facebook', medium: 'paid_social' };
    var host = '';
    try { host = document.referrer ? new URL(document.referrer).hostname.replace(/^www\./, '') : ''; } catch (e) { host = ''; }
    if (!host || host === window.location.hostname.replace(/^www\./, '')) return { source: '(direct)', medium: '(none)' };
    var engines = { google: /(^|\.)google\./, bing: /(^|\.)bing\.com$/, yahoo: /(^|\.)yahoo\./, duckduckgo: /duckduckgo\.com$/, ecosia: /ecosia\.org$/ };
    for (var name in engines) { if (engines[name].test(host)) return { source: name, medium: 'organic' }; }
    var ai = { chatgpt: /(chatgpt\.com|openai\.com)$/, perplexity: /perplexity\.ai$/, gemini: /gemini\.google\.com$/, copilot: /copilot\.microsoft\.com$/, claude: /claude\.ai$/ };
    for (var a in ai) { if (ai[a].test(host)) return { source: a, medium: 'ai' }; }
    if (/(facebook|fb|instagram|t\.co|twitter|x\.com|linkedin|reddit|nextdoor|youtube|tiktok)/.test(host)) return { source: host, medium: 'social' };
    return { source: host, medium: 'referral' };
  }

  function readAttribution() {
    var store = safeStorage(), saved = null;
    if (store) {
      try { saved = JSON.parse(store.getItem(STORE_KEY) || 'null'); } catch (e) { saved = null; }
      if (saved && (Date.now() - (saved.ts || 0)) > MAX_AGE_MS) saved = null;
    }
    var params = new URLSearchParams(window.location.search), fresh = {}, hasFresh = false;
    ATTR_KEYS.forEach(function (k) { var v = params.get(k); if (v) { fresh[k] = v.slice(0, 200); hasFresh = true; } });
    // A new ad click or tagged link replaces older attribution; otherwise keep the first touch.
    if (hasFresh || !saved) {
      var inferred = inferSource(fresh);
      saved = { ts: Date.now(), landing_page: window.location.href.slice(0, 500), data: fresh, source: inferred.source, medium: inferred.medium };
      if (store) { try { store.setItem(STORE_KEY, JSON.stringify(saved)); } catch (e) { /* ignore */ } }
    }
    var out = {};
    ATTR_KEYS.forEach(function (k) { if (saved.data && saved.data[k]) out[k] = saved.data[k]; });
    // Organic/referral/direct leads arrive in the CRM labeled the same way as tagged ones (e.g. google / organic).
    if (!out.utm_source && saved.source) { out.utm_source = saved.source; out.utm_medium = saved.medium; }
    // Fall back to the Google Ads click ID stored by gtag (_gcl_aw = GCL.<time>.<gclid>).
    if (!out.gclid) {
      var m = document.cookie.match(/(?:^|;\s*)_gcl_aw=([^;]+)/);
      if (m) { var parts = decodeURIComponent(m[1]).split('.'); if (parts.length >= 3) out.gclid = parts.slice(2).join('.'); }
    }
    out.landing_page = saved.landing_page;
    return out;
  }

  var attribution = readAttribution();
  var landingPath = '';
  try { landingPath = new URL(attribution.landing_page).pathname; } catch (e) { landingPath = ''; }
  var trafficSource = (attribution.utm_source || '(direct)') + ' / ' + (attribution.utm_medium || '(none)');

  // Tag every Clarity session so recordings, heatmaps and events can be filtered by source and landing page.
  if (typeof window.clarity === 'function') {
    window.clarity('set', 'traffic_source', trafficSource);
    window.clarity('set', 'traffic_medium', attribution.utm_medium || '(none)');
    if (landingPath) window.clarity('set', 'landing_page', landingPath);
  }

  // Site-wide tap-to-call / tap-to-text tracking (the /lp/ ad pages have their own handler).
  if (window.location.pathname.indexOf('/lp/') !== 0) {
    document.addEventListener('click', function (e) {
      var a = e.target.closest && e.target.closest('a[href^="tel:"], a[href^="sms:"]');
      if (!a) return;
      var method = a.getAttribute('href').indexOf('sms:') === 0 ? 'text' : 'call';
      var info = { method: method, page: window.location.pathname, source: trafficSource, landing_page: landingPath };
      (window.dataLayer = window.dataLayer || []).push({ event: 'contact_click', method: method, page: info.page, traffic_source: trafficSource, landing_page: landingPath });
      if (typeof window.gtag === 'function') { try { window.gtag('event', 'contact_click', info); } catch (err) { /* ignore */ } }
      if (typeof window.clarity === 'function') window.clarity('event', method === 'text' ? 'text_tap' : 'call_tap');
    });
  }

  function fireConversion() {
    if (typeof window.gtag === 'function') {
      try { window.gtag('event', 'ads_conversion_Book_appointment_1', {}); } catch (e) { /* ignore */ }
    }
  }

  function showError(form, text) {
    var box = form.querySelector('.lead-error');
    if (!box) return;
    box.textContent = text;
    box.hidden = false;
  }

  function setup(form) {
    var lang = form.getAttribute('data-lang') === 'es' ? 'es' : 'en';
    var t = MSG[lang];
    var button = form.querySelector('button[type="submit"]');
    var buttonText = button ? button.textContent : '';
    var sending = false;

    form.addEventListener('submit', function (ev) {
      ev.preventDefault();
      if (sending) return;
      var errBox = form.querySelector('.lead-error');
      if (errBox) errBox.hidden = true;

      var phone = form.querySelector('[name="phone"]');
      var consent = form.querySelector('[name="consent"]');
      var digits = phone ? phone.value.replace(/\D/g, '') : '';
      if (digits.length === 11 && digits.charAt(0) === '1') digits = digits.slice(1);
      if (digits.length !== 10) { showError(form, t.phone); if (phone) phone.focus(); return; }
      if (!consent || !consent.checked) { showError(form, t.consent); if (consent) consent.focus(); return; }

      var payload = {};
      Array.prototype.forEach.call(form.elements, function (el) {
        if (!el.name || el.disabled || el.type === 'submit') return;
        if (el.type === 'checkbox') { if (el.name === 'consent') payload.consent = el.checked; else if (el.checked) payload[el.name] = el.value || 'yes'; return; }
        var v = (el.value || '').trim();
        if (v !== '' || el.name === 'website') payload[el.name] = v;
      });
      var consentTextEl = form.querySelector('.lead-consent-text');
      payload.consent_text = consentTextEl ? consentTextEl.textContent.replace(/\s+/g, ' ').trim() : '';
      payload.page_url = window.location.href;
      payload.form_name = form.getAttribute('data-form-name') || 'website';
      Object.keys(attribution).forEach(function (k) { if (attribution[k] && !payload[k]) payload[k] = attribution[k]; });

      sending = true;
      if (button) { button.disabled = true; button.textContent = t.sending; }

      fetch(ENDPOINT, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) })
        .then(function (res) {
          return res.json().catch(function () { return {}; }).then(function (body) { return { status: res.status, body: body }; });
        })
        .then(function (r) {
          if (r.status === 200 && r.body && r.body.ok) {
            (window.dataLayer = window.dataLayer || []).push({ event: 'lead_submitted', form_name: payload.form_name, page: window.location.pathname, traffic_source: trafficSource, landing_page: landingPath });
            if (form.getAttribute('data-success') === 'inline' || lang === 'es') {
              fireConversion();
              var ok = form.parentNode.querySelector('.lead-success');
              form.hidden = true;
              if (ok) { ok.hidden = false; ok.scrollIntoView({ behavior: 'smooth', block: 'center' }); }
            } else {
              window.location.href = '/thankyou.html';
            }
            return;
          }
          showError(form, (r.body && r.body.error) ? r.body.error : t.network);
        })
        .catch(function () { showError(form, t.network); })
        .then(function () { sending = false; if (button) { button.disabled = false; button.textContent = buttonText; } });
    });
  }

  function init() { Array.prototype.forEach.call(document.querySelectorAll('form.lead-form'), setup); }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
})();
