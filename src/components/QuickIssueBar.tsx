import { Send, Sparkles, X } from 'lucide-react';
import { FormEvent, KeyboardEvent, useEffect, useRef, useState } from 'react';
import type { TaskSpeedMode } from '../types';

export interface QuickIssueBarProps {
  selectedText?: string;
  anchor: { x: number; y: number };
  onCancel: () => void;
  onSubmit: (payload: { issue: string; changeRequest: string; taskSpeedMode: TaskSpeedMode }) => Promise<void> | void;
}

export function QuickIssueBar({ selectedText, anchor, onCancel, onSubmit }: QuickIssueBarProps) {
  const [comment, setComment] = useState('');
  const [taskSpeedMode, setTaskSpeedMode] = useState<TaskSpeedMode>(() => {
    return (window.localStorage.getItem('texor.quickIssueSpeedMode') as TaskSpeedMode) || 'quick';
  });
  const [submitting, setSubmitting] = useState(false);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    const input = inputRef.current;
    if (!input) {
      return;
    }
    input.style.height = '0px';
    input.style.height = `${Math.min(96, Math.max(28, input.scrollHeight))}px`;
  }, [comment]);

  useEffect(() => {
    window.localStorage.setItem('texor.quickIssueSpeedMode', taskSpeedMode);
  }, [taskSpeedMode]);

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    const request = comment.trim();
    if (!request) {
      return;
    }

    setSubmitting(true);
    try {
      await onSubmit({
        issue: 'PDF selection revision',
        changeRequest: request,
        taskSpeedMode,
      });
    } finally {
      setSubmitting(false);
    }
  }

  function handleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      event.currentTarget.form?.requestSubmit();
    }
  }

  return (
    <form
      className={`quick-issue-bar ${selectedText ? 'has-selection' : ''}`}
      style={{
        left: Math.max(anchor.x - 170, 16),
        top: Math.min(anchor.y + 8, window.innerHeight - 84),
      }}
      onSubmit={handleSubmit}
    >
      <div className="quick-issue-bar__meta">
        <Sparkles size={12} />
      </div>
      <div className="quick-issue-bar__speed-switch" role="tablist" aria-label="任务速度">
        <button
          type="button"
          className={taskSpeedMode === 'quick' ? 'is-active' : ''}
          onClick={() => setTaskSpeedMode('quick')}
          aria-label="快速模式"
          title="快速模式"
        >
          快
        </button>
        <button
          type="button"
          className={taskSpeedMode === 'deep' ? 'is-active' : ''}
          onClick={() => setTaskSpeedMode('deep')}
          aria-label="深度模式"
          title="深度模式"
        >
          深
        </button>
      </div>
      {selectedText ? <div className="quick-issue-bar__selection">{selectedText}</div> : null}
      <textarea
        ref={inputRef}
        value={comment}
        onChange={(event) => setComment(event.target.value)}
        onKeyDown={handleKeyDown}
        placeholder="给 TEXOR 的修改意见"
        rows={1}
      />
      <button type="submit" className="quick-issue-bar__send" disabled={submitting} aria-label="发送给 TEXOR">
        <Send size={12} />
      </button>
      <button type="button" className="ghost-icon-button" onClick={onCancel} aria-label="关闭修订窗口">
        <X size={12} />
      </button>
    </form>
  );
}
