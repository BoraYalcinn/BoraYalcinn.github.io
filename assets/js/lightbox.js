/*
  Click an image in a post to see it full size.

  The diagrams in the dev logs are wide and dense — readable at column width only
  if you already know what they say — so they open in an overlay at whatever size
  the viewport allows.

  Everything is delegated from one listener on the document: posts render their
  images through layouts/_markup/render-image.html, which wraps each one in a
  <button class="img-zoom">, so there is nothing to re-bind when Hugo's live
  reload swaps the content out from under us.

  The overlay is a native <dialog>: showModal() gives focus trapping, the Escape
  key and the ::backdrop for free, with no library and no focus bookkeeping of
  our own.
*/
(function () {
  "use strict";

  var dialog = null;
  var image = null;

  function build() {
    if (dialog) return;

    dialog = document.createElement("dialog");
    dialog.className = "lightbox";
    dialog.setAttribute("aria-label", "Enlarged image");

    image = document.createElement("img");
    dialog.appendChild(image);
    document.body.appendChild(dialog);

    // A click anywhere closes, including on the backdrop: the dialog element
    // covers the whole viewport, so a backdrop click lands on the dialog itself.
    dialog.addEventListener("click", function () {
      dialog.close();
    });

    // Let the image go when the overlay closes, so a big file is not held in
    // memory for the rest of the visit.
    dialog.addEventListener("close", function () {
      image.removeAttribute("src");
    });
  }

  document.addEventListener("click", function (event) {
    var trigger = event.target.closest(".img-zoom");
    if (!trigger) return;

    var source = trigger.querySelector("img");
    if (!source) return;

    build();

    // Fall back to the plain full-size URL when the browser has not picked a
    // candidate yet (currentSrc is empty until the image has started loading).
    image.src = source.currentSrc || source.src;
    image.alt = source.alt || "";

    if (typeof dialog.showModal === "function") {
      dialog.showModal();
    }
  });
})();
