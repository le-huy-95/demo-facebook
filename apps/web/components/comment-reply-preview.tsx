'use client';

import type { MouseEvent, ReactNode } from 'react';

function ReplyIcon({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 20 20"
      fill="currentColor"
      aria-hidden
    >
      <path d="M6.5 4.5 3 8v1.5h3.25A4.75 4.75 0 0 1 11 14.25V16l3.5-3.5L11 9v1.75A3.25 3.25 0 0 0 6.5 4.5Z" />
    </svg>
  );
}

export interface CommentReplyPreviewProps {
  preview: string;
  /** composer = banner phía trên ô nhập; bubble = khối quote trong tin nhắn */
  variant?: 'composer' | 'bubble-in' | 'bubble-out';
  label?: string;
  onClick?: () => void;
  className?: string;
  actions?: ReactNode;
}

export function CommentReplyPreview({
  preview,
  variant = 'composer',
  label = 'Trả lời bình luận',
  onClick,
  className = '',
  actions,
}: CommentReplyPreviewProps) {
  const text = preview.trim() || 'Bình luận';

  if (variant === 'composer') {
    return (
      <div
        className={`flex w-full items-start gap-2 rounded-xl border border-[#fcd34d] bg-[#fffbeb] px-3 py-2 ${className}`}
      >
        <button
          type="button"
          onClick={onClick}
          disabled={!onClick}
          className="flex min-w-0 flex-1 items-start gap-2 text-left transition hover:opacity-90 disabled:cursor-default"
        >
          <ReplyIcon className="mt-0.5 h-4 w-4 shrink-0 text-[#b45309]" />
          <span className="min-w-0 flex-1">
            <span className="block text-[10px] font-semibold uppercase tracking-wide text-[#b45309]">
              {label}
            </span>
            <span className="mt-0.5 block line-clamp-3 text-sm leading-snug text-[#78350f]">
              {text}
            </span>
          </span>
        </button>
        {actions}
      </div>
    );
  }

  const isOut = variant === 'bubble-out';
  const Wrapper = onClick ? 'button' : 'div';

  return (
    <Wrapper
      type={onClick ? 'button' : undefined}
      onClick={
        onClick
          ? (e: MouseEvent) => {
              e.stopPropagation();
              onClick();
            }
          : undefined
      }
      className={`mb-2 w-full rounded-lg border-l-2 px-2 py-1.5 text-left ${
        isOut
          ? 'border-[#86efac] bg-[#f0fdf4]/80 hover:bg-[#dcfce7]'
          : 'border-[#93c5fd] bg-[#eff6ff]/90 hover:bg-[#dbeafe]'
      } ${onClick ? 'transition' : ''} ${className}`}
    >
      <p
        className={`flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wide ${
          isOut ? 'text-[#166534]' : 'text-[#1d4ed8]'
        }`}
      >
        <ReplyIcon className="h-3 w-3" />
        {label}
      </p>
      <p
        className={`mt-0.5 line-clamp-3 text-xs leading-snug ${
          isOut ? 'text-[#14532d]' : 'text-[#1e3a8a]'
        }`}
      >
        {text}
      </p>
    </Wrapper>
  );
}
