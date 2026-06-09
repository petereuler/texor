import { MessageSquareWarning } from 'lucide-react';
import { MouseEvent, ReactNode, useEffect, useRef } from 'react';
import { FigureBlock, PaperBlock, TableBlock, TextBlock } from '../types';

export interface AnnotationTarget {
  blockId: string;
  selectedText?: string;
  sourceFile?: string;
  sourceLine?: number;
  column?: number;
  sourceSnippet?: string;
  anchor: { x: number; y: number };
}

interface PaperPreviewProps {
  blocks: PaperBlock[];
  onAnnotate?: (target: AnnotationTarget) => void;
  title?: string;
  subtitle?: string;
  compact?: boolean;
  focusQuery?: string;
}

function requestTextAnnotation(blockId: string, onAnnotate: PaperPreviewProps['onAnnotate']) {
  if (!onAnnotate) {
    return;
  }

  const selection = window.getSelection();
  const selectedText = selection?.toString().trim();
  if (!selection || !selectedText) {
    return;
  }

  const range = selection.getRangeAt(0);
  const rect = range.getBoundingClientRect();
  onAnnotate({
    blockId,
    selectedText,
    anchor: { x: rect.left + window.scrollX, y: rect.bottom + window.scrollY },
  });
}

function renderBlockActions(blockId: string, onAnnotate?: PaperPreviewProps['onAnnotate']): ReactNode {
  if (!onAnnotate) {
    return null;
  }

  return (
    <button
      type="button"
      className="block-annotate-button"
      title="修订"
      aria-label="修订"
      onClick={(event: MouseEvent<HTMLButtonElement>) => {
        const rect = event.currentTarget.getBoundingClientRect();
        onAnnotate({
          blockId,
          anchor: { x: rect.left + window.scrollX, y: rect.bottom + window.scrollY },
        });
      }}
    >
      <MessageSquareWarning size={14} />
    </button>
  );
}

function TextCard({ block, onAnnotate, isFocused }: { block: TextBlock; onAnnotate?: PaperPreviewProps['onAnnotate']; isFocused?: boolean }) {
  return (
    <article className={`paper-block ${isFocused ? 'paper-block--focused' : ''}`}>
      <header className="paper-block__header">
        <div>
          <span className="paper-block__section">{block.section}</span>
          <h3>{block.title}</h3>
        </div>
        {renderBlockActions(block.id, onAnnotate)}
      </header>
      <p
        className="paper-text"
        onMouseUp={() => {
          requestTextAnnotation(block.id, onAnnotate);
        }}
      >
        {block.content}
      </p>
    </article>
  );
}

function FigureCard({ block, onAnnotate, isFocused }: { block: FigureBlock; onAnnotate?: PaperPreviewProps['onAnnotate']; isFocused?: boolean }) {
  return (
    <article className={`paper-block ${isFocused ? 'paper-block--focused' : ''}`}>
      <header className="paper-block__header">
        <div>
          <span className="paper-block__section">{block.section}</span>
          <h3>{block.title}</h3>
        </div>
        {renderBlockActions(block.id, onAnnotate)}
      </header>
      <div className="figure-frame">
        <img src={block.imageUrl} alt={block.title} />
      </div>
      <p className="paper-caption">{block.caption}</p>
      <p className="paper-note">{block.insight}</p>
    </article>
  );
}

function TableCard({ block, onAnnotate, isFocused }: { block: TableBlock; onAnnotate?: PaperPreviewProps['onAnnotate']; isFocused?: boolean }) {
  return (
    <article className={`paper-block ${isFocused ? 'paper-block--focused' : ''}`}>
      <header className="paper-block__header">
        <div>
          <span className="paper-block__section">{block.section}</span>
          <h3>{block.title}</h3>
        </div>
        {renderBlockActions(block.id, onAnnotate)}
      </header>
      <p className="paper-caption">{block.caption}</p>
      <div className="table-frame">
        <table>
          <thead>
            <tr>
              {block.headers.map((header) => (
                <th key={header}>{header}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {block.rows.map((row, index) => (
              <tr key={`${block.id}-row-${index}`}>
                {row.map((cell, cellIndex) => (
                  <td key={`${block.id}-cell-${index}-${cellIndex}`}>{cell}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {block.note ? <p className="paper-note">{block.note}</p> : null}
    </article>
  );
}

function normalizePreviewMatchText(value?: string): string {
  return (value || '').replace(/\s+/g, ' ').trim().toLowerCase();
}

function blockMatchesFocusQuery(block: PaperBlock, query: string): boolean {
  const normalizedQuery = normalizePreviewMatchText(query);
  if (!normalizedQuery) {
    return false;
  }
  const candidates = [
    block.title,
    block.section,
    block.type === 'text' ? block.content.slice(0, 320) : block.caption,
    block.type === 'figure' ? block.insight : block.type === 'table' ? block.note : '',
  ];
  return candidates.some((candidate) => {
    const normalizedCandidate = normalizePreviewMatchText(candidate);
    return normalizedCandidate.includes(normalizedQuery) || normalizedQuery.includes(normalizedCandidate);
  });
}

export function PaperPreview({ blocks, onAnnotate, title, subtitle, compact, focusQuery }: PaperPreviewProps) {
  const focusedBlockRef = useRef<HTMLElement | null>(null);
  const normalizedFocusQuery = normalizePreviewMatchText(focusQuery);

  useEffect(() => {
    if (!normalizedFocusQuery || !focusedBlockRef.current) {
      return;
    }
    focusedBlockRef.current.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }, [normalizedFocusQuery, blocks]);

  return (
    <section className={compact ? 'paper-canvas paper-canvas--compact' : 'paper-canvas'}>
      {!compact ? (
        <header className="paper-canvas__header">
          <div>
            <h2>{title || 'Current Manuscript'}</h2>
            {subtitle ? <p>{subtitle}</p> : null}
          </div>
        </header>
      ) : null}

      <div className="paper-page">
        {blocks.map((block) => {
          const isFocused = normalizedFocusQuery ? blockMatchesFocusQuery(block, normalizedFocusQuery) : false;
          if (block.type === 'text') {
            return (
              <div
                key={block.id}
                ref={(node) => {
                  if (isFocused && node) {
                    focusedBlockRef.current = node;
                  }
                }}
              >
                <TextCard block={block} onAnnotate={onAnnotate} isFocused={isFocused} />
              </div>
            );
          }
          if (block.type === 'figure') {
            return (
              <div
                key={block.id}
                ref={(node) => {
                  if (isFocused && node) {
                    focusedBlockRef.current = node;
                  }
                }}
              >
                <FigureCard block={block} onAnnotate={onAnnotate} isFocused={isFocused} />
              </div>
            );
          }
          return (
            <div
              key={block.id}
              ref={(node) => {
                if (isFocused && node) {
                  focusedBlockRef.current = node;
                }
              }}
            >
              <TableCard block={block} onAnnotate={onAnnotate} isFocused={isFocused} />
            </div>
          );
        })}
      </div>
    </section>
  );
}
