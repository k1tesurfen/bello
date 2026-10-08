(function () {
  var c = document.createElement('canvas');
  c.width = 200; c.height = 50;
  var ctx = c.getContext('2d');
  ctx.font = '14px Arial';
  ctx.fillText('Cwm fjordbank glyphs vext quiz', 2, 20);
  ['Arial','Verdana','Georgia','Courier New','Impact','Tahoma','Trebuchet MS','Comic Sans MS','Palatino'].forEach(function (f) {
    ctx.font = '14px ' + f; ctx.measureText('mmmmmmmmmmlli');
  });
  window.__fp = [c.toDataURL(), navigator.hardwareConcurrency, navigator.plugins.length];
})();
