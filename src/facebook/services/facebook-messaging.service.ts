import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { WebhookEvent } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { FacebookRepoService } from './facebook-repo.service';
import { FacebookOAuthService } from './facebook-oauth.service';
import { PageMapService } from './page-map.service';
import { ConfigService } from '@nestjs/config';
import { RedisCacheService } from '../../redis/redis-cache.service';
import { parseThreadId } from '../utils/conversation-thread.util';

export interface OutboundAttachment {
  type: 'image' | 'video' | 'audio' | 'file';
  url: string;
}

@Injectable()
export class FacebookMessagingService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly facebookRepo: FacebookRepoService,
    private readonly facebookOAuth: FacebookOAuthService,
    private readonly pageMapService: PageMapService,
    private readonly configService: ConfigService,
    private readonly redisCache: RedisCacheService,
  ) {}

  private getDefaultOrgId(): string {
    return this.configService.get<string>('DEFAULT_ORG_ID', 'default-org');
  }

  private async resolvePageAccessToken(
    pageId: string,
    orgId: string,
  ): Promise<string> {
    const pages = await this.facebookRepo.listPages(orgId);
    const page = pages.find((p) => p.pageId === pageId);
    if (!page?.pageAccessToken) {
      throw new NotFoundException(
        'Fanpage chưa liên kết hoặc thiếu page access token',
      );
    }
    return page.pageAccessToken;
  }

  private buildOutboundContent(
    text: string,
    attachment?: OutboundAttachment,
  ): { msgType: string; content: string } {
    if (!attachment) {
      return { msgType: 'webchat', content: text };
    }

    const previewByType: Record<OutboundAttachment['type'], string> = {
      image: '[Hình ảnh]',
      video: '[Video]',
      audio: '[Audio]',
      file: '[Tệp đính kèm]',
    };

    const msgTypeByType: Record<OutboundAttachment['type'], string> = {
      image: 'chat.photo',
      video: 'chat.video.msg',
      audio: 'chat.video.msg',
      file: 'share.file',
    };

    const fileObj = {
      title: previewByType[attachment.type],
      description: text || '',
      href: attachment.url,
      thumb: attachment.type === 'image' ? attachment.url : '',
      childnumber: 0,
      action: '',
      params: JSON.stringify({
        fileSize: '0',
        fileExt: attachment.type,
        checksum: '',
        fType: attachment.type === 'file' ? 2 : 1,
      }),
      type: attachment.type,
    };

    return {
      msgType: msgTypeByType[attachment.type],
      content: JSON.stringify(fileObj),
    };
  }

  async sendToThread(input: {
    pageId: string;
    threadId: string;
    text?: string;
    attachment?: OutboundAttachment;
    commentId?: string;
    clientMessageId?: string;
  }): Promise<{
    savedEvent: WebhookEvent;
    fb: { recipientId?: string; messageId?: string };
  }> {
    const pageId = input.pageId?.trim();
    const threadId = input.threadId?.trim();
    const text = (input.text ?? '').trim();
    const attachment = input.attachment;

    if (!pageId) throw new BadRequestException('Missing pageId');
    if (!threadId) throw new BadRequestException('Missing threadId');
    if (!text && !attachment) {
      throw new BadRequestException('Message text or attachment is required');
    }

    const parsed = parseThreadId(threadId);
    if (!parsed || parsed.pageId !== pageId) {
      throw new BadRequestException('Thread không hợp lệ');
    }

    const map = this.pageMapService.getSocialMap(pageId);
    const orgId = map?.orgId ?? this.getDefaultOrgId();
    const pageAccessToken = await this.resolvePageAccessToken(pageId, orgId);

    if (parsed.kind === 'FEED_COMMENT') {
      const replyText = text;
      if (!replyText) {
        throw new BadRequestException('Reply text is required for comments');
      }

      const targetCommentId = input.commentId?.trim()
        ? input.commentId.trim()
        : await this.resolveLatestInboundCommentId({
            pageId,
            postId: parsed.postId!,
            customerId: parsed.senderId,
          });

      if (!targetCommentId) {
        throw new NotFoundException('Không tìm thấy commentId để phản hồi');
      }

      const fbResp = await this.facebookOAuth.replyToComment(
        targetCommentId,
        pageAccessToken,
        replyText,
      );

      // IMPORTANT: For FEED_COMMENT thread grouping, keep senderId as customerId (parsed.senderId)
      // so buildThreadId/buildThreadEventWhere keep working for the same conversation thread.
      const saved = await this.prisma.webhookEvent.create({
        data: {
          organizationId: orgId,
          pageId,
          eventType: 'FEED_COMMENT',
          direction: 'OUT',
          senderId: parsed.senderId,
          senderName: 'Page',
          recipientId: pageId,
          messageId: fbResp.id ?? null,
          postId: parsed.postId ?? null,
          commentId: fbResp.id ?? null,
          msgType: 'feed.comment.reply',
          content: replyText,
          rawPayload: JSON.stringify({
            source: 'socket_send',
            clientMessageId: input.clientMessageId ?? null,
            targetCommentId,
            fb: fbResp,
          }),
        },
      });

      await this.redisCache.bumpThreadRevision(pageId, threadId);

      return {
        savedEvent: saved,
        fb: { recipientId: undefined, messageId: fbResp.id },
      };
    }

    if (parsed.kind !== 'MESSENGER') {
      throw new BadRequestException('Thread kind không được hỗ trợ');
    }

    const fbResp = attachment
      ? await this.facebookOAuth.sendAttachmentMessageToPsid(
          parsed.senderId,
          pageAccessToken,
          attachment,
        )
      : await this.facebookOAuth.sendTextMessageToPsid(
          parsed.senderId,
          pageAccessToken,
          text,
        );

    const { msgType, content } = this.buildOutboundContent(text, attachment);

    const saved = await this.prisma.webhookEvent.create({
      data: {
        organizationId: orgId,
        pageId,
        eventType: 'MESSENGER',
        direction: 'OUT',
        senderId: pageId,
        senderName: 'Page',
        recipientId: parsed.senderId,
        messageId: fbResp.message_id ?? null,
        postId: null,
        commentId: null,
        msgType,
        content: attachment ? content : text,
        rawPayload: JSON.stringify({
          source: 'socket_send',
          clientMessageId: input.clientMessageId ?? null,
          attachment: attachment ?? null,
          fb: fbResp,
        }),
      },
    });

    await this.redisCache.bumpThreadRevision(pageId, threadId);

    return {
      savedEvent: saved,
      fb: { recipientId: fbResp.recipient_id, messageId: fbResp.message_id },
    };
  }

  async sendTextToThread(input: {
    pageId: string;
    threadId: string;
    text: string;
    clientMessageId?: string;
  }) {
    return this.sendToThread(input);
  }

  private async resolveLatestInboundCommentId(input: {
    pageId: string;
    postId: string;
    customerId: string;
  }): Promise<string | null> {
    const row = await this.prisma.webhookEvent.findFirst({
      where: {
        pageId: input.pageId,
        eventType: 'FEED_COMMENT',
        direction: 'IN',
        postId: input.postId,
        senderId: input.customerId,
        commentId: { not: null },
      },
      orderBy: { createdAt: 'desc' },
      select: { commentId: true },
    });

    return row?.commentId ?? null;
  }
}
