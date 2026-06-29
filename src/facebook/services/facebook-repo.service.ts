import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { FacebookPageToken } from './facebook-oauth.service';

@Injectable()
export class FacebookRepoService {
  constructor(private readonly prisma: PrismaService) {}

  async findCredentialById(orgId: string, credentialId: string) {
    return this.prisma.facebookCredential.findFirst({
      where: {
        id: credentialId,
        organizationId: orgId,
        status: { not: 'DELETE' },
      },
      select: {
        id: true,
        userAccessToken: true,
        fbUserId: true,
        fbUserName: true,
      },
    });
  }

  async getExistingPageIds(orgId: string, incomingPageIds: string[]) {
    const existingPages = await this.prisma.facebookPage.findMany({
      where: { organizationId: orgId, pageId: { in: incomingPageIds } },
      select: { pageId: true },
    });
    return existingPages.map((p) => p.pageId);
  }

  async createPendingCredential(orgId: string, friendlyName?: string) {
    return this.prisma.facebookCredential.create({
      data: {
        organizationId: orgId,
        friendlyName: friendlyName || 'Facebook',
        status: 'PENDING',
      },
    });
  }

  async persistOAuthResult(
    orgId: string,
    credentialId: string,
    accessToken: string,
    userTokenExpiresAt: Date,
    fbUserId: string,
    fbUserName: string,
    pageTokens: FacebookPageToken[],
    meta: { friendlyName?: string; purpose?: string; notes?: string },
  ) {
    return this.prisma.$transaction(async (tx) => {
      await tx.facebookCredential.update({
        where: { id: credentialId },
        data: {
          userAccessToken: accessToken,
          userTokenExpiresAt,
          fbUserId,
          fbUserName,
          userTokenStatus: 'VALID',
          status: 'ACTIVE',
          ...(meta.friendlyName && { friendlyName: meta.friendlyName }),
        },
      });

      const incomingPageIds = pageTokens.map((p) => p.pageId);
      const existingPages = await tx.facebookPage.findMany({
        where: { organizationId: orgId, pageId: { in: incomingPageIds } },
        select: { id: true, pageId: true },
      });
      const existingByPageId = new Map(
        existingPages.map((p) => [p.pageId, p.id]),
      );

      let savedPages = 0;
      for (const page of pageTokens) {
        const existingId = existingByPageId.get(page.pageId);

        if (existingId) {
          await tx.facebookPage.update({
            where: { id: existingId },
            data: {
              credentialId,
              name: page.pageName,
              category: page.category ?? null,
              pictureUrl: page.pictureUrl ?? null,
              pageAccessToken: page.pageAccessToken,
              tasks: JSON.stringify(page.tasks ?? []),
              webhookSubscribed: false,
              status: 'ACTIVE',
            },
          });
        } else {
          await tx.facebookPage.create({
            data: {
              organizationId: orgId,
              credentialId,
              pageId: page.pageId,
              name: page.pageName,
              category: page.category ?? null,
              pictureUrl: page.pictureUrl ?? null,
              pageAccessToken: page.pageAccessToken,
              tasks: JSON.stringify(page.tasks ?? []),
              status: 'ACTIVE',
            },
          });
        }
        savedPages++;
      }

      const allExistingPagesForCredential = await tx.facebookPage.findMany({
        where: { credentialId },
        select: { id: true, pageId: true },
      });

      const revokedPageIds = allExistingPagesForCredential
        .filter((p) => !incomingPageIds.includes(p.pageId))
        .map((p) => p.id);

      if (revokedPageIds.length > 0) {
        await tx.facebookPage.deleteMany({
          where: { id: { in: revokedPageIds } },
        });
      }

      return { savedPages };
    });
  }

  async findPageByCredentialAndPageId(credentialId: string, pageId: string) {
    return this.prisma.facebookPage.findFirst({
      where: { credentialId, pageId },
      select: { id: true },
    });
  }

  async updatePageWebhook(id: string, webhookSubscribed: boolean) {
    return this.prisma.facebookPage.update({
      where: { id },
      data: {
        webhookSubscribed,
        webhookSubscribedAt: webhookSubscribed ? new Date() : null,
      },
    });
  }

  async findActivePagesByCredential(credentialId: string, pageIds: string[]) {
    return this.prisma.facebookPage.findMany({
      where: {
        credentialId,
        pageId: { in: pageIds },
        status: 'ACTIVE',
      },
      select: { id: true, pageId: true, name: true },
    });
  }

  async findPageByOrgAndId(orgId: string, id: string) {
    return this.prisma.facebookPage.findFirst({
      where: { id, organizationId: orgId, status: 'ACTIVE' },
      select: {
        id: true,
        pageId: true,
        name: true,
        pictureUrl: true,
        pageAccessToken: true,
        webhookSubscribed: true,
        isPinned: true,
        credentialId: true,
      },
    });
  }

  async updatePagePinned(id: string, isPinned: boolean) {
    return this.prisma.facebookPage.update({
      where: { id },
      data: {
        isPinned,
        pinnedAt: isPinned ? new Date() : null,
      },
    });
  }

  async deletePage(id: string) {
    return this.prisma.facebookPage.delete({ where: { id } });
  }

  async countActivePages(orgId: string) {
    return this.prisma.facebookPage.count({
      where: { organizationId: orgId, status: 'ACTIVE' },
    });
  }

  async listPages(orgId: string) {
    return this.prisma.facebookPage.findMany({
      where: { organizationId: orgId, status: 'ACTIVE' },
      select: {
        id: true,
        pageId: true,
        name: true,
        category: true,
        pictureUrl: true,
        pageAccessToken: true,
        tasks: true,
        webhookSubscribed: true,
        isPinned: true,
        pinnedAt: true,
        credentialId: true,
        createdAt: true,
      },
      orderBy: [
        { isPinned: 'desc' },
        { pinnedAt: 'desc' },
        { createdAt: 'desc' },
      ],
    });
  }

  async updatePagePicture(id: string, pictureUrl: string) {
    return this.prisma.facebookPage.update({
      where: { id },
      data: { pictureUrl },
    });
  }

  async listCredentialsForLogout(orgId: string) {
    return this.prisma.facebookCredential.findMany({
      where: { organizationId: orgId },
      select: { id: true, userAccessToken: true },
    });
  }

  async disconnectOrganization(orgId: string) {
    return this.prisma.facebookCredential.deleteMany({
      where: { organizationId: orgId },
    });
  }
}
