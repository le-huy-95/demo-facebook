'use client';

import { useMemo } from 'react';
import {
  collectMentionTargets,
  parseMentionSegments,
  type MentionTarget,
} from '@/lib/mentions';
import type { WebhookMessage } from '@/lib/api';

const URL_SPLIT_REGEX = /(https?:\/\/[^\s]+)/g;

function isHttpUrl(text: string): boolean {
  return /^https?:\/\//i.test(text);
}

function normalizeUrl(raw: string): string {
  return raw.replace(/[)\].,;!?]+$/, '');
}

function LinkifiedPlainText({
  text,
  className,
}: {
  text: string;
  className?: string;
}) {
  const parts = text.split(URL_SPLIT_REGEX);

  return (
    <>
      {parts.map((part, index) => {
        if (!part) return null;
        if (isHttpUrl(part)) {
          const href = normalizeUrl(part);
          return (
            <a
              key={`${href}-${index}`}
              href={href}
              target="_blank"
              rel="noopener noreferrer"
              className="break-all text-[#2563eb] underline hover:text-[#1d4ed8]"
              onClick={(e) => e.stopPropagation()}
            >
              {part}
            </a>
          );
        }
        return <span key={`text-${index}`}>{part}</span>;
      })}
    </>
  );
}

export interface MentionTextProps {
  text: string;
  className?: string;
  mentionTargets?: MentionTarget[];
  pageId?: string;
  pageName?: string;
  customerName?: string;
  customerSenderId?: string;
  postPermalinkUrl?: string | null;
  messages?: WebhookMessage[];
}

export function MentionText({
  text,
  className,
  mentionTargets,
  pageId,
  pageName,
  customerName,
  customerSenderId,
  postPermalinkUrl,
  messages,
}: MentionTextProps) {
  const targets = useMemo(
    () =>
      mentionTargets ??
      collectMentionTargets({
        pageId,
        pageName,
        customerName,
        customerSenderId,
        postPermalinkUrl,
        messages,
      }),
    [
      mentionTargets,
      pageId,
      pageName,
      customerName,
      customerSenderId,
      postPermalinkUrl,
      messages,
    ],
  );

  const segments = useMemo(
    () => parseMentionSegments(text, targets),
    [text, targets],
  );

  return (
    <span className={className}>
      {segments.map((segment, index) => {
        if (segment.type === 'mention') {
          return (
            <a
              key={`mention-${index}-${segment.value}`}
              href={segment.facebookUrl}
              target="_blank"
              rel="noopener noreferrer"
              className={`font-bold underline decoration-[#111827]/40 hover:decoration-[#111827] ${
                segment.kind === 'comment'
                  ? 'text-[#1d4ed8]'
                  : 'text-[#111827]'
              }`}
              onClick={(e) => e.stopPropagation()}
            >
              {segment.value}
            </a>
          );
        }

        return (
          <LinkifiedPlainText
            key={`text-${index}`}
            text={segment.value}
          />
        );
      })}
    </span>
  );
}
