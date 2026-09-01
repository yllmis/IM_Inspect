import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "IM Inspect",
  description: "IM 客服消息异常诊断 Agent",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  );
}
