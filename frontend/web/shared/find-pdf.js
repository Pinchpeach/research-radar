// The PDF link on a publisher's page, as an expression the sign-in windows evaluate in the page
// (LibraryWebActivity.java on Android, desktop/main.py on the PC): Google Scholar's
// citation_pdf_url tag, else a PDF shown in a frame (IEEE's stamp page), else the page itself when
// it is a PDF. Null when there's none. Mirrors pdfLink in core/library.js and backend/library.py.
(function () {
  if (document.contentType === "application/pdf") return location.href;
  var meta = document.querySelector('meta[name="citation_pdf_url" i]');
  if (meta && meta.content) { try { return new URL(meta.content, location.href).href; } catch (e) { /* not an address */ } }
  var frames = document.querySelectorAll("iframe[src],embed[src]");
  for (var i = 0; i < frames.length; i++) if (/pdf/i.test(frames[i].getAttribute("src"))) return frames[i].src;
  return null;
})()
