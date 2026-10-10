(function () {
  var u = document.getElementById('url');
  if (/^https?:$/.test(location.protocol) && !/^(127\.|localhost)/.test(location.hostname)) u.textContent = location.origin;
  document.getElementById('btnPrint').addEventListener('click', function () { window.print(); });
})();
