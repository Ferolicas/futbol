/** @type {import('next').NextConfig} */
const nextConfig = {
  images: {
    unoptimized: true,
  },
  env: {
    NEXT_PUBLIC_PUSHER_KEY: '4b69ba2ea5a71be0e991',
    NEXT_PUBLIC_PUSHER_CLUSTER: 'sa1',
  },
};

export default nextConfig;
