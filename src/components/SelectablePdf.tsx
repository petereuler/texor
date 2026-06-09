import { useEffect, useRef, useState } from 'react';
import * as pdfjsLib from 'pdfjs-dist';
import pdfWorker from 'pdfjs-dist/build/pdf.worker.min?url';

pdfjsLib.GlobalWorkerOptions.workerSrc = pdfWorker;

export interface PdfRegionSelection {
  page: number;
  x: number;
  y: number;
  width: number;
  height: number;
  selectedText?: string;
  anchor: { x: number; y: number };
}

export interface PdfJumpTarget {
  page: number;
  x: number;
  y: number;
  width?: number;
  height?: number;
  selectedText?: string;
}

interface SelectablePdfProps {
  pdfUrl: string;
  title: string;
  selectable?: boolean;
  clearSelectionSignal?: number;
  jumpTarget?: PdfJumpTarget | null;
  onSelectRegion?: (selection: PdfRegionSelection) => void;
  onClearSelection?: () => void;
  onCtrlClickRegion?: (selection: PdfRegionSelection) => void;
}

interface PageView {
  page: number;
  width: number;
  height: number;
  scale: number;
  baseScale: number;
  pageElement: HTMLDivElement;
  canvas: HTMLCanvasElement;
  textLayer: HTMLDivElement;
  textRuns: PdfTextRun[];
}

interface SelectionHit {
  view: PageView;
  left: number;
  top: number;
  right: number;
  bottom: number;
  area: number;
}

interface VisualSelectionRect {
  id: string;
  left: number;
  top: number;
  width: number;
  height: number;
  kind?: 'text' | 'region' | 'jump-text';
}

interface TextSelectionRect {
  rect: DOMRect;
  text: string;
  span: HTMLSpanElement;
}

interface SelectionRangeSegment {
  page: number;
  left: number;
  top: number;
  right: number;
  bottom: number;
  text: string;
}

interface PdfTextRun {
  text: string;
  normalized: string;
  left: number;
  top: number;
  width: number;
  height: number;
}

interface DraftRegion {
  page: number;
  startX: number;
  startY: number;
  x: number;
  y: number;
  width: number;
  height: number;
}

interface IndexedTextRun {
  run: PdfTextRun;
  start: number;
  end: number;
}

interface SnappedJumpRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

interface ViewportAnchor {
  x: number;
  y: number;
}

interface PdfTextItemLike {
  str: string;
  transform: number[];
  width: number;
  height: number;
}

function isToolbarTarget(node: EventTarget | null): boolean {
  return node instanceof HTMLElement && node.closest('[data-pdf-toolbar="true"]') !== null;
}

function isScrollbarInteraction(root: HTMLDivElement | null, event: React.PointerEvent<HTMLDivElement>): boolean {
  if (!root) {
    return false;
  }
  const target = event.target;
  if (target instanceof HTMLElement && target.closest('.pdf-status-bar, .pdf-scroll-area')) {
    const scrollArea = target.closest('.pdf-scroll-area');
    if (!scrollArea) {
      return true;
    }
  }
  const style = window.getComputedStyle(root);
  const scrollbarWidth = root.offsetWidth - root.clientWidth;
  const scrollbarHeight = root.offsetHeight - root.clientHeight;
  const paddingRight = Number.parseFloat(style.paddingRight) || 0;
  const paddingBottom = Number.parseFloat(style.paddingBottom) || 0;
  const withinVerticalScrollbar =
    scrollbarWidth > 0 && event.clientX >= root.getBoundingClientRect().right - scrollbarWidth - paddingRight;
  const withinHorizontalScrollbar =
    scrollbarHeight > 0 && event.clientY >= root.getBoundingClientRect().bottom - scrollbarHeight - paddingBottom;
  return withinVerticalScrollbar || withinHorizontalScrollbar;
}

function isTextSpan(node: Node | null): node is HTMLSpanElement {
  return node instanceof HTMLSpanElement && node.closest('.textLayer') !== null;
}

function rangeText(source: Range): string {
  return source.toString().replace(/\s+/g, ' ').trim();
}

function normalizeMatchText(source: string): string {
  return source.normalize('NFKC').replace(/\s+/g, ' ').trim();
}

function isPdfTextItem(item: unknown): item is PdfTextItemLike {
  if (!item || typeof item !== 'object') {
    return false;
  }
  const candidate = item as Partial<PdfTextItemLike>;
  return typeof candidate.str === 'string' && Array.isArray(candidate.transform);
}

const MIN_ZOOM_PERCENT = 55;
const MAX_ZOOM_PERCENT = 220;
const DEFAULT_ZOOM_PERCENT = 100;
const PDF_PAGE_GAP = 14;
const ZOOM_COMMIT_DELAY_MS = 120;
const ZOOM_PANEL_ACTIVE_MS = 900;
const CONTAINER_WIDTH_COMMIT_DELAY_MS = 110;

function clampZoomPercent(value: number): number {
  return Math.max(MIN_ZOOM_PERCENT, Math.min(MAX_ZOOM_PERCENT, Math.round(value)));
}

function normalizeJumpWord(source?: string): string {
  return (source || '')
    .normalize('NFKC')
    .replace(/^[^A-Za-z0-9\u00C0-\u024F\u0370-\u1FFF\u2C00-\uD7FF\u4E00-\u9FFF%+./:-]+/gu, '')
    .replace(/[^A-Za-z0-9\u00C0-\u024F\u0370-\u1FFF\u2C00-\uD7FF\u4E00-\u9FFF%+./:-]+$/gu, '')
    .trim()
    .toLowerCase();
}

export function SelectablePdf({
  pdfUrl,
  title,
  selectable,
  clearSelectionSignal,
  jumpTarget,
  onSelectRegion,
  onClearSelection,
  onCtrlClickRegion,
}: SelectablePdfProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const scrollAreaRef = useRef<HTMLDivElement>(null);
  const pagesViewportRef = useRef<HTMLDivElement>(null);
  const pagesRef = useRef<HTMLDivElement>(null);
  const measureCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const selectionSyncFrameRef = useRef<number | null>(null);
  const zoomCommitTimerRef = useRef<number | null>(null);
  const zoomPanelTimerRef = useRef<number | null>(null);
  const resizeCommitTimerRef = useRef<number | null>(null);
  const suppressSelectionSyncUntilRef = useRef(0);
  const pendingZoomRef = useRef(DEFAULT_ZOOM_PERCENT);
  const measuredContainerWidthRef = useRef(0);
  const pendingViewportAnchorRef = useRef<ViewportAnchor | null>(null);
  const pageViewsRef = useRef<PageView[]>([]);
  const pageCountRef = useRef(0);
  const [visualSelectionRects, setVisualSelectionRects] = useState<VisualSelectionRect[]>([]);
  const [draftRegion, setDraftRegion] = useState<DraftRegion | null>(null);
  const [renderError, setRenderError] = useState('');
  const [displayZoomPercent, setDisplayZoomPercent] = useState(DEFAULT_ZOOM_PERCENT);
  const [renderZoomPercent, setRenderZoomPercent] = useState(DEFAULT_ZOOM_PERCENT);
  const [paintedZoomPercent, setPaintedZoomPercent] = useState(DEFAULT_ZOOM_PERCENT);
  const [zoomPanelActive, setZoomPanelActive] = useState(false);
  const [containerWidth, setContainerWidth] = useState(0);
  const [contentMetrics, setContentMetrics] = useState({ width: 0, height: 0 });
  const [pageStatus, setPageStatus] = useState({ start: 1, end: 1, total: 1 });
  const previewScale = displayZoomPercent / paintedZoomPercent;

  function clampScroll(value: number, maximum: number) {
    return Math.max(0, Math.min(maximum, value));
  }

  function viewportOffsetsInScrollSpace(root: HTMLDivElement, viewport: HTMLDivElement) {
    const rootRect = root.getBoundingClientRect();
    const viewportRect = viewport.getBoundingClientRect();
    return {
      left: viewportRect.left - rootRect.left + root.scrollLeft,
      top: viewportRect.top - rootRect.top + root.scrollTop,
    };
  }

  function captureViewportAnchor(): ViewportAnchor | null {
    const root = scrollAreaRef.current;
    const viewport = pagesViewportRef.current;
    if (!root || !viewport || !contentMetrics.width || !contentMetrics.height) {
      return null;
    }
    const offsets = viewportOffsetsInScrollSpace(root, viewport);
    return {
      x: clampScroll((root.scrollLeft + root.clientWidth / 2 - offsets.left) / previewScale, contentMetrics.width),
      y: clampScroll((root.scrollTop + root.clientHeight / 2 - offsets.top) / previewScale, contentMetrics.height),
    };
  }

  function restoreViewportAnchor(anchor = pendingViewportAnchorRef.current) {
    const root = scrollAreaRef.current;
    const viewport = pagesViewportRef.current;
    if (!root || !viewport || !anchor) {
      return;
    }
    const offsets = viewportOffsetsInScrollSpace(root, viewport);
    const maxScrollLeft = Math.max(0, root.scrollWidth - root.clientWidth);
    const maxScrollTop = Math.max(0, root.scrollHeight - root.clientHeight);
    root.scrollTo({
      left: clampScroll(offsets.left + anchor.x * previewScale - root.clientWidth / 2, maxScrollLeft),
      top: clampScroll(offsets.top + anchor.y * previewScale - root.clientHeight / 2, maxScrollTop),
    });
    pendingViewportAnchorRef.current = null;
  }

  function syncVisiblePage() {
    const element = scrollAreaRef.current;
    if (!element) {
      return;
    }

    const rootRect = element.getBoundingClientRect();
    let bestPage = 1;
    let bestVisibleHeight = -1;
    let firstVisiblePage: number | null = null;
    let lastVisiblePage: number | null = null;

    for (const view of pageViewsRef.current) {
      const rect = view.pageElement.getBoundingClientRect();
      const visibleTop = Math.max(rect.top, rootRect.top);
      const visibleBottom = Math.min(rect.bottom, rootRect.bottom);
      const visibleHeight = Math.max(0, visibleBottom - visibleTop);
      if (visibleHeight > 0) {
        if (firstVisiblePage === null) {
          firstVisiblePage = view.page;
        }
        lastVisiblePage = view.page;
      }
      if (visibleHeight > bestVisibleHeight) {
        bestVisibleHeight = visibleHeight;
        bestPage = view.page;
      }
    }

    setPageStatus((current) => {
      const total = pageCountRef.current || current.total || 1;
      const start = firstVisiblePage ?? bestPage;
      const end = lastVisiblePage ?? bestPage;
      if (current.start === start && current.end === end && current.total === total) {
        return current;
      }
      return { start, end, total };
    });
  }

  function flashZoomPanel() {
    setZoomPanelActive(true);
    if (zoomPanelTimerRef.current !== null) {
      window.clearTimeout(zoomPanelTimerRef.current);
    }
    zoomPanelTimerRef.current = window.setTimeout(() => {
      setZoomPanelActive(false);
      zoomPanelTimerRef.current = null;
    }, ZOOM_PANEL_ACTIVE_MS);
  }

  function scheduleZoomCommit(nextZoom: number) {
    pendingZoomRef.current = nextZoom;
    if (zoomCommitTimerRef.current !== null) {
      window.clearTimeout(zoomCommitTimerRef.current);
    }
    zoomCommitTimerRef.current = window.setTimeout(() => {
      zoomCommitTimerRef.current = null;
      pendingViewportAnchorRef.current = captureViewportAnchor();
      setRenderZoomPercent((current) => (current === pendingZoomRef.current ? current : pendingZoomRef.current));
    }, ZOOM_COMMIT_DELAY_MS);
  }

  function pageStatusLabel() {
    if (pageStatus.start === pageStatus.end) {
      return `${pageStatus.start}页，共${pageStatus.total}页`;
    }
    return `${pageStatus.start}-${pageStatus.end}页，共${pageStatus.total}页`;
  }

  useEffect(() => {
    const node = scrollAreaRef.current;
    if (!node) {
      return undefined;
    }
    const currentNode = node;

    function commitWidth(nextWidth: number) {
      pendingViewportAnchorRef.current = captureViewportAnchor();
      setContainerWidth((current) => (current === nextWidth ? current : nextWidth));
    }

    function syncWidth(immediate = false) {
      const nextWidth = Math.max(320, currentNode.clientWidth - 18);
      if (!measuredContainerWidthRef.current) {
        measuredContainerWidthRef.current = nextWidth;
        setContainerWidth(nextWidth);
        return;
      }
      if (Math.abs(nextWidth - measuredContainerWidthRef.current) < 2) {
        return;
      }
      measuredContainerWidthRef.current = nextWidth;
      if (immediate) {
        commitWidth(nextWidth);
        return;
      }
      if (resizeCommitTimerRef.current !== null) {
        window.clearTimeout(resizeCommitTimerRef.current);
      }
      resizeCommitTimerRef.current = window.setTimeout(() => {
        resizeCommitTimerRef.current = null;
        commitWidth(measuredContainerWidthRef.current);
      }, CONTAINER_WIDTH_COMMIT_DELAY_MS);
    }

    syncWidth(true);
    const observer = new ResizeObserver(() => syncWidth());
    observer.observe(currentNode);
    return () => {
      observer.disconnect();
      if (resizeCommitTimerRef.current !== null) {
        window.clearTimeout(resizeCommitTimerRef.current);
        resizeCommitTimerRef.current = null;
      }
    };
  }, [contentMetrics.height, contentMetrics.width, previewScale]);

  useEffect(() => {
    let cancelled = false;
    const pageHost = pagesRef.current;
    if (!pageHost || !containerWidth) {
      return undefined;
    }

    setVisualSelectionRects([]);

    async function renderPdf(host: HTMLDivElement) {
      try {
        setRenderError('');
        const pdfDocument = await pdfjsLib.getDocument(pdfUrl).promise;
        if (cancelled) {
          return;
        }
        pageCountRef.current = pdfDocument.numPages;
        setPageStatus({ start: 1, end: 1, total: pdfDocument.numPages || 1 });
        const nextViews: PageView[] = [];
        const fragment = document.createDocumentFragment();
        let maxWidth = 0;
        let totalHeight = 0;
        for (let pageNumber = 1; pageNumber <= pdfDocument.numPages; pageNumber += 1) {
          const page = await pdfDocument.getPage(pageNumber);
          if (cancelled) {
            return;
          }
          const baseViewport = page.getViewport({ scale: 1 });
          const baseScale = Math.min(1.65, containerWidth / baseViewport.width);
          const scale = baseScale * (renderZoomPercent / 100);
          const viewport = page.getViewport({ scale });
          const outputScale = Math.min(window.devicePixelRatio || 1, 2.5);
          const pageElement = window.document.createElement('div');
          const canvas = window.document.createElement('canvas');
          const textLayer = window.document.createElement('div');

          pageElement.className = 'pdf-page';
          pageElement.dataset.page = String(pageNumber);
          pageElement.style.width = `${viewport.width}px`;
          pageElement.style.height = `${viewport.height}px`;

          canvas.className = 'pdf-canvas';
          canvas.dataset.page = String(pageNumber);
          canvas.width = Math.floor(viewport.width * outputScale);
          canvas.height = Math.floor(viewport.height * outputScale);
          canvas.style.width = `${viewport.width}px`;
          canvas.style.height = `${viewport.height}px`;

          textLayer.className = 'textLayer';
          textLayer.style.width = `${viewport.width}px`;
          textLayer.style.height = `${viewport.height}px`;

          pageElement.appendChild(canvas);
          if (selectable) {
            pageElement.appendChild(textLayer);
          }
          fragment.appendChild(pageElement);
          nextViews.push({
            page: pageNumber,
            width: viewport.width,
            height: viewport.height,
            scale,
            baseScale,
            pageElement,
            canvas,
            textLayer,
            textRuns: [],
          });
          maxWidth = Math.max(maxWidth, viewport.width);
          totalHeight += viewport.height + (pageNumber > 1 ? PDF_PAGE_GAP : 0);
          const canvasContext = canvas.getContext('2d') as CanvasRenderingContext2D;
          await page.render({
            canvasContext,
            viewport,
            transform: outputScale !== 1 ? [outputScale, 0, 0, outputScale, 0, 0] : undefined,
          }).promise;
          if (selectable && !cancelled) {
            const textContent = await page.getTextContent();
            const currentView = nextViews.find((view) => view.page === pageNumber);
            if (currentView) {
              const textItems = textContent.items.flatMap((item): PdfTextItemLike[] => (isPdfTextItem(item) ? [item] : []));
              currentView.textRuns = textItems.map((item) => {
                const [, , , fontHeight, itemX, itemY] = item.transform;
                const height = Math.max(2, Math.abs(fontHeight || item.height || 1) * scale);
                return {
                  text: item.str,
                  normalized: normalizeMatchText(item.str),
                  left: itemX * scale,
                  top: viewport.height - itemY * scale - height,
                  width: Math.max(1, (item.width || 0) * scale),
                  height,
                };
              });
            }
            await pdfjsLib.renderTextLayer({
              textContentSource: textContent,
              container: textLayer,
              viewport,
              textDivs: [],
            }).promise;
          }
        }
        if (cancelled) {
          return;
        }
        host.replaceChildren(fragment);
        pageViewsRef.current = nextViews;
        setContentMetrics({ width: maxWidth, height: totalHeight });
        setPaintedZoomPercent(renderZoomPercent);
        window.requestAnimationFrame(() => {
          restoreViewportAnchor();
          syncVisiblePage();
        });
      } catch (error) {
        if (!cancelled) {
          setRenderError(error instanceof Error ? error.message : 'PDF render failed.');
        }
      }
    }

    void renderPdf(pageHost);
    return () => {
      cancelled = true;
    };
  }, [containerWidth, pdfUrl, renderZoomPercent, selectable]);

  useEffect(() => {
    setVisualSelectionRects([]);
  }, [clearSelectionSignal]);

  useEffect(() => {
    pendingViewportAnchorRef.current = null;
  }, [pdfUrl]);

  useEffect(() => {
    if (!jumpTarget) {
      return;
    }
    const root = scrollAreaRef.current;
    const view = pageViewsRef.current.find((entry) => entry.page === jumpTarget.page);
    if (!root || !view) {
      return;
    }
    const snappedRect = snappedJumpRectForTarget(view, jumpTarget);
    const targetLeft = view.pageElement.offsetLeft + snappedRect.left;
    const targetTop = view.pageElement.offsetTop + snappedRect.top;
    const targetWidth = snappedRect.width;
    const targetHeight = snappedRect.height;
    const nextScrollLeft = Math.max(0, (targetLeft + targetWidth / 2) * previewScale - root.clientWidth / 2);
    const nextScrollTop = Math.max(0, (targetTop + targetHeight / 2) * previewScale - root.clientHeight / 2);
    root.scrollTo({
      left: nextScrollLeft,
      top: nextScrollTop,
      behavior: 'smooth',
    });
    const preciseRects = jumpHighlightRectsForTarget(jumpTarget);
    setVisualSelectionRects(
      preciseRects.length
        ? preciseRects
        : [
            {
              id: `jump-${jumpTarget.page}-${jumpTarget.x}-${jumpTarget.y}`,
              left: targetLeft,
              top: targetTop,
              width: Math.max(24, targetWidth),
              height: Math.max(10, targetHeight),
              kind: 'region',
            },
          ],
    );
  }, [containerWidth, jumpTarget, previewScale]);

  useEffect(() => {
    const rootElement = rootRef.current;
    if (!rootElement) {
      return undefined;
    }
    const element = rootElement;

    function handleWheel(event: WheelEvent) {
      if (!event.ctrlKey) {
        return;
      }
      if (!element.contains(event.target as Node)) {
        return;
      }
      if (isToolbarTarget(event.target)) {
        return;
      }
      event.preventDefault();
      const delta = event.deltaY > 0 ? -8 : 8;
      setDisplayZoomPercent((current) => {
        const next = clampZoomPercent(current + delta);
        scheduleZoomCommit(next);
        flashZoomPanel();
        return next;
      });
    }

    element.addEventListener('wheel', handleWheel, { passive: false });
    return () => element.removeEventListener('wheel', handleWheel);
  }, []);

  useEffect(() => {
    return () => {
      if (selectionSyncFrameRef.current !== null) {
        window.cancelAnimationFrame(selectionSyncFrameRef.current);
        selectionSyncFrameRef.current = null;
      }
      if (zoomCommitTimerRef.current !== null) {
        window.clearTimeout(zoomCommitTimerRef.current);
        zoomCommitTimerRef.current = null;
      }
      if (zoomPanelTimerRef.current !== null) {
        window.clearTimeout(zoomPanelTimerRef.current);
        zoomPanelTimerRef.current = null;
      }
      if (resizeCommitTimerRef.current !== null) {
        window.clearTimeout(resizeCommitTimerRef.current);
        resizeCommitTimerRef.current = null;
      }
    };
  }, []);

  useEffect(() => {
    const scrollElement = scrollAreaRef.current;
    if (!scrollElement) {
      return undefined;
    }
    const element = scrollElement;

    syncVisiblePage();
    element.addEventListener('scroll', syncVisiblePage, { passive: true });
    window.addEventListener('resize', syncVisiblePage);
    return () => {
      element.removeEventListener('scroll', syncVisiblePage);
      window.removeEventListener('resize', syncVisiblePage);
    };
  }, [displayZoomPercent, pdfUrl]);

  function nodeBelongsToRoot(node: Node | null): boolean {
    const root = rootRef.current;
    if (!root || !node) {
      return false;
    }
    return root.contains(node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement);
  }

  function intersection(left: DOMRect, right: DOMRect) {
    const x1 = Math.max(left.left, right.left);
    const y1 = Math.max(left.top, right.top);
    const x2 = Math.min(left.right, right.right);
    const y2 = Math.min(left.bottom, right.bottom);
    if (x2 <= x1 || y2 <= y1) {
      return null;
    }
    return { left: x1, top: y1, right: x2, bottom: y2, area: (x2 - x1) * (y2 - y1) };
  }

  function textSpanRectsForRange(range: Range): TextSelectionRect[] {
    const common =
      range.commonAncestorContainer.nodeType === Node.ELEMENT_NODE
        ? (range.commonAncestorContainer as Element)
        : range.commonAncestorContainer.parentElement;
    const layer = common?.closest('.textLayer');
    const scopedSpans = layer
      ? Array.from(layer.querySelectorAll<HTMLSpanElement>('span'))
      : Array.from(rootRef.current?.querySelectorAll<HTMLSpanElement>('.textLayer span') || []);
    const rects: TextSelectionRect[] = [];

    for (const span of scopedSpans) {
      const textNode = span.firstChild;
      if (!textNode || textNode.nodeType !== Node.TEXT_NODE) {
        continue;
      }
      const text = textNode.textContent || '';
      if (!text.trim()) {
        continue;
      }
      if (!range.intersectsNode(span)) {
        continue;
      }

      let start = 0;
      let end = text.length;
      if (range.startContainer === textNode) {
        start = range.startOffset;
      }
      if (range.endContainer === textNode) {
        end = range.endOffset;
      }
      if (end <= start) {
        continue;
      }

      const selected = text.slice(start, end);
      const runs = Array.from(selected.matchAll(/\S+/g));
      for (const run of runs) {
        const runText = run[0];
        const runStart = start + (run.index || 0);
        const runEnd = runStart + runText.length;
        const wordRange = document.createRange();
        wordRange.setStart(textNode, runStart);
        wordRange.setEnd(textNode, runEnd);
        const preciseRects = Array.from(wordRange.getClientRects()).filter((rect) => rect.width > 0 && rect.height > 0);
        if (preciseRects.length) {
          rects.push(...preciseRects.map((rect) => ({ rect, text: runText, span })));
        }
        wordRange.detach();
      }
    }

    return rects;
  }

  function selectionSegmentsForRange(range: Range): SelectionRangeSegment[] {
    const segments: SelectionRangeSegment[] = [];
    for (const view of pageViewsRef.current) {
      const pageRect = view.pageElement.getBoundingClientRect();
      const spans = Array.from(view.textLayer.querySelectorAll<HTMLSpanElement>('span'));
      for (const span of spans) {
        const textNode = span.firstChild;
        if (!textNode || textNode.nodeType !== Node.TEXT_NODE) {
          continue;
        }
        if (!range.intersectsNode(span)) {
          continue;
        }
        const text = textNode.textContent || '';
        if (!text.length) {
          continue;
        }
        let start = 0;
        let end = text.length;
        if (range.startContainer === textNode) {
          start = range.startOffset;
        }
        if (range.endContainer === textNode) {
          end = range.endOffset;
        }
        if (end <= start) {
          continue;
        }
        const selectedRange = document.createRange();
        selectedRange.setStart(textNode, start);
        selectedRange.setEnd(textNode, end);
        const selectedText = selectedRange.toString();
        const preciseRects = Array.from(selectedRange.getClientRects()).filter((rect) => rect.width > 0 && rect.height > 0);
        selectedRange.detach();
        if (!selectedText.trim() || !preciseRects.length) {
          continue;
        }
        let left = Number.POSITIVE_INFINITY;
        let top = Number.POSITIVE_INFINITY;
        let right = Number.NEGATIVE_INFINITY;
        let bottom = Number.NEGATIVE_INFINITY;
        for (const rect of preciseRects) {
          const hit = intersection(rect, pageRect);
          if (!hit) {
            continue;
          }
          left = Math.min(left, hit.left);
          top = Math.min(top, hit.top);
          right = Math.max(right, hit.right);
          bottom = Math.max(bottom, hit.bottom);
        }
        if (!Number.isFinite(left) || right <= left || bottom <= top) {
          continue;
        }
        segments.push({
          page: view.page,
          left,
          top,
          right,
          bottom,
          text: selectedText,
        });
      }
    }
    return segments;
  }

  function measuredTextWidth(text: string, span: HTMLSpanElement): number {
    if (!measureCanvasRef.current) {
      measureCanvasRef.current = document.createElement('canvas');
    }
    const context = measureCanvasRef.current.getContext('2d');
    if (!context) {
      return 0;
    }
    const style = window.getComputedStyle(span);
    context.font = `${style.fontStyle} ${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
    const letterSpacing = Number.parseFloat(style.letterSpacing);
    const spacing = Number.isFinite(letterSpacing) ? letterSpacing * Math.max(0, text.length - 1) : 0;
    return context.measureText(text).width + spacing;
  }

  function visibleWidthForSelection(rect: DOMRect, selectedText: string, span: HTMLSpanElement): number {
    const measured = measuredTextWidth(selectedText, span);
    if (!measured) {
      return rect.width;
    }
    return Math.max(2, Math.min(rect.width, measured + 2));
  }

  function indexedRunsForPage(view: PageView): IndexedTextRun[] {
    let cursor = 0;
    return view.textRuns.flatMap((run) => {
      if (!run.normalized) {
        cursor += run.text.length;
        return [];
      }
      const start = cursor;
      cursor += run.text.length + 1;
      return [{ run, start, end: start + run.normalized.length }];
    });
  }

  function snappedJumpRectForTarget(view: PageView, target: PdfJumpTarget): SnappedJumpRect {
    const fallbackWidth = Math.max(24, (target.width || 24) * view.scale);
    const fallbackHeight = Math.max(10, (target.height || 14) * view.scale);
    const fallbackRect = {
      left: target.x * view.scale,
      top: target.y * view.scale,
      width: fallbackWidth,
      height: fallbackHeight,
    };

    const selectedWord = normalizeJumpWord(target.selectedText);
    if (!selectedWord) {
      return fallbackRect;
    }

    const coarseCenterX = fallbackRect.left + fallbackRect.width / 2;
    const coarseCenterY = fallbackRect.top + fallbackRect.height / 2;
    const candidates = view.textRuns
      .map((run) => {
        const runText = normalizeJumpWord(run.text);
        if (!runText) {
          return null;
        }
        const startsWithWord = runText.startsWith(selectedWord);
        const endsWithWord = runText.endsWith(selectedWord);
        const containsWord = runText.includes(selectedWord);
        if (!containsWord && selectedWord.length > 4 && !selectedWord.includes('-')) {
          return null;
        }

        const centerX = run.left + run.width / 2;
        const centerY = run.top + run.height / 2;
        const dx = centerX - coarseCenterX;
        const dy = centerY - coarseCenterY;
        const distance = Math.hypot(dx, dy);
        const lengthPenalty = Math.max(0, runText.length - selectedWord.length) * 0.8;
        const edgeBonus = startsWithWord || endsWithWord ? 18 : 0;
        const exactBonus = runText === selectedWord ? 28 : 0;
        return {
          run,
          runText,
          distance,
          score: distance + lengthPenalty - edgeBonus - exactBonus,
        };
      })
      .filter((candidate): candidate is NonNullable<typeof candidate> => Boolean(candidate))
      .sort((left, right) => left.score - right.score);

    const best = candidates[0];
    if (!best) {
      return fallbackRect;
    }

    const matchIndex = best.runText.indexOf(selectedWord);
    const startRatio = matchIndex >= 0 ? matchIndex / Math.max(1, best.runText.length) : 0;
    const endRatio =
      matchIndex >= 0 ? Math.min(1, (matchIndex + selectedWord.length) / Math.max(1, best.runText.length)) : 1;
    const matchWidth = Math.max(12, best.run.width * Math.max(0.08, endRatio - startRatio));
    const visualHeight = Math.max(10, Math.min(best.run.height, best.run.height * 0.92));
    const visualTop = best.run.top + (best.run.height - visualHeight) / 2;

    return {
      left: best.run.left + best.run.width * startRatio,
      top: visualTop,
      width: matchWidth,
      height: visualHeight,
    };
  }

  function textRunRectsForSelection(selectedText: string): VisualSelectionRect[] {
    const selected = normalizeMatchText(selectedText);
    if (!selected) {
      return [];
    }

    for (const view of pageViewsRef.current) {
      const indexedRuns = indexedRunsForPage(view);
      const pageText = indexedRuns.map((entry) => entry.run.normalized).join(' ');
      const selectionStart = pageText.indexOf(selected);
      if (selectionStart < 0) {
        continue;
      }
      const selectionEnd = selectionStart + selected.length;
      const pageRect = view.pageElement.getBoundingClientRect();
      const rects: VisualSelectionRect[] = [];

      for (const entry of indexedRuns) {
        if (entry.end <= selectionStart || entry.start >= selectionEnd) {
          continue;
        }
        const overlapStart = Math.max(selectionStart, entry.start);
        const overlapEnd = Math.min(selectionEnd, entry.end);
        const startRatio = Math.max(0, (overlapStart - entry.start) / Math.max(1, entry.run.normalized.length));
        const endRatio = Math.min(1, (overlapEnd - entry.start) / Math.max(1, entry.run.normalized.length));
        if (endRatio <= startRatio) {
          continue;
        }
        const rawHeight = entry.run.height;
        const visualHeight = Math.max(5, Math.min(11, rawHeight * 0.48));
        rects.push({
          id: `${view.page}-${rects.length}`,
          left: view.pageElement.offsetLeft + entry.run.left + entry.run.width * startRatio - 1.2,
          top: view.pageElement.offsetTop + entry.run.top + (rawHeight - visualHeight) * 0.62,
          width: Math.max(3, entry.run.width * (endRatio - startRatio) + 2.4),
          height: visualHeight,
          kind: 'text',
        });
      }

      if (rects.length) {
        return rects;
      }
    }

    return [];
  }

  function jumpHighlightRectsForTarget(target: PdfJumpTarget): VisualSelectionRect[] {
    const selected = normalizeMatchText(target.selectedText || '');
    if (!selected) {
      return [];
    }
    return textRunRectsForSelection(selected)
      .filter((rect) => rect.id.startsWith(`${target.page}-`))
      .map((rect, index) => ({
        ...rect,
        id: `jump-text-${target.page}-${index}`,
        kind: 'jump-text' as const,
      }));
  }

  function currentTextSelectionSnapshot(): { best: SelectionHit; selectedText: string; visualRects: VisualSelectionRect[] } | null {
    if (!selectable) {
      return null;
    }
    const selection = window.getSelection();
    if (!selection || selection.isCollapsed || selection.rangeCount === 0) {
      return null;
    }
    if (!nodeBelongsToRoot(selection.anchorNode) && !nodeBelongsToRoot(selection.focusNode)) {
      return null;
    }

    const range = selection.getRangeAt(0);
    const segments = selectionSegmentsForRange(range);
    const selectedText = segments.map((segment) => segment.text).join(' ').replace(/\s+/g, ' ').trim();
    if (!selectedText || !segments.length) {
      return null;
    }
    const matchedTextRunRects = textRunRectsForSelection(selectedText);
    const visualRects: VisualSelectionRect[] = matchedTextRunRects.length ? matchedTextRunRects : [];
    let best: SelectionHit | null = null;

    for (const view of pageViewsRef.current) {
      let pageUnion: SelectionHit | null = null;
      const pageRect = view.pageElement.getBoundingClientRect();
      const pageSegments = segments.filter((segment) => segment.page === view.page);
      for (const segment of pageSegments) {
        const hit = {
          left: segment.left,
          top: segment.top,
          right: segment.right,
          bottom: segment.bottom,
          area: Math.max(1, (segment.right - segment.left) * (segment.bottom - segment.top)),
        };
        if (!hit.area) {
          continue;
        }
        if (!matchedTextRunRects.length) {
          const rawHeight = (hit.bottom - hit.top) / previewScale;
          const visualHeight = Math.max(5, Math.min(11, rawHeight * 0.46));
          const visualTop = (hit.top - pageRect.top) / previewScale + (rawHeight - visualHeight) * 0.56;
          visualRects.push({
            id: `${view.page}-${visualRects.length}`,
            left: view.pageElement.offsetLeft + (hit.left - pageRect.left) / previewScale - 1.2,
            top: view.pageElement.offsetTop + visualTop,
            width: (hit.right - hit.left) / previewScale + 2.4,
            height: visualHeight,
            kind: 'text',
          });
        }
        if (!pageUnion) {
          pageUnion = { view, left: hit.left, top: hit.top, right: hit.right, bottom: hit.bottom, area: hit.area };
        } else {
          pageUnion.left = Math.min(pageUnion.left, hit.left);
          pageUnion.top = Math.min(pageUnion.top, hit.top);
          pageUnion.right = Math.max(pageUnion.right, hit.right);
          pageUnion.bottom = Math.max(pageUnion.bottom, hit.bottom);
          pageUnion.area += hit.area;
        }
      }
      if (pageUnion && (!best || pageUnion.area > best.area)) {
        best = pageUnion;
      }
    }

    if (!best) {
      return null;
    }

    return {
      best,
      selectedText,
      visualRects,
    };
  }

  function syncTextSelectionPreview() {
    const snapshot = currentTextSelectionSnapshot();
    if (!snapshot) {
      return;
    }
    setVisualSelectionRects(snapshot.visualRects);
  }

  function handleTextSelection() {
    if (!onSelectRegion) {
      return;
    }
    const snapshot = currentTextSelectionSnapshot();
    if (!snapshot) {
      return;
    }

    const { best, selectedText, visualRects } = snapshot;
    setVisualSelectionRects(visualRects);

    const pageRect = best.view.pageElement.getBoundingClientRect();
    const x = Math.max(0, (best.left - pageRect.left) / previewScale);
    const y = Math.max(0, (best.top - pageRect.top) / previewScale);
    const width = Math.min(best.view.width - x, (best.right - best.left) / previewScale);
    const height = Math.min(best.view.height - y, (best.bottom - best.top) / previewScale);
    if (width < 2 || height < 2) {
      return;
    }

    onSelectRegion({
      page: best.view.page,
      x: x / best.view.scale,
      y: y / best.view.scale,
      width: width / best.view.scale,
      height: height / best.view.scale,
      selectedText,
      anchor: {
        x: best.left + (best.right - best.left) / 2,
        y: best.bottom,
      },
    });
  }

  useEffect(() => {
    if (!selectable) {
      return undefined;
    }

    function handleSelectionChange() {
      if (selectionSyncFrameRef.current !== null) {
        return;
      }
      selectionSyncFrameRef.current = window.requestAnimationFrame(() => {
        selectionSyncFrameRef.current = null;
        syncTextSelectionPreview();
      });
    }

    document.addEventListener('selectionchange', handleSelectionChange);
    return () => {
      document.removeEventListener('selectionchange', handleSelectionChange);
      if (selectionSyncFrameRef.current !== null) {
        window.cancelAnimationFrame(selectionSyncFrameRef.current);
        selectionSyncFrameRef.current = null;
      }
    };
  }, [pdfUrl, selectable]);

  function pageAtPoint(clientX: number, clientY: number): PageView | null {
    return (
      pageViewsRef.current.find((view) => {
        const rect = view.pageElement.getBoundingClientRect();
        return clientX >= rect.left && clientX <= rect.right && clientY >= rect.top && clientY <= rect.bottom;
      }) || null
    );
  }

  function pagePoint(event: React.PointerEvent, view: PageView) {
    const rect = view.pageElement.getBoundingClientRect();
    return {
      x: Math.max(0, Math.min(view.width, (event.clientX - rect.left) / previewScale)),
      y: Math.max(0, Math.min(view.height, (event.clientY - rect.top) / previewScale)),
    };
  }

  function handlePointerDown(event: React.PointerEvent<HTMLDivElement>) {
    if (event.ctrlKey && selectable && onCtrlClickRegion) {
      if (isToolbarTarget(event.target) || isScrollbarInteraction(rootRef.current, event)) {
        return;
      }
      const view = pageAtPoint(event.clientX, event.clientY);
      if (!view) {
        return;
      }
      const point = pagePoint(event, view);
      event.preventDefault();
      onCtrlClickRegion({
        page: view.page,
        x: point.x / view.scale,
        y: point.y / view.scale,
        width: 0,
        height: 0,
        selectedText: 'PDF ctrl-click',
        anchor: { x: event.clientX, y: event.clientY },
      });
      return;
    }
    if (!selectable || !onSelectRegion || event.button !== 0) {
      return;
    }
    if (isToolbarTarget(event.target)) {
      return;
    }
    if (isScrollbarInteraction(rootRef.current, event)) {
      return;
    }
    if (!event.shiftKey && !event.altKey && event.target instanceof HTMLElement && event.target.closest('.textLayer')) {
      return;
    }
    if (!event.altKey && !event.shiftKey) {
      return;
    }
    const view = pageAtPoint(event.clientX, event.clientY);
    if (!view) {
      return;
    }
    const point = pagePoint(event, view);
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    setDraftRegion({
      page: view.page,
      startX: point.x,
      startY: point.y,
      x: point.x,
      y: point.y,
      width: 0,
      height: 0,
    });
    setVisualSelectionRects([]);
    onClearSelection?.();
    window.getSelection()?.removeAllRanges();
  }

  function handlePointerMove(event: React.PointerEvent<HTMLDivElement>) {
    if (!draftRegion) {
      return;
    }
    const view = pageViewsRef.current.find((entry) => entry.page === draftRegion.page);
    if (!view) {
      return;
    }
    const point = pagePoint(event, view);
    setDraftRegion({
      ...draftRegion,
      x: Math.min(draftRegion.startX, point.x),
      y: Math.min(draftRegion.startY, point.y),
      width: Math.abs(point.x - draftRegion.startX),
      height: Math.abs(point.y - draftRegion.startY),
    });
  }

  function handlePointerUp(event: React.PointerEvent<HTMLDivElement>) {
    if (!draftRegion || !onSelectRegion) {
      return;
    }
    const view = pageViewsRef.current.find((entry) => entry.page === draftRegion.page);
    const region = draftRegion;
    setDraftRegion(null);
    try {
      event.currentTarget.releasePointerCapture(event.pointerId);
    } catch {
      // Pointer capture may already be released.
    }
    if (!view || region.width < 8 || region.height < 8) {
      return;
    }
    const pageRect = view.pageElement.getBoundingClientRect();
    setVisualSelectionRects([
      {
        id: `region-${view.page}`,
        left: view.pageElement.offsetLeft + region.x,
        top: view.pageElement.offsetTop + region.y,
        width: region.width,
        height: region.height,
        kind: 'region',
      },
    ]);
    suppressSelectionSyncUntilRef.current = Date.now() + 180;
    onSelectRegion({
      page: view.page,
      x: region.x / view.scale,
      y: region.y / view.scale,
      width: region.width / view.scale,
      height: region.height / view.scale,
      selectedText: 'PDF region selection',
      anchor: {
        x: pageRect.left + (region.x + region.width / 2) * previewScale,
        y: pageRect.top + (region.y + region.height) * previewScale,
      },
    });
  }

  function scheduleTextSelection() {
    window.setTimeout(() => {
      if (Date.now() < suppressSelectionSyncUntilRef.current) {
        return;
      }
      const snapshot = currentTextSelectionSnapshot();
      if (snapshot) {
        handleTextSelection();
        return;
      }
      if (!draftRegion) {
        setVisualSelectionRects([]);
        onClearSelection?.();
      }
    }, 0);
  }

  return (
    <div
      ref={rootRef}
      className={`selectable-pdf ${selectable ? 'is-selectable' : ''}`}
      role="document"
      aria-label={title}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onMouseUp={scheduleTextSelection}
      onKeyUp={scheduleTextSelection}
      onTouchEnd={scheduleTextSelection}
    >
      <div ref={scrollAreaRef} className="pdf-scroll-area">
        <div
          className="pdf-pages-shell"
          style={
            contentMetrics.width
              ? {
                  width: `${contentMetrics.width * previewScale}px`,
                  minHeight: `${contentMetrics.height * previewScale}px`,
                }
              : undefined
          }
        >
          <div
            ref={pagesViewportRef}
            className="pdf-pages-viewport"
            style={{
              width: contentMetrics.width ? `${contentMetrics.width}px` : undefined,
              minHeight: contentMetrics.height ? `${contentMetrics.height}px` : undefined,
              transform: `scale(${previewScale})`,
            }}
          >
            <div className="pdf-pages" ref={pagesRef} />
            {draftRegion
              ? (() => {
                  const view = pageViewsRef.current.find((entry) => entry.page === draftRegion.page);
                  if (!view) {
                    return null;
                  }
                  return (
                    <div
                      className="pdf-region-draft"
                      style={{
                        left: view.pageElement.offsetLeft + draftRegion.x,
                        top: view.pageElement.offsetTop + draftRegion.y,
                        width: draftRegion.width,
                        height: draftRegion.height,
                      }}
                    />
                  );
                })()
              : null}
            {visualSelectionRects.map((rect) => (
              <div
                key={rect.id}
                className={`pdf-visual-selection ${rect.kind === 'region' ? 'is-region' : ''} ${rect.kind === 'jump-text' ? 'is-jump-text' : ''}`}
                style={{
                  left: rect.left,
                  top: rect.top,
                  width: rect.width,
                  height: rect.height,
                }}
              />
            ))}
          </div>
        </div>
      </div>
      {renderError ? <div className="pdf-render-error">PDF 加载失败</div> : null}
      {selectable && zoomPanelActive ? (
        <div className="pdf-zoom-overlay" aria-live="polite">
          <span>{pageStatusLabel()}</span>
          <strong>{displayZoomPercent}%</strong>
        </div>
      ) : null}
    </div>
  );
}
