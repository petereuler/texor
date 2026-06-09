import { ChevronLeft, ChevronRight, LoaderCircle } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import * as pdfjsLib from 'pdfjs-dist';
import pdfWorker from 'pdfjs-dist/build/pdf.worker.min?url';
import { compilePaper } from '../api';

pdfjsLib.GlobalWorkerOptions.workerSrc = pdfWorker;

const previewPdfCache = new Map<string, string | null>();

interface PdfThumbnailPreviewProps {
  paperId: string;
  versionId: string;
  title: string;
}

export function PdfThumbnailPreview({ paperId, versionId, title }: PdfThumbnailPreviewProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const documentRef = useRef<any>(null);
  const [isVisible, setIsVisible] = useState(false);
  const [containerWidth, setContainerWidth] = useState(0);
  const [pdfUrl, setPdfUrl] = useState<string | null>(null);
  const [pageCount, setPageCount] = useState(0);
  const [pageNumber, setPageNumber] = useState(1);
  const [isPreparing, setIsPreparing] = useState(false);
  const [renderError, setRenderError] = useState('');

  useEffect(() => {
    const node = hostRef.current;
    if (!node) {
      return undefined;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          setIsVisible(true);
          observer.disconnect();
        }
      },
      { rootMargin: '160px' },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const node = hostRef.current;
    if (!node) {
      return undefined;
    }
    const currentNode = node;

    function syncWidth() {
      setContainerWidth(Math.max(120, currentNode.clientWidth - 2));
    }

    syncWidth();
    const observer = new ResizeObserver(syncWidth);
    observer.observe(currentNode);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!isVisible) {
      return undefined;
    }

    const cacheKey = `${paperId}:${versionId}`;
    if (previewPdfCache.has(cacheKey)) {
      const cached = previewPdfCache.get(cacheKey) || null;
      setPdfUrl(cached);
      setRenderError(cached ? '' : 'PDF preview unavailable');
      return undefined;
    }

    let cancelled = false;
    setIsPreparing(true);
    setRenderError('');

    void compilePaper(paperId, versionId)
      .then((result) => {
        if (cancelled) {
          return;
        }
        if (result.ok && result.pdfUrl) {
          previewPdfCache.set(cacheKey, result.pdfUrl);
          setPdfUrl(result.pdfUrl);
          return;
        }
        previewPdfCache.set(cacheKey, null);
        setPdfUrl(null);
        setRenderError('PDF preview unavailable');
      })
      .catch(() => {
        if (cancelled) {
          return;
        }
        previewPdfCache.set(cacheKey, null);
        setPdfUrl(null);
        setRenderError('PDF preview unavailable');
      })
      .finally(() => {
        if (!cancelled) {
          setIsPreparing(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [isVisible, paperId, versionId]);

  useEffect(() => {
    if (!pdfUrl || !isVisible) {
      documentRef.current = null;
      setPageCount(0);
      setPageNumber(1);
      return undefined;
    }

    let cancelled = false;
    const loadingTask = pdfjsLib.getDocument(pdfUrl);

    void loadingTask.promise
      .then((pdfDocument) => {
        if (cancelled) {
          void pdfDocument.destroy();
          return;
        }
        documentRef.current = pdfDocument;
        setPageCount(pdfDocument.numPages);
        setPageNumber((current) => Math.min(Math.max(current, 1), pdfDocument.numPages || 1));
      })
      .catch(() => {
        if (!cancelled) {
          documentRef.current = null;
          setRenderError('PDF preview unavailable');
        }
      });

    return () => {
      cancelled = true;
      documentRef.current = null;
      void loadingTask.destroy();
    };
  }, [isVisible, pdfUrl]);

  useEffect(() => {
    const pdfDocument = documentRef.current;
    const canvas = canvasRef.current;
    if (!pdfDocument || !canvas || !containerWidth) {
      return undefined;
    }

    let cancelled = false;
    let activeTask: any = null;

    void pdfDocument
      .getPage(pageNumber)
      .then((page: any) => {
        if (cancelled) {
          return;
        }
        const baseViewport = page.getViewport({ scale: 1 });
        const scale = Math.min(1.4, containerWidth / baseViewport.width);
        const viewport = page.getViewport({ scale });
        const outputScale = Math.min(window.devicePixelRatio || 1, 2);
        canvas.width = Math.floor(viewport.width * outputScale);
        canvas.height = Math.floor(viewport.height * outputScale);
        canvas.style.width = `${viewport.width}px`;
        canvas.style.height = `${viewport.height}px`;
        const context = canvas.getContext('2d');
        if (!context) {
          return;
        }
        context.clearRect(0, 0, canvas.width, canvas.height);
        activeTask = page.render({
          canvasContext: context,
          viewport,
          transform: outputScale !== 1 ? [outputScale, 0, 0, outputScale, 0, 0] : undefined,
        });
        return activeTask.promise;
      })
      .catch(() => {
        if (!cancelled) {
          setRenderError('PDF preview unavailable');
        }
      });

    return () => {
      cancelled = true;
      activeTask?.cancel();
    };
  }, [containerWidth, pageNumber, pdfUrl, pageCount]);

  const showPager = pageCount > 1;

  return (
    <div ref={hostRef} className="hub-preview-pdf">
      <div className="hub-preview-card__sheet hub-preview-pdf__sheet">
        {pdfUrl ? <canvas ref={canvasRef} className="hub-preview-pdf__canvas" aria-label={`${title} PDF preview`} /> : null}

        {!pdfUrl ? (
          <div className="hub-preview-pdf__fallback">
            <strong>{title}</strong>
            <div className="hub-preview-pdf__fallback-columns" aria-hidden="true">
              <div>
                <i />
                <i />
                <i />
                <i className="is-short" />
                <i />
                <i />
                <i />
              </div>
              <div>
                <i />
                <i />
                <i />
                <i />
                <i className="is-short" />
                <i />
                <i />
              </div>
            </div>
          </div>
        ) : null}

        {isPreparing ? (
          <div className="hub-preview-pdf__status" aria-label="正在准备 PDF 预览">
            <LoaderCircle className="spin" size={16} />
          </div>
        ) : null}

        {showPager ? (
          <div className="hub-preview-pdf__pager">
            <button
              type="button"
              className="hub-preview-pdf__pager-button"
              onClick={(event) => {
                event.preventDefault();
                event.stopPropagation();
                setPageNumber((current) => (current > 1 ? current - 1 : current));
              }}
              disabled={pageNumber <= 1}
              aria-label="上一页"
            >
              <ChevronLeft size={18} />
            </button>
            <span>{pageNumber} / {pageCount}</span>
            <button
              type="button"
              className="hub-preview-pdf__pager-button"
              onClick={(event) => {
                event.preventDefault();
                event.stopPropagation();
                setPageNumber((current) => (current < pageCount ? current + 1 : current));
              }}
              disabled={pageNumber >= pageCount}
              aria-label="下一页"
            >
              <ChevronRight size={18} />
            </button>
          </div>
        ) : null}

        {renderError && !pdfUrl ? <div className="hub-preview-pdf__hint">Preview</div> : null}
      </div>
    </div>
  );
}
