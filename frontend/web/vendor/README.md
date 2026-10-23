# Third-party code bundled with the app (works offline)

| Folder | Package | Version | License | Use |
|---|---|---|---|---|
| `pdfjs/` | [pdfjs-dist](https://github.com/mozilla/pdf.js) (legacy build, `.mjs` renamed `.js`) | 6.4.299 | Apache-2.0 | showing PDFs in the reader |
| `pdf-lib/` | [pdf-lib](https://github.com/Hopding/pdf-lib) (ES module build) | 1.17.1 | MIT | saving handwriting into PDFs |

To update, replace the files from the new npm package (`npm pack pdfjs-dist@<version>`) and bump the version here.
