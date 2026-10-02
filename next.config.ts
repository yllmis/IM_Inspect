import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // proto 是运行时读取的资源，需显式纳入生产部署文件追踪。
  outputFileTracingIncludes: {
    "/api/chat": ["./src/connectors/go-im/proto/operations.proto"],
  },
};

export default nextConfig;
