import { diffWordsWithSpace } from 'diff';
import { FigureBlock, PaperBlock, PaperVersion, TableBlock, TextBlock } from '../types';

function opacityFromText(value: string): number {
  return Math.min(0.86, 0.22 + value.length / 120);
}

function renderDiffText(previous: string, current: string, side: 'previous' | 'current') {
  const parts = diffWordsWithSpace(previous, current);

  return parts
    .filter((part) => {
      if (side === 'current' && part.removed) {
        return false;
      }
      if (side === 'previous' && part.added) {
        return false;
      }
      return true;
    })
    .map((part, index) => {
      const changed = side === 'current' ? part.added : part.removed;
      const color = side === 'current' ? `rgba(22, 163, 74, ${opacityFromText(part.value)})` : `rgba(239, 68, 68, ${opacityFromText(part.value)})`;
      return (
        <span key={`${side}-${index}`} style={{ backgroundColor: changed ? color : 'transparent' }}>
          {part.value}
        </span>
      );
    });
}

function findMatchingBlock(block: PaperBlock, reference: PaperBlock[]) {
  return (
    reference.find((candidate) => candidate.id === block.id) ||
    reference.find((candidate) => candidate.type === block.type && candidate.title === block.title)
  );
}

function TextDiffCard({ currentBlock, previousBlock, side }: { currentBlock: TextBlock; previousBlock?: TextBlock; side: 'previous' | 'current' }) {
  const previous = previousBlock?.content || '';
  const current = currentBlock.content;
  return (
    <article className="paper-block diff-block">
      <span className="paper-block__section">{currentBlock.section}</span>
      <h3>{currentBlock.title}</h3>
      <p className="paper-text">{renderDiffText(previous, current, side)}</p>
    </article>
  );
}

function FigureDiffCard({ currentBlock, previousBlock, side }: { currentBlock: FigureBlock; previousBlock?: FigureBlock; side: 'previous' | 'current' }) {
  const previousCaption = previousBlock?.caption || '';
  const currentCaption = currentBlock.caption;
  const previousInsight = previousBlock?.insight || '';
  const currentInsight = currentBlock.insight;

  return (
    <article className="paper-block diff-block">
      <span className="paper-block__section">{currentBlock.section}</span>
      <h3>{currentBlock.title}</h3>
      <div className="figure-frame">
        <img src={currentBlock.imageUrl} alt={currentBlock.title} />
      </div>
      <p className="paper-caption">{renderDiffText(previousCaption, currentCaption, side)}</p>
      <p className="paper-note">{renderDiffText(previousInsight, currentInsight, side)}</p>
    </article>
  );
}

function TableDiffCard({ currentBlock, previousBlock, side }: { currentBlock: TableBlock; previousBlock?: TableBlock; side: 'previous' | 'current' }) {
  const previousRows = previousBlock?.rows || [];
  return (
    <article className="paper-block diff-block">
      <span className="paper-block__section">{currentBlock.section}</span>
      <h3>{currentBlock.title}</h3>
      <p className="paper-caption">
        {renderDiffText(previousBlock?.caption || '', currentBlock.caption, side)}
      </p>
      <div className="table-frame">
        <table>
          <thead>
            <tr>
              {currentBlock.headers.map((header, index) => (
                <th key={`${currentBlock.id}-header-${index}`}>
                  {renderDiffText(previousBlock?.headers[index] || '', header, side)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {currentBlock.rows.map((row, rowIndex) => (
              <tr key={`${currentBlock.id}-row-${rowIndex}`}>
                {row.map((cell, cellIndex) => (
                  <td key={`${currentBlock.id}-cell-${rowIndex}-${cellIndex}`}>
                    {renderDiffText(previousRows[rowIndex]?.[cellIndex] || '', cell, side)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {currentBlock.note ? (
        <p className="paper-note">{renderDiffText(previousBlock?.note || '', currentBlock.note, side)}</p>
      ) : null}
    </article>
  );
}

function DiffColumn({
  title,
  version,
  reference,
  side,
}: {
  title: string;
  version: PaperVersion;
  reference: PaperVersion;
  side: 'previous' | 'current';
}) {
  return (
    <section className="diff-column">
      <header className="diff-column__header">
        <h3>{title}</h3>
        <p>
          {version.label} · {new Date(version.createdAt).toLocaleString()}
        </p>
      </header>
      <div className="paper-page diff-page">
        {version.blocks.map((block) => {
          const matched = findMatchingBlock(block, reference.blocks);
          if (block.type === 'text') {
            return (
              <TextDiffCard
                key={block.id}
                currentBlock={block}
                previousBlock={matched?.type === 'text' ? matched : undefined}
                side={side}
              />
            );
          }

          if (block.type === 'figure') {
            return (
              <FigureDiffCard
                key={block.id}
                currentBlock={block}
                previousBlock={matched?.type === 'figure' ? matched : undefined}
                side={side}
              />
            );
          }

          return (
            <TableDiffCard
              key={block.id}
              currentBlock={block}
              previousBlock={matched?.type === 'table' ? matched : undefined}
              side={side}
            />
          );
        })}
      </div>
    </section>
  );
}

export function VersionDiff({ currentVersion, previousVersion }: { currentVersion: PaperVersion; previousVersion: PaperVersion }) {
  return (
    <section className="diff-layout">
      <DiffColumn title="上一版本" version={previousVersion} reference={currentVersion} side="previous" />
      <DiffColumn title="当前版本" version={currentVersion} reference={previousVersion} side="current" />
    </section>
  );
}

