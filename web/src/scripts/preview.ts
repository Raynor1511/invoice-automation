// Shows the document next to its reading: PDFs drawn page by page with pdf.js (phones can't show
// a PDF inside a page), images as they are.
import * as pdfjs from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

/** stillWanted() turns false when the visitor has moved on to another document; drawing then stops. */
export async function showDocument(target: HTMLElement, bytes: ArrayBuffer, mediaType: string, label: string, stillWanted: () => boolean = () => true): Promise<number> {
  target.replaceChildren();
  if (mediaType !== 'application/pdf') {
    const img = document.createElement('img');
    img.src = URL.createObjectURL(new Blob([bytes], { type: mediaType }));
    img.alt = label;
    img.className = 'page';
    target.append(img);
    return 1;
  }
  const pdf = await pdfjs.getDocument({ data: new Uint8Array(bytes.slice(0)), standardFontDataUrl: '/pdfjs/standard_fonts/' }).promise;
  const width = Math.max(320, target.clientWidth || 600);
  for (let n = 1; n <= pdf.numPages && stillWanted(); n++) {
    const page = await pdf.getPage(n);
    const base = page.getViewport({ scale: 1 });
    const ratio = Math.min(window.devicePixelRatio || 1, 2);
    const viewport = page.getViewport({ scale: (width / base.width) * ratio });
    const canvas = document.createElement('canvas');
    canvas.width = Math.floor(viewport.width);
    canvas.height = Math.floor(viewport.height);
    canvas.className = 'page';
    canvas.setAttribute('role', 'img');
    canvas.setAttribute('aria-label', `${label}, page ${n} of ${pdf.numPages}`);
    if (!stillWanted()) break;
    target.append(canvas);
    await page.render({ canvas, viewport }).promise;
  }
  return pdf.numPages;
}
