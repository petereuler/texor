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

interface SelectablePdfProps {
  pdfUrl: string;
  title: string;
  selectable?: boolean;
  clearSelectionSignal?: number;
  onSelectRegion?: (selection: PdfRegionSelection) => void;
}

interface PageView {
  page: number;
  width: number;
  height: number;
  scale: number;
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
  kind?: 'text' | 'region';
}

interface TextSelectionRect {
  rect: DOMRect;
  text: string;
  span: HTMLSpanElement;
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

interface PdfTextItemLike {
  str: string;
  transform: number[];
  width: number;
  height: number;
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

export function SelectablePdf({ pdfUrl, title, selectable, clearSelectionSignal, onSelectRegion }: SelectablePdfProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const pagesRef = useRef<HTMLDivElement>(null);
  const measureCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const pageViewsRef = useRef<PageView[]>([]);
  const [visualSelectionRects, setVisualSelectionRects] = useState<VisualSelectionRect[]>([]);
  const [draftRegion, setDraftRegion] = useState<DraftRegion | null>(null);
  const [renderError, setRenderError] = useState('');

  useEffect(() => {
    let cancelled = false;
    const pageHost = pagesRef.current;
    if (!pageHost) {
      return undefined;
    }

    pageHost.innerHTML = '';
    pageViewsRef.current = [];
    setVisualSelectionRects([]);

    async function renderPdf(host: HTMLDivElement) {
      try {
        setRenderError('');
        const pdfDocument = await pdfjsLib.getDocument(pdfUrl).promise;
        if (cancelled) {
          return;
        }
        for (let pageNumber = 1; pageNumber <= pdfDocument.numPages; pageNumber += 1) {
          const page = await pdfDocument.getPage(pageNumber);
          if (cancelled) {
            return;
          }
          const baseViewport = page.getViewport({ scale: 1 });
          const containerWidth = Math.max(320, host.clientWidth - 18);
          const scale = Math.min(1.65, containerWidth / baseViewport.width);
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
          host.appendChild(pageElement);
          pageViewsRef.current.push({
            page: pageNumber,
            width: viewport.width,
            height: viewport.height,
            scale,
            pageElement,
            canvas,
            textLayer,
            textRuns: [],
          });
          const canvasContext = canvas.getContext('2d') as CanvasRenderingContext2D;
          await page.render({
            canvasContext,
            viewport,
            transform: outputScale !== 1 ? [outputScale, 0, 0, outputScale, 0, 0] : undefined,
          }).promise;
          if (selectable && !cancelled) {
            const textContent = await page.getTextContent();
            const currentView = pageViewsRef.current.find((view) => view.page === pageNumber);
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
  }, [pdfUrl, selectable]);

  useEffect(() => {
    setVisualSelectionRects([]);
  }, [clearSelectionSignal]);

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

  function textRunRectsForSelection(selectedText: string, root: HTMLDivElement, rootRect: DOMRect): VisualSelectionRect[] {
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
          left: pageRect.left - rootRect.left + root.scrollLeft + entry.run.left + entry.run.width * startRatio - 1.2,
          top: pageRect.top - rootRect.top + root.scrollTop + entry.run.top + (rawHeight - visualHeight) * 0.62,
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

  function handleTextSelection() {
    if (!selectable || !onSelectRegion) {
      return;
    }
    const selection = window.getSelection();
    if (!selection || selection.isCollapsed || selection.rangeCount === 0) {
      return;
    }
    if (!nodeBelongsToRoot(selection.anchorNode) && !nodeBelongsToRoot(selection.focusNode)) {
      return;
    }

    const selectedText = selection.toString().replace(/\s+/g, ' ').trim();
    if (!selectedText) {
      return;
    }

    const range = selection.getRangeAt(0);
    const rects = textSpanRectsForRange(range);
    const root = rootRef.current;
    const rootRect = root?.getBoundingClientRect();
    const matchedTextRunRects = root && rootRect ? textRunRectsForSelection(selectedText, root, rootRect) : [];
    const nextVisualRects: VisualSelectionRect[] = matchedTextRunRects.length ? matchedTextRunRects : [];
    let best: SelectionHit | null = null;

    for (const view of pageViewsRef.current) {
      const pageRect = view.pageElement.getBoundingClientRect();
      let pageUnion: SelectionHit | null = null;
      for (const entry of rects) {
        const croppedWidth = visibleWidthForSelection(entry.rect, entry.text, entry.span);
        const croppedRect = new DOMRect(entry.rect.left, entry.rect.top, croppedWidth, entry.rect.height);
        const hit = intersection(croppedRect, pageRect);
        if (!hit) {
          continue;
        }
        if (!matchedTextRunRects.length && root && rootRect) {
          const rawHeight = hit.bottom - hit.top;
          const visualHeight = Math.max(5, Math.min(11, rawHeight * 0.46));
          const visualTop = hit.top + (rawHeight - visualHeight) * 0.56;
          nextVisualRects.push({
            id: `${view.page}-${nextVisualRects.length}`,
            left: hit.left - rootRect.left + root.scrollLeft - 1.2,
            top: visualTop - rootRect.top + root.scrollTop,
            width: hit.right - hit.left + 2.4,
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
      return;
    }
    setVisualSelectionRects(nextVisualRects);

    const pageRect = best.view.pageElement.getBoundingClientRect();
    const x = Math.max(0, best.left - pageRect.left);
    const y = Math.max(0, best.top - pageRect.top);
    const width = Math.min(best.view.width - x, best.right - best.left);
    const height = Math.min(best.view.height - y, best.bottom - best.top);
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
        x: best.left + (best.right - best.left) / 2 + window.scrollX,
        y: best.bottom + window.scrollY,
      },
    });
  }

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
      x: Math.max(0, Math.min(view.width, event.clientX - rect.left)),
      y: Math.max(0, Math.min(view.height, event.clientY - rect.top)),
    };
  }

  function handlePointerDown(event: React.PointerEvent<HTMLDivElement>) {
    if (!selectable || !onSelectRegion || event.button !== 0) {
      return;
    }
    if (!event.shiftKey && !event.altKey && event.target instanceof HTMLElement && event.target.closest('.textLayer')) {
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
    const root = rootRef.current;
    const rootRect = root?.getBoundingClientRect();
    const pageRect = view.pageElement.getBoundingClientRect();
    if (root && rootRect) {
      setVisualSelectionRects([
        {
          id: `region-${view.page}`,
          left: pageRect.left - rootRect.left + root.scrollLeft + region.x,
          top: pageRect.top - rootRect.top + root.scrollTop + region.y,
          width: region.width,
          height: region.height,
          kind: 'region',
        },
      ]);
    }
    onSelectRegion({
      page: view.page,
      x: region.x / view.scale,
      y: region.y / view.scale,
      width: region.width / view.scale,
      height: region.height / view.scale,
      selectedText: 'PDF region selection',
      anchor: {
        x: pageRect.left + region.x + region.width / 2 + window.scrollX,
        y: pageRect.top + region.y + region.height + window.scrollY,
      },
    });
  }

  function scheduleTextSelection() {
    window.setTimeout(handleTextSelection, 0);
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
      <div className="pdf-pages" ref={pagesRef} />
      {draftRegion && rootRef.current
        ? (() => {
            const view = pageViewsRef.current.find((entry) => entry.page === draftRegion.page);
            if (!view) {
              return null;
            }
            const rootRect = rootRef.current.getBoundingClientRect();
            const pageRect = view.pageElement.getBoundingClientRect();
            return (
              <div
                className="pdf-region-draft"
                style={{
                  left: pageRect.left - rootRect.left + rootRef.current.scrollLeft + draftRegion.x,
                  top: pageRect.top - rootRect.top + rootRef.current.scrollTop + draftRegion.y,
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
          className={`pdf-visual-selection ${rect.kind === 'region' ? 'is-region' : ''}`}
          style={{
            left: rect.left,
            top: rect.top,
            width: rect.width,
            height: rect.height,
          }}
        />
      ))}
      {renderError ? <div className="pdf-render-error">PDF 加载失败</div> : null}
    </div>
  );
}
