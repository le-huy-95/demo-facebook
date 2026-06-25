import { PrismaClient } from '@prisma/client';
import got from 'got';

const PAGE_ID = process.argv[2] || '110338337196945';
const prisma = new PrismaClient();

async function main() {
  const page = await prisma.facebookPage.findFirst({
    where: { pageId: PAGE_ID },
    select: {
      pageId: true,
      name: true,
      webhookSubscribed: true,
      pageAccessToken: true,
    },
  });

  console.log('=== PAGE ===');
  console.log(
    JSON.stringify(
      {
        ...page,
        pageAccessToken: page?.pageAccessToken ? `${page.pageAccessToken.slice(0, 20)}...` : null,
      },
      null,
      2,
    ),
  );

  const events = await prisma.webhookEvent.findMany({
    where: { pageId: PAGE_ID },
    orderBy: { createdAt: 'desc' },
    take: 5,
    select: { id: true, eventType: true, content: true, createdAt: true },
  });
  console.log('\n=== WEBHOOK EVENTS (latest 5) ===');
  console.log(JSON.stringify(events, null, 2));
  console.log('Total events for page:', await prisma.webhookEvent.count({ where: { pageId: PAGE_ID } }));

  const allCounts = await prisma.webhookEvent.groupBy({
    by: ['pageId'],
    _count: true,
  });
  console.log('\n=== EVENTS BY PAGE ===');
  console.log(JSON.stringify(allCounts, null, 2));

  if (!page?.pageAccessToken) {
    console.log('\nNo page access token — cannot test Graph API');
    return;
  }

  const token = page.pageAccessToken;
  const v = 'v25.0';

  console.log('\n=== GRAPH API: subscribed_apps ===');
  try {
    const sub = await got
      .get(`https://graph.facebook.com/${v}/${PAGE_ID}/subscribed_apps`, {
        searchParams: { access_token: token },
      })
      .json();
    console.log(JSON.stringify(sub, null, 2));
  } catch (e) {
    console.log('ERROR', e.response?.body || e.message);
  }

  console.log('\n=== GRAPH API: /{page-id}/conversations ===');
  try {
    const conv = await got
      .get(`https://graph.facebook.com/${v}/${PAGE_ID}/conversations`, {
        searchParams: {
          access_token: token,
          fields: 'id,updated_time,participants,snippet,message_count,unread_count',
          limit: 5,
        },
      })
      .json();
    console.log(JSON.stringify(conv, null, 2));
  } catch (e) {
    console.log('ERROR', e.response?.body || e.message);
  }

  console.log('\n=== GRAPH API: conversation messages ===');
  try {
    const convList = await got
      .get(`https://graph.facebook.com/${v}/${PAGE_ID}/conversations`, {
        searchParams: {
          access_token: token,
          fields: 'id',
          limit: 1,
        },
      })
      .json();
    const convId = convList.data?.[0]?.id;
    if (convId) {
      const msgs = await got
        .get(`https://graph.facebook.com/${v}/${convId}`, {
          searchParams: {
            access_token: token,
            fields: 'messages{message,from,created_time,id}',
          },
        })
        .json();
      console.log(JSON.stringify(msgs, null, 2));
    }
  } catch (e) {
    console.log('ERROR', e.response?.body || e.message);
  }

  console.log('\n=== GRAPH API: /{page-id}/feed (posts) ===');
  try {
    const feed = await got
      .get(`https://graph.facebook.com/${v}/${PAGE_ID}/feed`, {
        searchParams: {
          access_token: token,
          fields: 'id,message,created_time,comments.limit(3){id,message,from,created_time}',
          limit: 3,
        },
      })
      .json();
    console.log(JSON.stringify(feed, null, 2));
  } catch (e) {
    console.log('ERROR', e.response?.body || e.message);
  }
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect());
