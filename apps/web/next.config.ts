import type { NextConfig } from 'next';

const backendUrl = process.env.BACKEND_URL ?? 'http://localhost:3002';

const nextConfig: NextConfig = {
  reactStrictMode: true,
  skipTrailingSlashRedirect: true,
  eslint: {
    ignoreDuringBuilds: true,
  },
  allowedDevOrigins: ['even-spindle-collie.ngrok-free.dev', '*.ngrok-free.dev'],
  async rewrites() {
    const apiRewrites = [
      {
        source: '/facebook-page/:path*',
        destination: `${backendUrl}/facebook-page/:path*`,
      },
      {
        source: '/conversations/post',
        destination: `${backendUrl}/conversations/post`,
      },
      {
        source: '/conversations/avatar',
        destination: `${backendUrl}/conversations/avatar`,
      },
      {
        source: '/conversations/:threadId/messages',
        destination: `${backendUrl}/conversations/:threadId/messages`,
      },
      {
        source: '/conversations/:threadId/send',
        destination: `${backendUrl}/conversations/:threadId/send`,
      },
      { source: '/conversations', destination: `${backendUrl}/conversations` },
      {
        source: '/conversations/sync-comments',
        destination: `${backendUrl}/conversations/sync-comments`,
      },
      {
        source: '/conversations/comments/:commentId/action',
        destination: `${backendUrl}/conversations/comments/:commentId/action`,
      },
      {
        source: '/conversations/messages/:messageId/:action',
        destination: `${backendUrl}/conversations/messages/:messageId/:action`,
      },
      { source: '/messages', destination: `${backendUrl}/messages` },
      {
        source: '/messages/:path*',
        destination: `${backendUrl}/messages/:path*`,
      },
      {
        source: '/webhook/:path*',
        destination: `${backendUrl}/webhook/:path*`,
      },
      { source: '/config/:path*', destination: `${backendUrl}/config/:path*` },
      { source: '/setup/:path*', destination: `${backendUrl}/setup/:path*` },
      { source: '/health', destination: `${backendUrl}/health` },
      { source: '/uploads', destination: `${backendUrl}/uploads` },
      { source: '/uploads/:path*', destination: `${backendUrl}/uploads/:path*` },
      { source: '/api-docs', destination: `${backendUrl}/api-docs` },
      {
        source: '/api-docs/:path*',
        destination: `${backendUrl}/api-docs/:path*`,
      },
    ];

    return {
      // Socket.IO bắt buộc trailing slash — rewrite thường strip "/" → backend 404
      beforeFiles: [
        {
          source: '/socket.io/',
          destination: `${backendUrl}/socket.io/`,
        },
        {
          source: '/socket.io/:path*',
          destination: `${backendUrl}/socket.io/:path*`,
        },
      ],
      fallback: apiRewrites,
    };
  },
};

export default nextConfig;
