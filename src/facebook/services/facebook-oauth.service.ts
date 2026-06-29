import { AppLogger } from '../../common/logger.service';
import { BadRequestException, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as crypto from 'crypto';
import got from 'got';
import { isValidFacebookCommentId } from '../utils/facebook-comment-id.util';

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

export interface GraphCommentAttachment {
  type?: string;
  url?: string;
  title?: string;
  media?: {
    image?: { src?: string; width?: number; height?: number };
    source?: string;
  };
  target?: { url?: string };
}

export interface GraphPostComment {
  id: string;
  message?: string;
  created_time: string;
  is_hidden?: boolean;
  from?: GraphConversationParticipant;
  parent?: { id?: string };
  attachment?: GraphCommentAttachment;
}

/** Fields Graph API cho comment — gồm ảnh/sticker đính kèm. */
export const GRAPH_COMMENT_FIELDS =
  'id,message,from{id,name,picture},created_time,parent{id},is_hidden,attachment{type,url,title,media,target}';

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
  /** Quyền tối thiểu để đọc/trả lời bình luận trên bài viết fanpage. */
  static readonly COMMENT_SCOPES = [
    'pages_read_user_content',
    'pages_manage_engagement',
  ] as const;

  private readonly oauthScopes: string[] = [
    'business_management',
    'pages_show_list',
    'pages_messaging',
    'pages_manage_metadata',
    'pages_manage_engagement',
    'pages_manage_posts',
    'pages_read_engagement',
    'pages_read_user_content',
    'pages_manage_engagement',
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

  /** Field webhook bắt buộc để nhận comment realtime (Meta: Pages API → field `feed`). */
  static readonly COMMENT_WEBHOOK_FIELDS = ['feed'] as const;

  private readonly graphApiVersion: string;
  private readonly appId: string;
  private readonly appSecret: string;
  private readonly redirectUri: string;

  private appWebhookRegisteredAt = 0;
  private static readonly APP_WEBHOOK_COOLDOWN_MS = 60_000;

  constructor(
    private readonly configService: ConfigService,
    private readonly logger: AppLogger,
  ) {
    this.graphApiVersion = 'v24.0';
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
      auth_type: 'rerequest',
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
    limit = 50,
  ): Promise<GraphFeedPost[]> {
    if (!pageId || !accessToken) return [];

    try {
      const response = await got
        .get(
          `https://graph.facebook.com/${this.graphApiVersion}/${pageId}/feed`,
          {
            searchParams: {
              access_token: accessToken,
              fields: `id,message,created_time,comments.limit(100){${GRAPH_COMMENT_FIELDS}}`,
              limit,
            },
            timeout: { request: 15_000 },
          },
        )
        .json<{ data: GraphFeedPost[] }>();

      const data = response.data ?? [];
      this.logger.log(
        `[FacebookOAuth] listPageFeedWithComments: fetched ${data.length} posts for page ${pageId}`,
      );
      return data;
    } catch (err: any) {
      const body = err?.response?.body;
      this.logger.warn(
        `Failed to list feed comments for page ${pageId}. Body: ${body}`,
        err.message,
      );
      return [];
    }
  }

  async getPostComments(
    postId: string,
    accessToken: string,
    options?: {
      limit?: number;
      before?: string;
      after?: string;
      order?: 'chronological' | 'reverse_chronological';
    },
  ): Promise<{
    comments: GraphPostComment[];
    paging?: { cursors?: { before?: string; after?: string }; next?: string };
  }> {
    if (!postId || !accessToken) {
      return { comments: [] };
    }

    const limit = options?.limit ?? 50;
    const searchParams: Record<string, string | number> = {
      access_token: accessToken,
      fields: GRAPH_COMMENT_FIELDS,
      limit,
      filter: 'stream',
      // Mặc định lấy comment mới nhất trước — tránh bỏ sót thread khi bài có >100 comment
      order: options?.order ?? 'reverse_chronological',
    };

    if (options?.before) {
      searchParams.before = options.before;
    }
    if (options?.after) {
      searchParams.after = options.after;
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

      const flat = this.flattenComments(response.data ?? []);
      return {
        comments: flat,
        paging: response.paging,
      };
    } catch (err: any) {
      const body = err?.response?.body;
      this.logger.warn(
        `Failed to fetch comments for post ${postId}. Body: ${body}`,
        err.message,
      );
      return { comments: [] };
    }
  }

  /** Lấy comment của bài viết qua phân trang (tối đa maxComments). */
  async listAllPostComments(
    postId: string,
    accessToken: string,
    options?: { pageSize?: number; maxComments?: number },
  ): Promise<GraphPostComment[]> {
    const pageSize = options?.pageSize ?? 100;
    const maxComments = options?.maxComments ?? 500;
    const all: GraphPostComment[] = [];
    let after: string | undefined;

    while (all.length < maxComments) {
      const { comments, paging } = await this.getPostComments(
        postId,
        accessToken,
        {
          limit: pageSize,
          after,
          order: 'reverse_chronological',
        },
      );

      if (!comments.length) break;
      all.push(...comments);

      const nextAfter = paging?.cursors?.after;
      if (!nextAfter || nextAfter === after || comments.length < pageSize) {
        break;
      }
      after = nextAfter;
    }

    return all.slice(0, maxComments);
  }

  async getCommentMeta(
    commentId: string,
    accessToken: string,
  ): Promise<{
    id: string;
    message?: string;
    postId?: string;
    fromId?: string;
    fromName?: string;
    parentId?: string;
  } | null> {
    if (!commentId || !accessToken || !isValidFacebookCommentId(commentId)) {
      return null;
    }

    try {
      const data = await got
        .get(
          `https://graph.facebook.com/${this.graphApiVersion}/${commentId}`,
          {
            searchParams: {
              access_token: accessToken,
              fields: 'id,message,from{id,name},parent{id},post{id}',
            },
            timeout: { request: 10_000 },
          },
        )
        .json<{
          id: string;
          message?: string;
          from?: { id?: string; name?: string };
          parent?: { id?: string };
          post?: { id?: string };
        }>();

      return {
        id: data.id,
        message: data.message,
        postId: data.post?.id,
        fromId: data.from?.id,
        fromName: data.from?.name,
        parentId: data.parent?.id,
      };
    } catch (err: any) {
      const body = err?.response?.body;
      this.logger.warn(
        `Failed to fetch comment meta ${commentId}`,
        typeof body === 'string' ? body : err.message,
      );
      return null;
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

    const { code, message, fbtrace_id: fbtraceId } = error;

    if (code === 190) {
      return new BadRequestException(
        `Token Facebook hết hạn hoặc không hợp lệ. Vui lòng liên kết lại fanpage. (${message})`,
      );
    }
    if (code === 10 || code === 200) {
      return new BadRequestException(
        `Thiếu quyền Facebook để thao tác bình luận. Vui lòng vào Shops → "Liên kết lại Facebook" và cấp quyền đọc/trả lời bình luận. (${message})`,
      );
    }
    if (code === 4 || code === 17 || code === 32) {
      return new BadRequestException(`Rate limit exceeded: ${message}`);
    }
    if (code === 100) {
      return new BadRequestException(
        `Comment không tồn tại hoặc đã bị xóa trên Facebook. Hãy chọn lại bình luận của khách hàng trong thread. (${message})`,
      );
    }

    return new BadRequestException(`Facebook API error [${code}]: ${message}`);
  }

  /** Kiểm tra page token có đủ quyền đọc/trả lời bình luận không. */
  async inspectPageTokenScopes(pageAccessToken: string): Promise<{
    scopes: string[];
    missingCommentScopes: string[];
    commentPermissionsOk: boolean;
  }> {
    if (!pageAccessToken?.trim()) {
      return {
        scopes: [],
        missingCommentScopes: [...FacebookOAuthService.COMMENT_SCOPES],
        commentPermissionsOk: false,
      };
    }

    try {
      const appToken = `${this.appId}|${this.appSecret}`;
      const response = await got
        .get(
          `https://graph.facebook.com/${this.graphApiVersion}/debug_token`,
          {
            searchParams: {
              input_token: pageAccessToken,
              access_token: appToken,
            },
            timeout: { request: 10_000 },
          },
        )
        .json<{ data?: { scopes?: string[]; is_valid?: boolean } }>();

      const scopes = response.data?.scopes ?? [];
      const missingCommentScopes = FacebookOAuthService.COMMENT_SCOPES.filter(
        (scope) => !scopes.includes(scope),
      );

      return {
        scopes,
        missingCommentScopes: [...missingCommentScopes],
        commentPermissionsOk:
          Boolean(response.data?.is_valid) && missingCommentScopes.length === 0,
      };
    } catch (err: any) {
      this.logger.warn(
        `inspectPageTokenScopes failed: ${err?.message ?? err}`,
      );
      return {
        scopes: [],
        missingCommentScopes: [...FacebookOAuthService.COMMENT_SCOPES],
        commentPermissionsOk: false,
      };
    }
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

  /**
   * Register the app-level webhook callback URL with Facebook.
   * This tells Facebook WHERE to deliver webhook events for this app.
   * Uses app access token ({app_id}|{app_secret}).
   *
   * IMPORTANT: The HTTP server MUST be listening before calling this,
   * because Facebook verifies the callback URL by sending a GET request.
   *
   * Includes a 60s cooldown to avoid hitting Facebook rate limits.
   */
  async subscribeAppWebhook(): Promise<boolean> {
    const elapsed = Date.now() - this.appWebhookRegisteredAt;
    if (elapsed < FacebookOAuthService.APP_WEBHOOK_COOLDOWN_MS) {
      this.logger.debug(
        `[subscribeAppWebhook] Skipped — already registered ${Math.round(elapsed / 1000)}s ago`,
      );
      return true;
    }

    if (!this.appId || !this.appSecret) {
      this.logger.warn('[FacebookOAuthService] Cannot subscribe app webhook — missing appId or appSecret');
      return false;
    }

    const baseUrl = this.configService
      .get<string>('PUBLIC_BASE_URL', '')
      .replace(/\/$/, '');
    if (!baseUrl) {
      this.logger.warn('[FacebookOAuthService] Cannot subscribe app webhook — missing PUBLIC_BASE_URL');
      return false;
    }

    const callbackUrl = `${baseUrl}/webhook/facebook`;
    const verifyToken = this.configService.get<string>(
      'FACEBOOK_WEBHOOK_VERIFY_TOKEN',
      'dev_verify_token',
    );
    const appAccessToken = `${this.appId}|${this.appSecret}`;
    const fields = this.webhookFields.join(',');

    this.logger.log(
      `[subscribeAppWebhook] Registering callback=${callbackUrl} fields=${fields}`,
    );

    try {
      const response = await got
        .post(
          `https://graph.facebook.com/${this.graphApiVersion}/${this.appId}/subscriptions`,
          {
            searchParams: {
              object: 'page',
              callback_url: callbackUrl,
              verify_token: verifyToken,
              fields,
              access_token: appAccessToken,
            },
            timeout: { request: 20_000 },
          },
        )
        .json<{ success: boolean }>();

      if (response.success) {
        this.appWebhookRegisteredAt = Date.now();
        this.logger.log(
          `[subscribeAppWebhook] SUCCESS — callback=${callbackUrl}`,
        );
        return true;
      }
      this.logger.warn(
        `[subscribeAppWebhook] Facebook returned success=false for ${callbackUrl}`,
      );
      return false;
    } catch (err: any) {
      const body = err?.response?.body;
      let fbError: any;
      try {
        fbError = typeof body === 'string' ? JSON.parse(body) : body;
      } catch {
        fbError = body ?? err.message;
      }
      this.logger.error(
        `[subscribeAppWebhook] FAILED callback=${callbackUrl}`,
        JSON.stringify(fbError),
      );
      return false;
    }
  }

  async subscribeToPageWebhook(
    pageId: string,
    pageAccessToken: string,
  ): Promise<boolean> {
    if (!pageId || !pageAccessToken) return false;

    // Meta yêu cầu subscribe cả App-level lẫn Page-level cho cùng field
    await this.ensureAppWebhookSubscription();

    try {
      const response = await got
        .post(
          `https://graph.facebook.com/${this.graphApiVersion}/${pageId}/subscribed_apps`,
          {
            searchParams: {
              access_token: pageAccessToken,
              subscribed_fields: fields,
            },
            timeout: { request: 15_000 },
          },
        )
        .json<{ success: boolean }>();

      if (!response.success) {
        this.logger.warn(
          `[FacebookOAuthService] Failed to subscribe Facebook webhook for page ${pageId}`,
        );
        return false;
      }

      const inspection = await this.inspectPageWebhookSubscription(
        pageId,
        pageAccessToken,
      );
      if (!inspection.feedSubscribed) {
        this.logger.warn(
          `[FacebookOAuthService] Page ${pageId} chưa có field feed trong subscribed_apps. fields=${inspection.subscribedFields.join(',') || 'none'}`,
        );
        return false;
      }

      this.logger.log(
        `[FacebookOAuthService] Subscribed webhooks for page ${pageId} (feed OK)`,
      );
      return true;
    } catch (err: any) {
      const body = err?.response?.body;
      const fbError =
        typeof body === 'string'
          ? body.startsWith('{')
            ? JSON.parse(body)
            : { message: body }
          : body;
      this.logger.error(
        `[subscribeToPageWebhook] FAILED pageId=${pageId}`,
        JSON.stringify(fbError ?? err.message),
      );
      return false;
    }
  }

  /**
   * Đăng ký webhook cấp App (POST /{app-id}/subscriptions).
   * Bắt buộc song song với /{page-id}/subscribed_apps — nếu thiếu, Meta không gửi feed/comment.
   * @see https://developers.facebook.com/docs/graph-api/reference/app/subscriptions
   * @see https://developers.facebook.com/docs/pages-api/webhooks-for-pages
   */
  async ensureAppWebhookSubscription(): Promise<boolean> {
    const callbackUrl = this.getWebhookCallbackUrl();
    const verifyToken = this.configService.get<string>(
      'FACEBOOK_WEBHOOK_VERIFY_TOKEN',
      '',
    );
    if (!verifyToken?.trim()) {
      this.logger.warn(
        '[FacebookOAuth] Thiếu FACEBOOK_WEBHOOK_VERIFY_TOKEN — không đăng ký app webhook',
      );
      return false;
    }

    try {
      const response = await got
        .post(
          `https://graph.facebook.com/${this.graphApiVersion}/${this.appId}/subscriptions`,
          {
            searchParams: {
              object: 'page',
              callback_url: callbackUrl,
              verify_token: verifyToken,
              fields: this.webhookFields.join(','),
              // Bắt buộc: nếu false, Meta chỉ gửi changed_fields (không có changes.value) → mất comment
              include_values: 'true',
              access_token: this.getAppAccessToken(),
            },
            timeout: { request: 15_000 },
          },
        )
        .json<{ success?: boolean }>();

      const ok = response.success === true;
      this.logger.log(
        `[FacebookOAuth] App webhook ${ok ? 'OK' : 'FAILED'} → ${callbackUrl}`,
      );
      return ok;
    } catch (err: any) {
      const body = err?.response?.body;
      this.logger.error(
        `[FacebookOAuth] ensureAppWebhookSubscription failed: ${typeof body === 'string' ? body : err?.message}`,
      );
      return false;
    }
  }

  /** Kiểm tra app đã cài trên page và có field feed chưa. */
  async inspectPageWebhookSubscription(
    pageId: string,
    pageAccessToken: string,
  ): Promise<{
    installed: boolean;
    subscribedFields: string[];
    feedSubscribed: boolean;
    missingFields: string[];
  }> {
    const required = [...FacebookOAuthService.COMMENT_WEBHOOK_FIELDS];
    if (!pageId || !pageAccessToken) {
      return {
        installed: false,
        subscribedFields: [],
        feedSubscribed: false,
        missingFields: required,
      };
    }

    try {
      const response = await got
        .get(
          `https://graph.facebook.com/${this.graphApiVersion}/${pageId}/subscribed_apps`,
          {
            searchParams: { access_token: pageAccessToken },
            timeout: { request: 10_000 },
          },
        )
        .json<{
          data?: Array<{ id?: string; subscribed_fields?: string[] }>;
        }>();

      const app = (response.data ?? []).find((row) => row.id === this.appId);
      const fields = app?.subscribed_fields ?? [];
      const missingFields = required.filter((f) => !fields.includes(f));

      return {
        installed: !!app,
        subscribedFields: fields,
        feedSubscribed: missingFields.length === 0,
        missingFields,
      };
    } catch (err: any) {
      this.logger.warn(
        `inspectPageWebhookSubscription failed for page ${pageId}: ${err?.message ?? err}`,
      );
      return {
        installed: false,
        subscribedFields: [],
        feedSubscribed: false,
        missingFields: required,
      };
    }
  }

  private getAppAccessToken(): string {
    return `${this.appId}|${this.appSecret}`;
  }

  private getWebhookCallbackUrl(): string {
    const base = this.configService
      .get<string>('PUBLIC_BASE_URL', 'http://localhost:3000')
      .replace(/\/$/, '');
    return `${base}/webhook/facebook`;
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
    replyToMessageId?: string,
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
              ...(replyToMessageId
                ? {
                    // Send API expects reply_to at top-level payload, not inside "message".
                    reply_to: { mid: replyToMessageId },
                  }
                : {}),
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
    replyToMessageId?: string,
  ): Promise<SendMessageResponse> {
    if (!text?.trim()) {
      throw new BadRequestException('Message text is empty');
    }

    return this.postMessageToPsid(
      psid,
      pageAccessToken,
      { text },
      replyToMessageId,
    );
  }

  async sendAttachmentMessageToPsid(
    psid: string,
    pageAccessToken: string,
    attachment: { type: 'image' | 'video' | 'audio' | 'file'; url: string },
    replyToMessageId?: string,
  ): Promise<SendMessageResponse> {
    if (!attachment?.url?.trim()) {
      throw new BadRequestException('Attachment url is empty');
    }

    return this.postMessageToPsid(
      psid,
      pageAccessToken,
      {
        attachment: {
          type: attachment.type,
          payload: {
            url: attachment.url,
            is_reusable: true,
          },
        },
      },
      replyToMessageId,
    );
  }

  /** Thích bình luận (Page like comment). */
  async likeComment(
    commentId: string,
    pageAccessToken: string,
  ): Promise<{ success: boolean }> {
    if (!commentId?.trim()) {
      throw new BadRequestException('Missing commentId');
    }
    if (!isValidFacebookCommentId(commentId)) {
      throw new BadRequestException(
        'commentId không hợp lệ — cần định dạng Facebook (ví dụ: 123456_789012)',
      );
    }
    if (!pageAccessToken?.trim()) {
      throw new BadRequestException('Missing pageAccessToken');
    }

    try {
      await got.post(
        `https://graph.facebook.com/${this.graphApiVersion}/${commentId}/likes`,
        {
          searchParams: { access_token: pageAccessToken },
          timeout: { request: 15_000 },
        },
      );
      return { success: true };
    } catch (err: any) {
      const body = err?.response?.body;
      const fbError =
        typeof body === 'string'
          ? body.startsWith('{')
            ? JSON.parse(body)
            : { message: body }
          : body;
      this.logger.error(
        `Failed to like comment ${commentId}`,
        fbError ?? err.message,
      );
      throw this.mapFbError(fbError?.error);
    }
  }

  /** Ẩn / hiện bình luận trên Facebook. */
  async setCommentHidden(
    commentId: string,
    pageAccessToken: string,
    isHidden: boolean,
  ): Promise<{ success: boolean }> {
    if (!commentId?.trim()) {
      throw new BadRequestException('Missing commentId');
    }
    if (!isValidFacebookCommentId(commentId)) {
      throw new BadRequestException(
        'commentId không hợp lệ — cần định dạng Facebook (ví dụ: 123456_789012)',
      );
    }
    if (!pageAccessToken?.trim()) {
      throw new BadRequestException('Missing pageAccessToken');
    }

    try {
      await got.post(
        `https://graph.facebook.com/${this.graphApiVersion}/${commentId}`,
        {
          searchParams: {
            access_token: pageAccessToken,
            is_hidden: isHidden ? 'true' : 'false',
          },
          timeout: { request: 15_000 },
        },
      );
      return { success: true };
    } catch (err: any) {
      const body = err?.response?.body;
      const fbError =
        typeof body === 'string'
          ? body.startsWith('{')
            ? JSON.parse(body)
            : { message: body }
          : body;
      this.logger.error(
        `Failed to ${isHidden ? 'hide' : 'unhide'} comment ${commentId}`,
        fbError ?? err.message,
      );
      throw this.mapFbError(fbError?.error);
    }
  }

  async replyToComment(
    commentId: string,
    pageAccessToken: string,
    message: string,
  ): Promise<CreateCommentResponse> {
    if (!commentId?.trim()) {
      throw new BadRequestException('Missing commentId');
    }
    if (!isValidFacebookCommentId(commentId)) {
      throw new BadRequestException(
        'commentId không hợp lệ — cần định dạng Facebook (ví dụ: 123456_789012)',
      );
    }
    if (!pageAccessToken?.trim()) {
      throw new BadRequestException('Missing pageAccessToken');
    }
    if (!message?.trim()) {
      throw new BadRequestException('Reply message is empty');
    }

    const triedIds: string[] = [];
    const candidates = Array.from(
      new Set(
        [
          commentId,
          // Some sources store comment IDs as "<objectId>_<commentNumericId>".
          // For a subset of endpoints/pages, the numeric segment is required.
          commentId.includes('_') ? commentId.split('_').at(-1) ?? '' : '',
        ].filter((id) => id && id.trim()),
      ),
    );

    let lastFbError: any = null;
    for (const candidateId of candidates) {
      triedIds.push(candidateId);
      try {
        return await got
          .post(
            `https://graph.facebook.com/${this.graphApiVersion}/${candidateId}/comments`,
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
        lastFbError =
          typeof body === 'string'
            ? body.startsWith('{')
              ? JSON.parse(body)
              : { message: body }
            : body;
      }
    }

    this.logger.error(
      `Failed to reply comment. inputId=${commentId} tried=${triedIds.join(',')} error=${JSON.stringify(lastFbError ?? {})}`,
    );
    throw this.mapFbError(lastFbError?.error);
  }
}
