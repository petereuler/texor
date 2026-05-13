import { Send, Sparkles, X } from 'lucide-react';
import { FormEvent, KeyboardEvent, useEffect, useRef, useState } from 'react';

export interface QuickIssueBarProps {
  selectedText?: string;
  anchor: { x: number; y: number };
  onCancel: () => void;
  onSubmit: (payload: { issue: string; changeRequest: string }) => Promise<void> | void;
}

export function QuickIssueBar({ anchor, onCancel, onSubmit }: QuickIssueBarProps) {
  const [comment, setComment] = useState('');
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
      className="quick-issue-bar"
      style={{ left: Math.max(anchor.x - 170, 16), top: anchor.y + 8 }}
      onSubmit={handleSubmit}
    >
      <div className="quick-issue-bar__meta">
        <Sparkles size={12} />
      </div>
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
