import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          // A content policy limited to directives that cannot break Next's own scripts.
          // A full script-src policy needs a per-request nonce threaded through every
          // page, and a wrong one fails as a blank screen; these four close real holes
          // without that risk. No framing (the modern form of the header above), no
          // injected <base> tag rewriting where relative links and form posts go, no
          // plugin content, and forms may only submit back to this site -- so an
          // injected form cannot post your passcode somewhere else.
          {
            key: "Content-Security-Policy",
            value: "frame-ancestors 'none'; base-uri 'self'; object-src 'none'; form-action 'self'",
          },
          // Hardware and sensors the app never uses, switched off so nothing injected
          // into a page can ask for them either.
          {
            key: "Permissions-Policy",
            value: "camera=(), microphone=(), geolocation=(), payment=(), usb=(), bluetooth=()",
          },
        ],
      },
      {
        // Per the Next.js PWA guide. Without no-store the browser can serve sw.js from
        // its HTTP cache and keep an old worker alive, so a fixed notification bug
        // never reaches the device.
        source: "/sw.js",
        headers: [
          { key: "Content-Type", value: "application/javascript; charset=utf-8" },
          { key: "Cache-Control", value: "no-cache, no-store, must-revalidate" },
          { key: "Content-Security-Policy", value: "default-src 'self'; script-src 'self'" },
        ],
      },
    ];
  },
};

export default nextConfig;
