/* Page-level behaviour that has to survive a pjax navigation: the search box
   and the giscus comment widget. Both are driven off data attributes in the
   markup rather than inline scripts, because pjax swaps #pjax-container
   wholesale and inline scripts in the new content are not reliably re-run. */

(function () {
  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  // A snippet centred on the first hit, so a result shows why it matched
  // rather than just repeating the opening sentence.
  function snippet(body, q) {
    var i = body.toLowerCase().indexOf(q);
    if (i < 0) return body.slice(0, 160);
    var start = Math.max(0, i - 60);
    return (start > 0 ? '...' : '') + body.slice(start, start + 180) + '...';
  }

  var index = null;

  function initSearch() {
    var input = document.getElementById('search-input');
    if (!input || input.dataset.ready) return;
    input.dataset.ready = '1';

    var status = document.getElementById('search-status');
    var list = document.getElementById('search-results');

    function run() {
      var q = input.value.trim().toLowerCase();
      list.innerHTML = '';
      if (!q) { status.textContent = 'Type to search.'; return; }
      if (!index) { status.textContent = 'Loading...'; return; }

      var hits = index.filter(function (e) {
        return (e.title + ' ' + e.description + ' ' + e.tags.join(' ') + ' ' + e.body)
          .toLowerCase().indexOf(q) >= 0;
      });

      status.textContent = hits.length
        ? hits.length + ' result' + (hits.length === 1 ? '' : 's')
        : 'Nothing found.';

      hits.slice(0, 30).forEach(function (e) {
        var li = document.createElement('li');
        li.className = 'search-result';
        li.innerHTML = '<a class="archive-title" href="' + e.url + '">' + escapeHtml(e.title) + '</a>' +
          ' <span class="badge">' + escapeHtml(e.section) + '</span>' +
          '<p class="search-snippet">' + escapeHtml(snippet(e.description || e.body, q)) + '</p>';
        list.appendChild(li);
      });
    }

    input.addEventListener('input', run);

    if (index) { run(); return; }
    fetch(input.dataset.index)
      .then(function (r) { return r.json(); })
      .then(function (d) { index = d; run(); })
      .catch(function () { status.textContent = 'The search index could not be loaded.'; });
  }

  function initComments() {
    var box = document.getElementById('comments-body');
    if (!box || box.dataset.ready) return;
    box.dataset.ready = '1';

    var s = document.createElement('script');
    s.src = 'https://giscus.app/client.js';
    s.crossOrigin = 'anonymous';
    s.async = true;
    Object.keys(box.dataset).forEach(function (k) {
      if (k.indexOf('giscus') === 0) {
        var name = k.slice(6).replace(/[A-Z]/g, function (c) { return '-' + c.toLowerCase(); });
        s.setAttribute('data' + name, box.dataset[k]);
      }
    });
    box.appendChild(s);
  }

  /* Click an image in a post to see it full size.

     The diagrams in the dev logs are wide and dense, readable at column width
     only if you already know what they say, so they open in an overlay at
     whatever size the viewport allows.

     The listener is delegated from the document and registered once, so pjax
     swapping the article out from under us changes nothing. The overlay is a
     native <dialog>: showModal() gives focus trapping, the Escape key and the
     ::backdrop for free, with no library and no focus bookkeeping of our own. */
  var dialog = null;
  var dialogImage = null;

  function buildLightbox() {
    if (dialog) return;

    dialog = document.createElement('dialog');
    dialog.className = 'lightbox';
    dialog.setAttribute('aria-label', 'Enlarged image');

    dialogImage = document.createElement('img');
    dialog.appendChild(dialogImage);
    document.body.appendChild(dialog);

    // A click anywhere closes, including on the backdrop: the dialog element
    // covers the whole viewport, so a backdrop click lands on the dialog
    // itself.
    dialog.addEventListener('click', function () { dialog.close(); });

    // Let the image go when the overlay closes, so a big file is not held in
    // memory for the rest of the visit.
    dialog.addEventListener('close', function () { dialogImage.removeAttribute('src'); });
  }

  document.addEventListener('click', function (event) {
    var trigger = event.target.closest && event.target.closest('.img-zoom');
    if (!trigger) return;

    var source = trigger.querySelector('img');
    if (!source) return;

    buildLightbox();

    // Fall back to the plain full-size URL when the browser has not picked a
    // candidate yet (currentSrc is empty until the image has started loading).
    dialogImage.src = source.currentSrc || source.src;
    dialogImage.alt = source.alt || '';

    if (typeof dialog.showModal === 'function') dialog.showModal();
  });

  function init() {
    initSearch();
    initComments();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
  document.addEventListener('pjax:success', init);
})();
