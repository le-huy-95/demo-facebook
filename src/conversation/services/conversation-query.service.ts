import { Injectable, Inject, forwardRef, Logger } from '@nestjs/common';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { MessageRepository } from '../../infrastructure/persistence/repositories/message.repository';
import { ConversationRepository } from '../../infrastructure/persistence/repositories/conversation.repository';
import { FacebookRepoService } from '../../facebook/services/facebook-repo.service';
import { ConversationsService } from '../../facebook/services/conversations.service';
import { parseThreadId } from '../../facebook/utils/conversation-thread.util';

function parseDateCursor(cursor: string | undefined): Date | null {
  if (!cursor) return null;
  const date = new Date(cursor);
  return Number.isNaN(date.getTime()) ? null : date;
}

/**
 * Đọc lịch sử tin nhắn từ DB (message_history) — không gọi Facebook Graph API.
 * Tương đương ConversationQueryService trong apps/forward của top.ai_chat.
 */
@Injectable()
export class ConversationQueryService {
  private readonly logger = new Logger(ConversationQueryService.name);

  constructor(
    private readonly messageRepo: MessageRepository,
    private readonly conversationRepo: ConversationRepository,
    private readonly facebookRepo: FacebookRepoService,
    @Inject(forwardRef(() => ConversationsService))
    private readonly conversationsService: ConversationsService,
  ) {}

  async listConversations(
    pageId: string,
    orgId: string,
    options?: { limit?: number; before?: string },
  ) {
    return this.conversationsService.listByPage(pageId, orgId, options);
  }

  async getMessageHistory(
    pageId: string,
    orgId: string,
    threadId: string,
    options?: { limit?: number; before?: string },
  ) {
    const parsed = parseThreadId(threadId);
    if (!parsed || parsed.pageId !== pageId) {
      throw new NotFoundException('Cuộc trò chuyện không hợp lệ');
    }

    await this.assertPageBelongsToOrg(pageId, orgId);

    const limit = options?.limit ?? 15;
    const beforeDate = parseDateCursor(options?.before);

    const { messages, hasMore } = await this.messageRepo.getMessageHistory(
      threadId,
      pageId,
      orgId,
      { limit, before: beforeDate ?? undefined },
    );

    const enriched = await this.conversationsService.enrichMessagesForDisplay(
      messages,
      pageId,
      orgId,
      parsed.senderId,
    );

    await this.conversationRepo.markThreadRead(pageId, orgId, threadId);

    const oldest = enriched[0];
    return {
      pageId,
      threadId,
      messages: enriched.map((e) => ({
        ...e,
        createdAt:
          e.createdAt instanceof Date
            ? e.createdAt.toISOString()
            : String(e.createdAt),
      })),
      paging: {
        hasMore,
        nextBefore: hasMore && oldest ? oldest.createdAt.toISOString() : null,
      },
    };
  }

  private async assertPageBelongsToOrg(pageId: string, orgId: string) {
    if (!pageId?.trim()) {
      throw new BadRequestException('Thiếu pageId');
    }
    const pages = await this.facebookRepo.listPages(orgId);
    const page = pages.find((p) => p.pageId === pageId);
    if (!page) {
      throw new NotFoundException('Fanpage không tồn tại hoặc chưa liên kết');
    }
    return page;
  }
}
