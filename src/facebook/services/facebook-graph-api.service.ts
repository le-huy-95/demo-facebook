import { Injectable } from '@nestjs/common';
import { AppLogger } from '../../common/logger.service';
import {
  FacebookOAuthService,
  type SendMessageResponse,
} from './facebook-oauth.service';

/**
 * Facebook Graph API — chỉ dùng cho gửi tin, upload file, moderation.
 * Không có endpoint đọc conversation/messages từ Facebook.
 */
@Injectable()
export class FacebookGraphApiService {
  constructor(
    private readonly oauth: FacebookOAuthService,
    private readonly logger: AppLogger,
  ) {
    this.logger.setContext(FacebookGraphApiService.name);
  }

  async sendTextMessage(
    psid: string,
    pageAccessToken: string,
    text: string,
    replyToMessageId?: string,
  ): Promise<SendMessageResponse> {
    return this.oauth.sendTextMessageToPsid(
      psid,
      pageAccessToken,
      text,
      replyToMessageId,
    );
  }

  async sendAttachmentMessage(
    psid: string,
    pageAccessToken: string,
    attachment: { type: 'image' | 'video' | 'audio' | 'file'; url: string },
    replyToMessageId?: string,
  ): Promise<SendMessageResponse> {
    return this.oauth.sendAttachmentMessageToPsid(
      psid,
      pageAccessToken,
      attachment,
      replyToMessageId,
    );
  }

  async replyToComment(
    commentId: string,
    pageAccessToken: string,
    text: string,
  ): Promise<{ id?: string }> {
    return this.oauth.replyToComment(commentId, pageAccessToken, text);
  }

  async createPostComment(
    postId: string,
    pageAccessToken: string,
    text: string,
  ): Promise<{ id?: string }> {
    return this.oauth.createPostComment(postId, pageAccessToken, text);
  }

  async likeComment(
    commentId: string,
    pageAccessToken: string,
  ): Promise<{ success: boolean }> {
    return this.oauth.likeComment(commentId, pageAccessToken);
  }

  async setCommentHidden(
    commentId: string,
    pageAccessToken: string,
    isHidden: boolean,
  ): Promise<{ success: boolean }> {
    return this.oauth.setCommentHidden(commentId, pageAccessToken, isHidden);
  }
}
