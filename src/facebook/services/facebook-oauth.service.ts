import { AppLogger } from '../../common/logger.service';
import { BadRequestException, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as crypto from 'crypto';
import got from 'got';

export interface OAuthStateData {
  orgId: string;
  friendlyName?: string;
  purpose?: string;
  notes?: string;
  credentialId?: string;
}

export interface FacebookTokenResponse {
  access_token: string;
  token_type: string;
  expires_in?: number;
}

export interface FacebookPageToken {
  pageId: string;
  pageName: string;
  pageAccessToken: string;
  pictureUrl?: string;
  category?: string;
  tasks?: string[];
}

export interface GraphConversationParticipant {
  id: string;
  name?: string;
  picture?: { data?: { url?: string } };
}

export interface GraphConversation {
  id: string;
  updated_time: string;
  snippet?: string;
  message_count?: number;
  participants?: { data: GraphConversationParticipant[] };
  messages?: { data: Array<{ from?: GraphConversationParticipant }> };
}

export interface GraphConversationMessage {
  id: string;
  message?: string;
  created_time: string;
  from?: {
    id: string;
    name?: string;
    picture?: { data?: { url?: string } };
  };
}

export interface GraphPostComment {
  id: string;
  message?: string;
  created_time: string;
  from?: GraphConversationParticipant;
  parent?: { id?: string };
}

export interface GraphFeedPost {
  id: string;
  message?: string;
  created_time?: string;
  comments?: {
    data: GraphPostComment[];
    paging?: { cursors?: { before?: string; after?: string } };
  };
}

export interface SendMessageResponse {
  recipient_id?: string;
  message_id?: string;
}

export interface CreateCommentResponse {
  id?: string;
}

export function extractGraphPictureUrl(
  node?: { picture?: { data?: { url?: string }; url?: string } } | null,
): string | null {
  return node?.picture?.data?.url ?? node?.picture?.url ?? null;
}

@Injectable()
export class FacebookOAuthService {
  private readonly oauthScopes: string[] = [
    'business_management',
    'pages_show_list',
    'pages_messaging',
    'pages_manage_metadata',
    'pages_read_engagement',
  ];

  private readonly webhookFields: string[] = [
    'feed',
    'message_deliveries',
    'message_echoes',
    'message_reads',
    'messages',
    'messaging_account_linking',
    'messaging_postbacks',
    'messaging_optins',
    'messaging_handovers',
    'messaging_policy_enforcement',
    'messaging_referrals',
    'standby',
  ];

  private readonly graphApiVersion: string;
  private readonly appId: string;
  private readonly appSecret: string;
  private readonly redirectUri: string;

  constructor(
    private readonly configService: ConfigService,
    private readonly logger: AppLogger,
  ) {
    this.graphApiVersion = 'v25.0';
    this.appId = this.configService.get<string>('FACEBOOK_APP_ID', '');
    this.appSecret = this.configService.get<string>('FACEBOOK_APP_SECRET', '');
    this.redirectUri =
      this.configService.get<string>('FACEBOOK_OAUTH_REDIRECT_URI', '') ||
      `${this.configService.get<string>('PUBLIC_BASE_URL', '').replace(/\/$/, '')}/facebook-page/oauth/callback`;
    this.logger.setContext(FacebookOAuthService.name);
    this.validateConfig();
  }

  private validateConfig(): void {
    const missingOrInvalid: string[] = [];

    if (!this.appId || this.appId === 'your_app_id') {
      missingOrInvalid.push('Thiết lập giá trị hợp lệ cho FACEBOOK_APP_ID');
    } else if (!/^\d+$/.test(this.appId)) {
      missingOrInvalid.push(
        'FACEBOOK_APP_ID (phải là chuỗi số, ví dụ: "123456789012345")',
      );
    }

    if (!this.appSecret || this.appSecret === 'your_app_secret') {
      missingOrInvalid.push('Thiết lập giá trị hợp lệ cho FACEBOOK_APP_SECRET');
    }

    if (!this.redirectUri) {
      missingOrInvalid.push('FACEBOOK_OAUTH_REDIRECT_URI');
    }

    if (missingOrInvalid.length > 0) {
      const msg =
        `[FacebookOAuthService] Thiếu hoặc sai cấu hình biến môi trường:\n` +
        missingOrInvalid.map((v) => `  ✗ ${v}`).join('\n') +
        `\n→ Kiểm tra file .env`;
      this.logger.error(msg);
      throw new Error(msg);
    }

    this.logger.log(
      `[FacebookOAuthService] Config OK — appId=${this.appId}, redirectUri=${this.redirectUri}`,
    );
  }

  buildOAuthUrl(orgId: string, meta: Omit<OAuthStateData, 'orgId'>): string {
    const stateData: OAuthStateData = { orgId, ...meta };
    const statePayload = Buffer.from(JSON.stringify(stateData)).toString(
      'base64url',
    );
    const hmac = crypto
      .createHmac('sha256', this.appSecret)
      .update(statePayload)
      .digest('base64url');
    const state = `${statePayload}.${hmac}`;

    const params = new URLSearchParams({
      client_id: this.appId,
      redirect_uri: this.redirectUri,
      scope: this.oauthScopes.join(','),
      state,
      response_type: 'code',
    });

    return `https://www.facebook.com/${this.graphApiVersion}/dialog/oauth?${params.toString()}`;
  }

  resolveState(state: string): OAuthStateData & { state: string } {
    const dotIndex = state.lastIndexOf('.');
    if (dotIndex === -1)
      throw new BadRequestException('Invalid OAuth state format');

    const statePayload = state.substring(0, dotIndex);
    const receivedHmac = state.substring(dotIndex + 1);
    const expectedHmac = crypto
      .createHmac('sha256', this.appSecret)
      .update(statePayload)
      .digest('base64url');
    if (receivedHmac !== expectedHmac) {
      throw new BadRequestException('Invalid OAuth state signature');
    }

    const stateData: OAuthStateData = JSON.parse(
      Buffer.from(statePayload, 'base64url').toString('utf-8'),
    );
    return { ...stateData, state };
  }

  async exchangeCodeForToken(
    code: string,
    redirectUri?: string,
  ): Promise<FacebookTokenResponse> {
    const uri = redirectUri || this.redirectUri;

    try {
      return await got
        .get(
          `https://graph.facebook.com/${this.graphApiVersion}/oauth/access_token`,
          {
            searchParams: {
              client_id: this.appId,
              client_secret: this.appSecret,
              redirect_uri: uri,
              code,
            },
            timeout: { request: 15_000 },
          },
        )
        .json<FacebookTokenResponse>();
    } catch (err: any) {
      const body = err?.response?.body;
      const fbError = typeof body === 'string' ? JSON.parse(body) : body;
      this.logger.error('Token exchange failed', fbError ?? err.message);
      throw this.mapFbError(fbError?.error);
    }
  }

  async extendToLongLivedToken(
    shortLivedToken: string,
  ): Promise<FacebookTokenResponse> {
    try {
      return await got
        .get(
          `https://graph.facebook.com/${this.graphApiVersion}/oauth/access_token`,
          {
            searchParams: {
              grant_type: 'fb_exchange_token',
              client_id: this.appId,
              client_secret: this.appSecret,
              fb_exchange_token: shortLivedToken,
            },
            timeout: { request: 15_000 },
          },
        )
        .json<FacebookTokenResponse>();
    } catch (err: any) {
      const body = err?.response?.body;
      const fbError = typeof body === 'string' ? JSON.parse(body) : body;
      this.logger.error('Token extension failed', fbError ?? err.message);
      throw this.mapFbError(fbError?.error);
    }
  }

  async getPageTokens(userAccessToken: string): Promise<FacebookPageToken[]> {
    try {
      const response = await got
        .get(`https://graph.facebook.com/${this.graphApiVersion}/me/accounts`, {
          searchParams: {
            access_token: userAccessToken,
            fields: 'id,name,access_token,category,tasks,picture{url}',
          },
          timeout: { request: 15_000 },
        })
        .json<{ data: any[] }>();

      this.logger.log(
        `[FacebookOAuthService] Fetched ${response.data?.length ?? 0} pages from /me/accounts`,
      );

      return (response.data ?? []).map((p) => ({
        pageId: p.id,
        pageName: p.name,
        pageAccessToken: p.access_token,
        pictureUrl: p.picture?.data?.url as string | undefined,
        category: p.category,
        tasks: p.tasks,
      }));
    } catch (err: any) {
      const body = err?.response?.body;
      const fbError =
        typeof body === 'string'
          ? body.startsWith('{')
            ? JSON.parse(body)
            : { message: body }
          : body;
      this.logger.error('Failed to fetch page tokens', fbError ?? err.message);
      throw this.mapFbError(fbError?.error);
    }
  }

  async getPagePictureUrl(
    pageId: string,
    accessToken: string,
  ): Promise<string | undefined> {
    return this.getProfilePictureUrl(pageId, accessToken);
  }

  async getConversationParticipantPicture(
    pageId: string,
    psid: string,
    accessToken: string,
  ): Promise<string | undefined> {
    if (!pageId || !psid || !accessToken) return undefined;

    try {
      const response = await got
        .get(
          `https://graph.facebook.com/${this.graphApiVersion}/${pageId}/conversations`,
          {
            searchParams: {
              access_token: accessToken,
              platform: 'messenger',
              user_id: psid,
              fields: 'participants{id,picture.type(large)}',
            },
            timeout: { request: 10_000 },
          },
        )
        .json<{
          data?: Array<{
            participants?: { data?: GraphConversationParticipant[] };
          }>;
        }>();

      const customer = response.data?.[0]?.participants?.data?.find(
        (p) => p.id === psid,
      );
      return extractGraphPictureUrl(customer) ?? undefined;
    } catch {
      return undefined;
    }
  }

  async getMessengerUserProfile(
    userId: string,
    accessToken: string,
  ): Promise<{ name?: string; pictureUrl?: string } | undefined> {
    if (!userId || !accessToken) return undefined;

    try {
      const profile = await got
        .get(`https://graph.facebook.com/${this.graphApiVersion}/${userId}`, {
          searchParams: {
            access_token: accessToken,
            fields: 'first_name,last_name,name,profile_pic',
          },
          timeout: { request: 10_000 },
        })
        .json<{
          name?: string;
          first_name?: string;
          last_name?: string;
          profile_pic?: string;
        }>();

      const name =
        profile.name?.trim() ||
        [profile.first_name, profile.last_name].filter(Boolean).join(' ').trim() ||
        undefined;

      return {
        name: name || undefined,
        pictureUrl: profile.profile_pic,
      };
    } catch (err: any) {
      this.logger.warn(
        `Failed to fetch profile for user ${userId}`,
        err?.message ?? err,
      );
      return undefined;
    }
  }

  async getProfilePictureUrl(
    userId: string,
    accessToken: string,
    pageId?: string,
  ): Promise<string | undefined> {
    const profile = await this.getMessengerUserProfile(userId, accessToken);
    if (profile?.pictureUrl) return profile.pictureUrl;

    if (!userId || !accessToken) return undefined;

    try {
      const response = await got
        .get(
          `https://graph.facebook.com/${this.graphApiVersion}/${userId}/picture`,
          {
            searchParams: {
              access_token: accessToken,
              redirect: '0',
              type: 'large',
            },
            timeout: { request: 10_000 },
          },
        )
        .json<{ data?: { url?: string } }>();

      return response.data?.url;
    } catch (err: any) {
      const body = err?.response?.body;
      const fbError =
        typeof body === 'string'
          ? body.startsWith('{')
            ? JSON.parse(body)
            : { message: body }
          : body;
      this.logger.warn(
        `Failed to fetch picture for user ${userId}`,
        fbError ?? err.message,
      );
    }

    if (pageId) {
      return this.getConversationParticipantPicture(
        pageId,
        userId,
        accessToken,
      );
    }

    return undefined;
  }

  async getProfilePicturesBatch(
    userIds: string[],
    accessToken: string,
    pageId?: string,
  ): Promise<Map<string, string | null>> {
    const result = new Map<string, string | null>();
    const unique = [...new Set(userIds.filter(Boolean))];
    if (!unique.length || !accessToken) return result;

    for (const id of unique) {
      const url = await this.getProfilePictureUrl(id, accessToken, pageId);
      result.set(id, url ?? null);
      await new Promise((resolve) => setTimeout(resolve, 80));
    }

    return result;
  }

  async getPost(
    postId: string,
    accessToken: string,
  ): Promise<{
    id?: string;
    message?: string;
    story?: string;
    permalink_url?: string;
    full_picture?: string;
    created_time?: string;
    from?: { name?: string };
  } | null> {
    if (!postId || !accessToken) return null;

    try {
      return await got
        .get(`https://graph.facebook.com/${this.graphApiVersion}/${postId}`, {
          searchParams: {
            access_token: accessToken,
            fields:
              'id,message,story,permalink_url,full_picture,created_time,from{name}',
          },
          timeout: { request: 15_000 },
        })
        .json();
    } catch (err: any) {
      const body = err?.response?.body;
      const fbError =
        typeof body === 'string'
          ? body.startsWith('{')
            ? JSON.parse(body)
            : { message: body }
          : body;
      this.logger.warn(
        `Failed to fetch post ${postId}`,
        fbError ?? err.message,
      );
      return null;
    }
  }

  async listPageConversations(
    pageId: string,
    accessToken: string,
    limit = 25,
  ): Promise<GraphConversation[]> {
    if (!pageId || !accessToken) return [];

    try {
      const response = await got
        .get(
          `https://graph.facebook.com/${this.graphApiVersion}/${pageId}/conversations`,
          {
            searchParams: {
              access_token: accessToken,
              platform: 'messenger',
              fields:
                'id,updated_time,participants{id,name,picture.type(large)},messages.limit(3){from{id,name,picture.type(large)}},snippet,message_count',
              limit,
            },
            timeout: { request: 15_000 },
          },
        )
        .json<{ data: GraphConversation[] }>();

      return response.data ?? [];
    } catch (err: any) {
      const body = err?.response?.body;
      const fbError =
        typeof body === 'string'
          ? body.startsWith('{')
            ? JSON.parse(body)
            : { message: body }
          : body;
      this.logger.warn(
        `Failed to list conversations for page ${pageId}`,
        fbError ?? err.message,
      );
      return [];
    }
  }

  async getMessengerMessagesByPsid(
    pageId: string,
    psid: string,
    accessToken: string,
    options?: { limit?: number; before?: string },
  ): Promise<{
    messages: GraphConversationMessage[];
    paging?: { cursors?: { before?: string; after?: string } };
  }> {
    if (!pageId || !psid || !accessToken) {
      return { messages: [] };
    }

    const limit = options?.limit ?? 15;
    let messagesField = `messages.limit(${limit}){message,from{id,name,picture{url}},created_time,id}`;
    if (options?.before) {
      messagesField = `messages.limit(${limit}).before(${options.before}){message,from{id,name,picture{url}},created_time,id}`;
    }

    try {
      const response = await got
        .get(
          `https://graph.facebook.com/${this.graphApiVersion}/${pageId}/conversations`,
          {
            searchParams: {
              access_token: accessToken,
              platform: 'messenger',
              user_id: psid,
              fields: messagesField,
            },
            timeout: { request: 15_000 },
          },
        )
        .json<{
          data: Array<{
            messages?: {
              data: GraphConversationMessage[];
              paging?: { cursors?: { before?: string; after?: string } };
            };
          }>;
        }>();

      const block = response.data?.[0]?.messages;
      return {
        messages: block?.data ?? [],
        paging: block?.paging,
      };
    } catch (err: any) {
      const body = err?.response?.body;
      const fbError =
        typeof body === 'string'
          ? body.startsWith('{')
            ? JSON.parse(body)
            : { message: body }
          : body;
      this.logger.warn(
        `Failed to fetch messages for PSID ${psid} on page ${pageId}`,
        fbError ?? err.message,
      );
      return { messages: [] };
    }
  }

  async listPageFeedWithComments(
    pageId: string,
    accessToken: string,
    limit = 15,
  ): Promise<GraphFeedPost[]> {
    if (!pageId || !accessToken) return [];

    try {
      const response = await got
        .get(
          `https://graph.facebook.com/${this.graphApiVersion}/${pageId}/feed`,
          {
            searchParams: {
              access_token: accessToken,
              fields:
                'id,message,created_time,comments.limit(50){id,message,from{id,name,picture.type(large)},created_time,parent{id}}',
              limit,
            },
            timeout: { request: 15_000 },
          },
        )
        .json<{ data: GraphFeedPost[] }>();

      return response.data ?? [];
    } catch (err: any) {
      const body = err?.response?.body;
      const fbError =
        typeof body === 'string'
          ? body.startsWith('{')
            ? JSON.parse(body)
            : { message: body }
          : body;
      this.logger.warn(
        `Failed to list feed comments for page ${pageId}`,
        fbError ?? err.message,
      );
      return [];
    }
  }

  async getPostComments(
    postId: string,
    accessToken: string,
    options?: { limit?: number; before?: string },
  ): Promise<{
    comments: GraphPostComment[];
    paging?: { cursors?: { before?: string; after?: string } };
  }> {
    if (!postId || !accessToken) {
      return { comments: [] };
    }

    const limit = options?.limit ?? 50;
    const searchParams: Record<string, string | number> = {
      access_token: accessToken,
      fields:
        'id,message,from{id,name,picture.type(large)},created_time,parent{id}',
      limit,
      filter: 'stream',
      order: 'chronological',
    };

    if (options?.before) {
      searchParams.before = options.before;
    }

    try {
      const response = await got
        .get(
          `https://graph.facebook.com/${this.graphApiVersion}/${postId}/comments`,
          {
            searchParams,
            timeout: { request: 15_000 },
          },
        )
        .json<{
          data: GraphPostComment[];
          paging?: { cursors?: { before?: string; after?: string } };
        }>();

      return {
        comments: response.data ?? [],
        paging: response.paging,
      };
    } catch (err: any) {
      const body = err?.response?.body;
      const fbError =
        typeof body === 'string'
          ? body.startsWith('{')
            ? JSON.parse(body)
            : { message: body }
          : body;
      this.logger.warn(
        `Failed to fetch comments for post ${postId}`,
        fbError ?? err.message,
      );
      return { comments: [] };
    }
  }

  async getMe(accessToken: string): Promise<{ id: string; name: string }> {
    try {
      return await got
        .get(`https://graph.facebook.com/${this.graphApiVersion}/me`, {
          searchParams: {
            access_token: accessToken,
            fields: 'id,name',
          },
          timeout: { request: 10_000 },
        })
        .json<{ id: string; name: string }>();
    } catch (err: any) {
      const body = err?.response?.body;
      const fbError = typeof body === 'string' ? JSON.parse(body) : body;
      this.logger.error('Failed to fetch user profile', fbError ?? err.message);
      throw this.mapFbError(fbError?.error);
    }
  }

  private mapFbError(error: any): Error {
    if (!error) return new Error('Facebook API request failed');

    const { code, message } = error;

    if (code === 190)
      return new BadRequestException(`Token invalid or expired: ${message}`);
    if (code === 10 || code === 200)
      return new BadRequestException(`Permission denied: ${message}`);
    if (code === 4 || code === 17 || code === 32) {
      return new BadRequestException(`Rate limit exceeded: ${message}`);
    }

    return new BadRequestException(`Facebook API error [${code}]: ${message}`);
  }

  async revokeUserToken(userAccessToken: string): Promise<void> {
    if (!userAccessToken) return;
    try {
      await got.delete(
        `https://graph.facebook.com/${this.graphApiVersion}/me/permissions`,
        {
          searchParams: { access_token: userAccessToken },
          timeout: { request: 10_000 },
        },
      );
    } catch (err: any) {
      this.logger.warn(
        '[FacebookOAuthService] revokeUserToken failed (ignored):',
        err?.message,
      );
    }
  }

  async subscribeToPageWebhook(
    pageId: string,
    pageAccessToken: string,
  ): Promise<boolean> {
    if (!pageId || !pageAccessToken) return false;

    try {
      const response = await got
        .post(
          `https://graph.facebook.com/${this.graphApiVersion}/${pageId}/subscribed_apps`,
          {
            searchParams: {
              access_token: pageAccessToken,
              subscribed_fields: this.webhookFields.join(','),
            },
            timeout: { request: 15_000 },
          },
        )
        .json<{ success: boolean }>();

      if (response.success) {
        this.logger.log(
          `[FacebookOAuthService] Subscribed webhooks for page ${pageId} successfully`,
        );
        return true;
      }
      this.logger.warn(
        `[FacebookOAuthService] Failed to subscribe Facebook webhook for page ${pageId}`,
      );
      return false;
    } catch (err: any) {
      const body = err?.response?.body;
      const fbError =
        typeof body === 'string'
          ? body.startsWith('{')
            ? JSON.parse(body)
            : { message: body }
          : body;
      this.logger.error(
        `Failed to subscribe Facebook webhook for page ${pageId}`,
        fbError ?? err.message,
      );
      return false;
    }
  }

  async unsubscribeFromPageWebhook(
    pageId: string,
    pageAccessToken: string,
  ): Promise<boolean> {
    if (!pageId || !pageAccessToken) return false;

    try {
      await got.delete(
        `https://graph.facebook.com/${this.graphApiVersion}/${pageId}/subscribed_apps`,
        {
          searchParams: { access_token: pageAccessToken },
          timeout: { request: 15_000 },
        },
      );
      return true;
    } catch (err: any) {
      const fbError = err?.response?.body && JSON.parse(err.response.body);
      this.logger.error(
        'Failed to unsubscribe Facebook webhook',
        fbError ?? err.message,
      );
      return false;
    }
  }

  private async postMessageToPsid(
    psid: string,
    pageAccessToken: string,
    message: Record<string, unknown>,
  ): Promise<SendMessageResponse> {
    if (!psid || !pageAccessToken) {
      throw new BadRequestException('Missing psid or pageAccessToken');
    }

    try {
      return await got
        .post(
          `https://graph.facebook.com/${this.graphApiVersion}/me/messages`,
          {
            searchParams: { access_token: pageAccessToken },
            json: {
              messaging_type: 'RESPONSE',
              recipient: { id: psid },
              message,
            },
            timeout: { request: 15_000 },
          },
        )
        .json<SendMessageResponse>();
    } catch (err: any) {
      const body = err?.response?.body;
      const fbError =
        typeof body === 'string'
          ? body.startsWith('{')
            ? JSON.parse(body)
            : { message: body }
          : body;
      this.logger.error(
        `Failed to send message to PSID ${psid}`,
        fbError ?? err.message,
      );
      throw this.mapFbError(fbError?.error);
    }
  }

  async sendTextMessageToPsid(
    psid: string,
    pageAccessToken: string,
    text: string,
  ): Promise<SendMessageResponse> {
    if (!text?.trim()) {
      throw new BadRequestException('Message text is empty');
    }

    return this.postMessageToPsid(psid, pageAccessToken, { text });
  }

  async sendAttachmentMessageToPsid(
    psid: string,
    pageAccessToken: string,
    attachment: { type: 'image' | 'video' | 'audio' | 'file'; url: string },
  ): Promise<SendMessageResponse> {
    if (!attachment?.url?.trim()) {
      throw new BadRequestException('Attachment url is empty');
    }

    return this.postMessageToPsid(psid, pageAccessToken, {
      attachment: {
        type: attachment.type,
        payload: {
          url: attachment.url,
          is_reusable: true,
        },
      },
    });
  }

  async replyToComment(
    commentId: string,
    pageAccessToken: string,
    message: string,
  ): Promise<CreateCommentResponse> {
    if (!commentId?.trim()) {
      throw new BadRequestException('Missing commentId');
    }
    if (!pageAccessToken?.trim()) {
      throw new BadRequestException('Missing pageAccessToken');
    }
    if (!message?.trim()) {
      throw new BadRequestException('Reply message is empty');
    }

    try {
      return await got
        .post(
          `https://graph.facebook.com/${this.graphApiVersion}/${commentId}/comments`,
          {
            searchParams: {
              access_token: pageAccessToken,
              message,
            },
            timeout: { request: 15_000 },
          },
        )
        .json<CreateCommentResponse>();
    } catch (err: any) {
      const body = err?.response?.body;
      const fbError =
        typeof body === 'string'
          ? body.startsWith('{')
            ? JSON.parse(body)
            : { message: body }
          : body;
      this.logger.error(
        `Failed to reply comment ${commentId}`,
        fbError ?? err.message,
      );
      throw this.mapFbError(fbError?.error);
    }
  }
}
