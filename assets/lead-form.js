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

  var isLp = window.location.pathname.indexOf('/lp/') === 0;
  var isEs = (document.documentElement.lang || '').slice(0, 2) === 'es';
  var isTouch = !!(window.matchMedia && window.matchMedia('(pointer: coarse)').matches);

  function track(name, params) {
    var p = params || {};
    p.page = window.location.pathname; p.traffic_source = trafficSource; p.landing_page = landingPath;
    var dl = { event: name }; Object.keys(p).forEach(function (k) { dl[k] = p[k]; });
    (window.dataLayer = window.dataLayer || []).push(dl);
    if (typeof window.gtag === 'function') { try { window.gtag('event', name, p); } catch (err) { /* ignore */ } }
  }

  // Tap-to-call / tap-to-text tracking on every page.
  // click_to_text / click_to_call: one event per tap, with where it was tapped (cta).
  // contact_click: the older event, kept as-is for reporting continuity (the /lp/ ad pages send lp_contact_click instead).
  document.addEventListener('click', function (e) {
    if (e.defaultPrevented) return;
    var a = e.target.closest && e.target.closest('a[href^="tel:"], a[href^="sms:"]');
    if (!a) return;
    var method = a.getAttribute('href').indexOf('sms:') === 0 ? 'text' : 'call';
    var cta = a.getAttribute('data-cta') || 'link';
    track(method === 'text' ? 'click_to_text' : 'click_to_call', { method: method, cta: cta });
    if (!isLp) {
      var info = { method: method, page: window.location.pathname, source: trafficSource, landing_page: landingPath };
      (window.dataLayer = window.dataLayer || []).push({ event: 'contact_click', method: method, page: info.page, traffic_source: trafficSource, landing_page: landingPath });
      if (typeof window.gtag === 'function') { try { window.gtag('event', 'contact_click', info); } catch (err) { /* ignore */ } }
      if (typeof window.clarity === 'function') window.clarity('event', method === 'text' ? 'text_tap' : 'call_tap');
    }
  });

  /*
   * Floating "Text us" button (bottom right, every page).
   * Phones: opens the SMS app to (602) 975-2727 with a message that fits the page.
   * Computers: opens a small panel with the number and a name + mobile form (same CRM endpoint and consent as the page forms).
   * A page can set its own message with <meta name="rebateaz-text" content="Hi, I'd like to see ...">.
   */
  var PHONE = '+16029752727', PHONE_FMT = '(602) 975-2727';
  var LP_TOPIC = { 'madera-queen-creek': 'Madera in Queen Creek', 'western-garden-phoenix': 'Western Garden in Phoenix', 'asante-surprise': 'Asante in Surprise', 'teravalis-buckeye': 'Teravalis in Buckeye', 'bella-vista-farms-san-tan-valley': 'Bella Vista Farms in San Tan Valley' };

  function smsHref(body) { return 'sms:' + PHONE + '?&body=' + encodeURIComponent(body); }

  function pageMessage() {
    var meta = document.querySelector('meta[name="rebateaz-text"]');
    if (meta && meta.content) return meta.content;
    var path = window.location.pathname;
    var lp = path.match(/^\/lp\/([a-z0-9-]+)/);
    if (lp && LP_TOPIC[lp[1]]) return "Hi, I'd like to see homes in " + LP_TOPIC[lp[1]] + '. My name is ';
    var city = path.match(/commission-rebate-([a-z-]+)-az/);
    if (city && city[1] !== 'arizona') {
      var name = city[1].split('-').map(function (w) { return w.charAt(0).toUpperCase() + w.slice(1); }).join(' ');
      return "Hi, I'm looking to buy in " + name + '. My name is ';
    }
    return isEs ? 'Hola, busco comprar casa en ___. Me llamo ' : "Hi, I'm looking to buy in ___. My name is ";
  }

  var CSS = '' +
    '.raz-tw{position:fixed;right:18px;bottom:18px;z-index:10000;font-family:inherit}' +
    '.raz-tw-btn{display:flex;align-items:center;justify-content:center;width:58px;height:58px;border-radius:50%;border:0;background:#BF0A30;color:#fff;box-shadow:0 6px 18px rgba(0,0,0,.25);cursor:pointer;text-decoration:none}' +
    '.raz-tw-btn:hover{background:#9e0827}.raz-tw-btn svg{width:28px;height:28px;fill:#fff}' +
    '.raz-tw-panel{position:absolute;right:0;bottom:72px;width:300px;max-width:calc(100vw - 36px);background:#fff;color:#1f2937;border-radius:12px;box-shadow:0 10px 30px rgba(0,0,0,.25);padding:18px 18px 14px;font-size:14px;line-height:1.45}' +
    '.raz-tw-panel[hidden]{display:none}.raz-tw-panel strong{font-size:16px;display:block;margin:0 22px 4px 0}' +
    '.raz-tw-num{font-size:20px;font-weight:700;color:#BF0A30;margin:2px 0 8px}' +
    '.raz-tw-close{position:absolute;top:8px;right:10px;border:0;background:none;font-size:22px;line-height:1;cursor:pointer;color:#6b7280}' +
    '.raz-tw-panel input[type=text],.raz-tw-panel input[type=tel]{width:100%;box-sizing:border-box;padding:9px 10px;margin:6px 0;border:1px solid #d1d5db;border-radius:6px;font-size:15px}' +
    '.raz-tw-panel .lead-consent{display:flex;gap:8px;align-items:flex-start;font-size:11px;color:#6b7280;margin:6px 0 10px}' +
    '.raz-tw-panel .lead-consent input{margin-top:2px;flex:none}' +
    '.raz-tw-panel button[type=submit]{width:100%;padding:10px;border:0;border-radius:8px;background:#BF0A30;color:#fff;font-weight:700;font-size:15px;cursor:pointer}' +
    '.raz-tw-panel .lead-error{color:#b91c1c;font-size:13px;margin-top:8px}.raz-tw-panel .lead-hp{position:absolute;left:-9999px}' +
    '.text-cta{display:flex;flex-wrap:wrap;align-items:center;gap:10px 16px;margin:1.25rem 0;padding:14px 16px;border:1px solid #f3c2cc;border-left:4px solid #BF0A30;border-radius:8px;background:#fff7f8}' +
    '.text-cta p{margin:0;flex:1 1 260px;font-weight:600;color:#1f2937}.text-cta .text-cta-trust{display:block;font-weight:400;font-size:.88rem;color:#6b7280;margin-top:4px}' +
    '.text-cta a.text-cta-btn{display:inline-block;padding:10px 16px;border-radius:8px;background:#BF0A30;color:#fff !important;font-weight:700;text-decoration:none;white-space:nowrap}' +
    '@media print{.raz-tw{display:none}}';

  var ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 3h16a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2H8.5L4 21.5V18a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2zm3 6.5a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3zm5 0a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3zm5 0a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3z"/></svg>';

  var panel = null;

  function buildPanel(root) {
    var es = isEs;
    var consent = es
      ? 'Al marcar esta casilla, acepto recibir llamadas y mensajes de texto de RebateAZ al número proporcionado, incluidos mensajes enviados con tecnología automatizada, sobre mi búsqueda de casa. El consentimiento no es una condición de compra. Pueden aplicarse tarifas de mensajes y datos. La frecuencia de los mensajes varía. Responda STOP para cancelar, HELP para obtener ayuda. Consulte nuestra <a href="/privacy.html">Política de Privacidad</a> y <a href="/terms.html">Términos</a>.'
      : 'By checking this box, I agree to receive calls and text messages from RebateAZ at the number provided, including messages sent using automated technology, about my home search. Consent is not a condition of purchase. Msg &amp; data rates may apply. Msg frequency varies. Reply STOP to opt out, HELP for help. See our <a href="/privacy.html">Privacy Policy</a> and <a href="/terms.html">Terms</a>.';
    panel = document.createElement('div');
    panel.className = 'raz-tw-panel';
    panel.hidden = true;
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-label', es ? 'Envíenos un mensaje' : 'Text us');
    panel.innerHTML =
      '<button type="button" class="raz-tw-close" aria-label="' + (es ? 'Cerrar' : 'Close') + '">&times;</button>' +
      '<strong>' + (es ? 'Envíenos un mensaje de texto' : 'Text us from your phone') + '</strong>' +
      '<div class="raz-tw-num">' + PHONE_FMT + '</div>' +
      '<div>' + (es ? 'O déjenos su nombre y celular y le escribimos nosotros.' : 'Or leave your name and mobile number and we will text you.') + '</div>' +
      '<form class="lead-form" data-form-name="text_widget" data-success="inline" data-lang="' + (es ? 'es' : 'en') + '" novalidate>' +
      '<input type="text" name="first_name" autocomplete="name" aria-label="' + (es ? 'Nombre' : 'Name') + '" placeholder="' + (es ? 'Nombre' : 'Name') + '">' +
      '<input type="tel" name="phone" autocomplete="tel" inputmode="tel" aria-label="' + (es ? 'Celular' : 'Mobile phone') + '" placeholder="' + (es ? 'Celular' : 'Mobile phone') + '" required>' +
      '<input type="hidden" name="message" value="Asked to be texted from the website text button">' +
      '<div class="lead-hp" aria-hidden="true"><input type="text" name="website" tabindex="-1" autocomplete="off"></div>' +
      '<label class="lead-consent"><input type="checkbox" name="consent" value="yes"><span class="lead-consent-text">' + consent + '</span></label>' +
      '<button type="submit">' + (es ? 'Envíenme un texto' : 'Text me') + '</button>' +
      '<div class="lead-error" role="alert" hidden></div>' +
      '</form>' +
      '<div class="lead-success" hidden><strong>' + (es ? '¡Gracias!' : 'Thanks!') + '</strong>' + (es ? 'Le escribiremos pronto desde el ' : 'We will text you shortly from ') + PHONE_FMT + '.</div>';
    root.appendChild(panel);
    panel.querySelector('.raz-tw-close').addEventListener('click', function () { panel.hidden = true; });
    setup(panel.querySelector('form'));
  }

  function openPanel(cta) {
    if (!panel) return;
    panel.hidden = false;
    track('text_widget_open', { cta: cta || 'floating_button' });
    var first = panel.querySelector('input[name="first_name"]');
    if (first) first.focus();
  }

  function liftAboveBars(root) {
    var bars = document.querySelectorAll('.mobile-sticky-cta');
    var lift = 0;
    Array.prototype.forEach.call(bars, function (b) {
      var cs = window.getComputedStyle(b);
      if (cs.position === 'fixed' && cs.display !== 'none') lift = Math.max(lift, b.offsetHeight);
    });
    root.style.bottom = (18 + lift) + 'px';
  }

  function initTextButton() {
    if (document.querySelector('.raz-tw') || /\/thankyou\.html$/.test(window.location.pathname)) return;
    var style = document.createElement('style'); style.textContent = CSS; document.head.appendChild(style);
    var root = document.createElement('div'); root.className = 'raz-tw';
    var label = isEs ? 'Envíenos un mensaje al ' + PHONE_FMT : 'Text us at ' + PHONE_FMT;
    if (isTouch) {
      root.innerHTML = '<a class="raz-tw-btn" data-cta="floating_button" aria-label="' + label + '" href="' + smsHref(pageMessage()) + '">' + ICON + '</a>';
    } else {
      root.innerHTML = '<button type="button" class="raz-tw-btn" aria-label="' + label + '">' + ICON + '</button>';
      root.querySelector('button').addEventListener('click', function () { if (panel && !panel.hidden) panel.hidden = true; else openPanel('floating_button'); });
      buildPanel(root);
    }
    document.body.appendChild(root);
    liftAboveBars(root);
    window.addEventListener('resize', function () { liftAboveBars(root); });

    // In-page "text us" buttons (<a class="text-cta-btn" href="sms:...">): on a computer there is no SMS app,
    // so open the panel instead (registered in the capture phase so the tap is not also counted as click_to_text).
    if (!isTouch) {
      document.addEventListener('click', function (e) {
        var a = e.target.closest && e.target.closest('a.text-cta-btn');
        if (!a) return;
        e.preventDefault();
        openPanel(a.getAttribute('data-cta') || 'in_content');
      }, true);
    }
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

  function init() {
    Array.prototype.forEach.call(document.querySelectorAll('form.lead-form'), setup);
    initTextButton();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
})();
