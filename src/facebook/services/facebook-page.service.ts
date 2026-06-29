import {
  BadRequestException,
  Injectable,
  NotFoundException,
  OnModuleInit,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AppLogger } from '../../common/logger.service';
import {
  FacebookOAuthService,
  FacebookPageToken,
  OAuthStateData,
} from './facebook-oauth.service';
import { FacebookRepoService } from './facebook-repo.service';
import { PageMapService } from './page-map.service';

interface FacebookAuthDto {
  credentialId?: string;
  friendlyName?: string;
  purpose?: string;
  notes?: string;
}

@Injectable()
export class FacebookPageService implements OnModuleInit {
  private readonly SUBSCRIBE_MAX_RETRIES = 3;
  private readonly SUBSCRIBE_BASE_DELAY_MS = 2000;

  constructor(
    private readonly logger: AppLogger,
    private readonly configService: ConfigService,
    private readonly facebookRepo: FacebookRepoService,
    private readonly facebookOAuthService: FacebookOAuthService,
    private readonly pageMapService: PageMapService,
  ) {
    this.logger.setContext(FacebookPageService.name);
  }

  async onModuleInit(): Promise<void> {
    const orgId = this.getDefaultOrgId();
    const pages = await this.facebookRepo.listPages(orgId);
    for (const page of pages) {
      this.pageMapService.syncSocialAccount({
        platformId: page.pageId,
        socialId: page.id,
        organizationId: orgId,
        status: 'ACTIVE',
        isAiEnabled: true,
      });
    }

    if (pages.length > 0) {
      this.logger.log(`Restored ${pages.length} page mapping(s) from database`);
    }

    void this.facebookOAuthService.ensureAppWebhookSubscription().catch((err) => {
      this.logger.warn(
        `[onModuleInit] App webhook subscription check failed: ${err?.message ?? err}`,
      );
    });
  }

  /**
   * Must be called AFTER the HTTP server is listening so Facebook can
   * verify the callback URL during subscription.
   */
  async registerWebhooksAfterStartup(): Promise<void> {
    const orgId = this.getDefaultOrgId();

    const appOk = await this.subscribeAppWebhookWithRetry();
    if (!appOk) {
      this.logger.error(
        '[Startup] App-level webhook registration FAILED after retries — ' +
          'Facebook will NOT deliver feed/comment events. ' +
          'Check PUBLIC_BASE_URL, FACEBOOK_APP_ID, FACEBOOK_APP_SECRET.',
      );
      return;
    }
    this.logger.log('[Startup] App-level webhook callback registered with Facebook');

    const pages = await this.facebookRepo.listPages(orgId);
    if (pages.length === 0) return;

    const unsubscribed = pages.filter(
      (p) => p.pageAccessToken && !p.webhookSubscribed,
    );
    if (unsubscribed.length === 0) {
      this.logger.log(
        `[Startup] All ${pages.length} page(s) already subscribed — skipping re-subscription`,
      );
      return;
    }

    let subscribed = 0;
    for (const page of unsubscribed) {
      if (!page.pageAccessToken) continue;
      try {
        await this.delay(500);
        const ok = await this.facebookOAuthService.subscribeToPageWebhook(
          page.pageId,
          page.pageAccessToken,
        );
        if (ok) {
          subscribed++;
          await this.facebookRepo.updatePageWebhook(page.id, true);
          this.logger.log(
            `[Startup] Page ${page.pageId} (${page.name}) webhook subscribed`,
          );
        } else {
          this.logger.warn(
            `[Startup] Page ${page.pageId} (${page.name}) webhook subscription failed`,
          );
        }
      } catch (err: any) {
        this.logger.warn(
          `[Startup] Page ${page.pageId} webhook error: ${err?.message}`,
        );
      }
    }
    this.logger.log(
      `[Startup] Subscribed ${subscribed}/${unsubscribed.length} unsubscribed page(s)`,
    );
  }

  private async subscribeAppWebhookWithRetry(): Promise<boolean> {
    for (let attempt = 1; attempt <= this.SUBSCRIBE_MAX_RETRIES; attempt++) {
      const ok = await this.facebookOAuthService.subscribeAppWebhook();
      if (ok) return true;

      if (attempt < this.SUBSCRIBE_MAX_RETRIES) {
        const delay = this.SUBSCRIBE_BASE_DELAY_MS * attempt;
        this.logger.warn(
          `[Startup] App webhook attempt ${attempt}/${this.SUBSCRIBE_MAX_RETRIES} failed, retrying in ${delay}ms...`,
        );
        await this.delay(delay);
      }
    }
    return false;
  }

  private delay(ms: number): Promise<void> {
    return new Promise((r) => setTimeout(r, ms));
  }

  getDefaultOrgId(): string {
    return this.configService.get<string>('DEFAULT_ORG_ID', 'default-org');
  }

  async initiateOAuth(
    orgId: string,
    dto: FacebookAuthDto,
  ): Promise<{ url: string; credentialId: string }> {
    if (!orgId) throw new UnauthorizedException('organizationId is required');

    let credentialId = dto.credentialId;

    if (credentialId) {
      const existing = await this.facebookRepo.findCredentialById(
        orgId,
        credentialId,
      );
      if (!existing) {
        throw new NotFoundException(
          `FacebookCredential ${credentialId} not found`,
        );
      }

      if (existing.userAccessToken) {
        await this.facebookOAuthService.revokeUserToken(
          existing.userAccessToken,
        );
      }
    } else {
      const newCred = await this.facebookRepo.createPendingCredential(
        orgId,
        dto.friendlyName,
      );
      credentialId = newCred.id;
      this.logger.log(
        `Created PENDING FacebookCredential ${credentialId} for org ${orgId}`,
      );
    }

    const meta: Omit<OAuthStateData, 'orgId'> = {
      friendlyName: dto.friendlyName,
      purpose: dto.purpose,
      notes: dto.notes,
      credentialId,
    };

    const url = this.facebookOAuthService.buildOAuthUrl(orgId, meta);
    return { url, credentialId: credentialId };
  }

  async handleOAuthCallback(
    code: string,
    state: string,
  ): Promise<{ savedPages: number }> {
    const {
      stateData,
      accessToken,
      userTokenExpiresAt,
      fbUserId,
      fbUserName,
      pageTokens,
    } = await this.fetchTokenAndPages(code, state);
    const { resolvedCredentialId, savedPages } =
      await this.persistCredentialAndPages(
        stateData,
        accessToken,
        userTokenExpiresAt,
        fbUserId,
        fbUserName,
        pageTokens,
      );

    await this.syncPagesWithForward(
      resolvedCredentialId,
      stateData.orgId,
      pageTokens,
    );

    void this.subscribeWebhooks(resolvedCredentialId, pageTokens).catch(
      (err) =>
        this.logger.warn(
          `[handleOAuthCallback] webhook subscription deferred: ${err?.message}`,
        ),
    );

    this.logger.log(
      `Linked ${savedPages} Facebook Page(s) to credential ${resolvedCredentialId} (org ${stateData.orgId})`,
    );
    return { savedPages };
  }

  async listPages(orgId: string) {
    return this.facebookRepo.listPages(orgId);
  }

  async listShops(orgId: string) {
    const pages = await this.facebookRepo.listPages(orgId);

    const enriched = await Promise.all(
      pages.map(async (page) => {
        let pictureUrl: string | null = page.pictureUrl;

        if (!pictureUrl && page.pageAccessToken) {
          try {
            const fetched = await this.facebookOAuthService.getPagePictureUrl(
              page.pageId,
              page.pageAccessToken,
            );
            if (fetched) {
              pictureUrl = fetched;
              await this.facebookRepo.updatePagePicture(page.id, fetched);
            }
          } catch (err: any) {
            this.logger.warn(
              `Failed to fetch picture for page ${page.pageId}: ${err?.message}`,
            );
          }
        }

        return {
          id: page.id,
          pageId: page.pageId,
          name: page.name,
          category: page.category,
          pictureUrl: pictureUrl ?? null,
          webhookSubscribed: page.webhookSubscribed,
          isPinned: page.isPinned,
          platform: 'facebook' as const,
          ...(page.pageAccessToken
            ? {
                ...(await this.facebookOAuthService.inspectPageTokenScopes(
                  page.pageAccessToken,
                )),
                ...(await this.facebookOAuthService.inspectPageWebhookSubscription(
                  page.pageId,
                  page.pageAccessToken,
                )),
              }
            : {
                scopes: [] as string[],
                missingCommentScopes: [
                  ...FacebookOAuthService.COMMENT_SCOPES,
                ],
                commentPermissionsOk: false,
                installed: false,
                subscribedFields: [] as string[],
                feedSubscribed: false,
                missingFields: [
                  ...FacebookOAuthService.COMMENT_WEBHOOK_FIELDS,
                ],
              }),
        };
      }),
    );

    return enriched;
  }

  async togglePin(orgId: string, pageRecordId: string) {
    const page = await this.facebookRepo.findPageByOrgAndId(
      orgId,
      pageRecordId,
    );
    if (!page) throw new NotFoundException('Không tìm thấy trang');

    const updated = await this.facebookRepo.updatePagePinned(
      page.id,
      !page.isPinned,
    );
    this.logger.log(`Page ${page.pageId} pin toggled: ${updated.isPinned}`);

    return { id: page.id, isPinned: updated.isPinned };
  }

  async resubscribeWebhook(
    orgId: string,
    pageRecordId: string,
  ): Promise<{
    pageId: string;
    subscribed: boolean;
    feedSubscribed: boolean;
    subscribedFields: string[];
  }> {
    const page = await this.facebookRepo.findPageByOrgAndId(
      orgId,
      pageRecordId,
    );
    if (!page) throw new NotFoundException('Không tìm thấy trang');
    if (!page.pageAccessToken) {
      throw new BadRequestException('Page không có access token — hãy OAuth lại');
    }

    await this.facebookOAuthService.ensureAppWebhookSubscription();

    const subscribed =
      await this.facebookOAuthService.subscribeToPageWebhook(
        page.pageId,
        page.pageAccessToken,
      );

    const inspection =
      await this.facebookOAuthService.inspectPageWebhookSubscription(
        page.pageId,
        page.pageAccessToken,
      );

    if (subscribed) {
      await this.facebookRepo.updatePageWebhook(page.id, true);
      this.logger.log(`[resubscribeWebhook] pageId=${page.pageId} OK`);
    } else {
      this.logger.warn(`[resubscribeWebhook] pageId=${page.pageId} failed`);
    }

    return {
      pageId: page.pageId,
      subscribed,
      feedSubscribed: inspection.feedSubscribed,
      subscribedFields: inspection.subscribedFields,
    };
  }

  async unlinkPage(orgId: string, pageRecordId: string) {
    const page = await this.facebookRepo.findPageByOrgAndId(
      orgId,
      pageRecordId,
    );
    if (!page) throw new NotFoundException('Không tìm thấy trang');

    if (page.webhookSubscribed && page.pageAccessToken) {
      await this.facebookOAuthService.unsubscribeFromPageWebhook(
        page.pageId,
        page.pageAccessToken,
      );
    }

    this.pageMapService.remove(page.pageId);
    await this.facebookRepo.deletePage(page.id);

    const remaining = await this.facebookRepo.countActivePages(orgId);
    this.logger.log(
      `Unlinked page ${page.pageId}, remaining ${remaining} page(s)`,
    );

    return { id: page.id, pageId: page.pageId, remainingPages: remaining };
  }

  async logout(orgId: string): Promise<{ disconnectedPages: number }> {
    const pages = await this.facebookRepo.listPages(orgId);
    const credentials = await this.facebookRepo.listCredentialsForLogout(orgId);

    for (const cred of credentials) {
      if (cred.userAccessToken) {
        await this.facebookOAuthService.revokeUserToken(cred.userAccessToken);
      }
    }

    for (const page of pages) {
      this.pageMapService.remove(page.pageId);
    }

    await this.facebookRepo.disconnectOrganization(orgId);
    this.logger.log(`Logged out org ${orgId}, removed ${pages.length} page(s)`);

    return { disconnectedPages: pages.length };
  }

  async getPageSubscriptions(): Promise<any[]> {
    const orgId = this.getDefaultOrgId();
    const pages = await this.facebookRepo.listPages(orgId);
    const results: any[] = [];

    for (const page of pages) {
      if (!page.pageAccessToken) {
        results.push({ pageId: page.pageId, name: page.name, error: 'No access token' });
        continue;
      }
      try {
        await this.delay(300);
        const status = await this.facebookOAuthService.getPageSubscriptionStatus(
          page.pageId,
          page.pageAccessToken,
        );
        results.push({ pageId: page.pageId, name: page.name, subscriptions: status });
      } catch (err: any) {
        results.push({ pageId: page.pageId, name: page.name, error: err?.message });
      }
    }

    return results;
  }

  async resubscribeAllPages(): Promise<any[]> {
    const orgId = this.getDefaultOrgId();
    const pages = await this.facebookRepo.listPages(orgId);
    const results: any[] = [];

    for (const page of pages) {
      if (!page.pageAccessToken) {
        results.push({ pageId: page.pageId, name: page.name, subscribed: false, reason: 'No access token' });
        continue;
      }
      try {
        await this.delay(500);
        const ok = await this.facebookOAuthService.subscribeToPageWebhook(
          page.pageId,
          page.pageAccessToken,
        );
        if (ok) {
          await this.facebookRepo.updatePageWebhook(page.id, true);
        }
        results.push({ pageId: page.pageId, name: page.name, subscribed: ok });
      } catch (err: any) {
        results.push({ pageId: page.pageId, name: page.name, subscribed: false, reason: err?.message });
      }
    }

    return results;
  }

  private async fetchTokenAndPages(
    code: string,
    state: string,
  ): Promise<{
    stateData: OAuthStateData;
    accessToken: string;
    userTokenExpiresAt: Date;
    fbUserId: string;
    fbUserName: string;
    pageTokens: FacebookPageToken[];
  }> {
    const stateData = this.facebookOAuthService.resolveState(state);

    const shortLived =
      await this.facebookOAuthService.exchangeCodeForToken(code);

    const [fbUser, longLived] = await Promise.all([
      this.facebookOAuthService.getMe(shortLived.access_token),
      this.facebookOAuthService.extendToLongLivedToken(shortLived.access_token),
    ]);

    const userTokenExpiresAt = longLived.expires_in
      ? new Date(Date.now() + longLived.expires_in * 1000)
      : new Date(Date.now() + 60 * 24 * 60 * 60 * 1000);

    const pageTokens = await this.facebookOAuthService.getPageTokens(
      longLived.access_token,
    );

    return {
      stateData,
      accessToken: longLived.access_token,
      userTokenExpiresAt,
      fbUserId: fbUser.id,
      fbUserName: fbUser.name,
      pageTokens,
    };
  }

  private async persistCredentialAndPages(
    stateData: OAuthStateData,
    accessToken: string,
    userTokenExpiresAt: Date,
    fbUserId: string,
    fbUserName: string,
    pageTokens: FacebookPageToken[],
  ): Promise<{ resolvedCredentialId: string; savedPages: number }> {
    const { orgId, credentialId, friendlyName, purpose, notes } = stateData;

    if (!credentialId) {
      throw new NotFoundException('credentialId is missing from OAuth state');
    }

    const existing = await this.facebookRepo.findCredentialById(
      orgId,
      credentialId,
    );
    if (!existing)
      throw new NotFoundException(`Credential ${credentialId} not found`);

    if (existing.fbUserId && existing.fbUserId !== fbUserId) {
      const expectedName = existing.fbUserName || 'Người dùng';
      throw new BadRequestException(
        `Tài khoản Facebook vừa đăng nhập (${fbUserName}) không khớp với tài khoản đã liên kết trước đó (${expectedName}).`,
      );
    }

    const { savedPages } = await this.facebookRepo.persistOAuthResult(
      orgId,
      credentialId,
      accessToken,
      userTokenExpiresAt,
      fbUserId,
      fbUserName,
      pageTokens,
      { friendlyName, purpose, notes },
    );

    return { resolvedCredentialId: credentialId, savedPages };
  }

  private async subscribeWebhooks(
    credentialId: string,
    pageTokens: FacebookPageToken[],
  ): Promise<void> {
    if (pageTokens.length === 0) return;

    await this.facebookOAuthService.ensureAppWebhookSubscription();

    for (const page of pageTokens) {
      try {
        await this.delay(300);
        const subscribed =
          await this.facebookOAuthService.subscribeToPageWebhook(
            page.pageId,
            page.pageAccessToken,
          );
        if (subscribed) {
          const fbPage = await this.facebookRepo.findPageByCredentialAndPageId(
            credentialId,
            page.pageId,
          );
          if (fbPage) {
            await this.facebookRepo.updatePageWebhook(fbPage.id, true);
          }
        }
      } catch (err: any) {
        this.logger.warn(
          `Failed to process webhook for page ${page.pageId}: ${err.message}`,
        );
      }
    }
  }

  private async syncPagesWithForward(
    credentialId: string,
    orgId: string,
    pageTokens: FacebookPageToken[],
  ): Promise<void> {
    if (pageTokens.length === 0) return;

    const activePages = await this.facebookRepo.findActivePagesByCredential(
      credentialId,
      pageTokens.map((p) => p.pageId),
    );

    for (const page of activePages) {
      this.pageMapService.syncSocialAccount({
        platformId: page.pageId,
        socialId: page.id,
        organizationId: orgId,
        status: 'ACTIVE',
        isAiEnabled: true,
      });
      this.logger.log(
        `[SyncSocialAccount] pageId=${page.pageId} socialId=${page.id} orgId=${orgId}`,
      );
    }
  }
}
