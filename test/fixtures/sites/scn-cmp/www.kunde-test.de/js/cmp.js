/*
 * Simulated CMP for scenario fixtures. Mode via <script data-mode="…">:
 *   basic        – first layer "Alle ablehnen" + "Alle akzeptieren"; accept loads GTM
 *   zweite-ebene – first layer only "Einstellungen" + "Alle akzeptieren"; second layer with a
 *                  PRE-TICKED "Statistik" toggle + "Auswahl speichern" (saving with Statistik
 *                  ticked loads GTM)
 *   kaputt       – buttons do nothing
 *   wiederkehrend – any click hides the banner, which re-appears 600 ms later
 *   nach-ablehnen – like basic, but "reject" loads a tracker 300 ms after the click
 */
(function () {
  var mode = (document.currentScript && document.currentScript.dataset.mode) || 'basic';
  var KEY = 'kt_consent';
  var GTM = 'https://www.googletagmanager.com/gtag/js?id=G-TEST';

  function load(src) {
    var s = document.createElement('script');
    s.src = src;
    s.async = true;
    document.head.appendChild(s);
  }
  function save(v) {
    try { localStorage.setItem(KEY, v); } catch (e) {}
  }
  function apply(v) {
    if (v === 'all' || v === 'statistik') load(GTM);
  }
  var stored = null;
  try { stored = localStorage.getItem(KEY); } catch (e) {}
  if (stored) { apply(stored); return; }

  function banner(inner) {
    var d = document.createElement('div');
    d.id = 'kt-cookie-banner';
    d.setAttribute('role', 'dialog');
    d.style.cssText = 'position:fixed;bottom:0;left:0;right:0;background:#fff;border-top:2px solid #333;padding:20px;z-index:9999;font:16px sans-serif';
    d.innerHTML = inner;
    document.body.appendChild(d);
    return d;
  }
  var TEXT = '<p>Wir verwenden Cookies und ähnliche Technologien. Mit Ihrer Einwilligung nutzen wir Google Analytics. <a href="/datenschutz.html">Datenschutzerklärung</a></p>';

  function show() {
    if (mode === 'zweite-ebene') {
      var d = banner(TEXT + '<button id="kt-settings">Einstellungen</button> <button id="kt-accept">Alle akzeptieren</button>');
      d.querySelector('#kt-accept').onclick = function () { save('all'); d.remove(); apply('all'); };
      d.querySelector('#kt-settings').onclick = function () {
        d.innerHTML = '<p>Cookie-Einstellungen: Wählen Sie, welchen Zwecken Sie zustimmen.</p>' +
          '<label><input type="checkbox" checked disabled> Notwendig</label> ' +
          '<label><input type="checkbox" id="kt-stat" checked> Statistik</label> ' +
          '<label><input type="checkbox" id="kt-mkt"> Marketing</label> ' +
          '<button id="kt-save">Auswahl speichern</button>';
        d.querySelector('#kt-save').onclick = function () {
          var v = d.querySelector('#kt-stat').checked ? 'statistik' : 'necessary';
          save(v); d.remove(); apply(v);
        };
      };
      return;
    }
    var b = banner(TEXT + '<button id="kt-reject">Alle ablehnen</button> <button id="kt-accept">Alle akzeptieren</button>');
    if (mode === 'kaputt') return;
    if (mode === 'wiederkehrend') {
      var hideShow = function () {
        b.style.display = 'none';
        setTimeout(function () { b.style.display = 'block'; }, 600);
      };
      b.querySelector('#kt-reject').onclick = hideShow;
      b.querySelector('#kt-accept').onclick = hideShow;
      return;
    }
    b.querySelector('#kt-reject').onclick = function () {
      save('necessary');
      b.remove();
      if (mode === 'nach-ablehnen') {
        setTimeout(function () { new Image().src = 'https://unknown-tracker.example/collect.gif?ev=reject'; }, 300);
      }
    };
    b.querySelector('#kt-accept').onclick = function () { save('all'); b.remove(); apply('all'); };
  }
  if (document.body) show(); else document.addEventListener('DOMContentLoaded', show);
})();
