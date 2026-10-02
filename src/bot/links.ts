export type Platform = 'instagram' | 'tiktok' | 'pinterest' | 'facebook';

export interface ParsedLink {
  platform: Platform;
  url: string;
  // Redis kesh kaliti. Instagram uchun eski `ig:<shortcode>` formati saqlangan — mavjud kesh ishlashda davom etadi.
  cacheKey: string;
}

const PATTERNS: { platform: Platform; regex: RegExp; key: (m: RegExpMatchArray) => string }[] = [
  {
    platform: 'instagram',
    regex: /https?:\/\/(?:www\.)?instagram\.com\/(?:p|reel|reels|tv)\/([\w-]+)/i,
    key: (m) => `ig:${m[1]}`,
  },
  {
    platform: 'tiktok',
    regex: /https?:\/\/(?:www\.|m\.)?tiktok\.com\/@[\w.-]+\/(?:video|photo)\/(\d+)/i,
    key: (m) => `tt:${m[1]}`,
  },
  {
    // Qisqa havolalar: vm.tiktok.com/xxx, vt.tiktok.com/xxx, tiktok.com/t/xxx
    platform: 'tiktok',
    regex: /https?:\/\/(?:(?:vm|vt)\.tiktok\.com|(?:www\.)?tiktok\.com\/t)\/([\w-]+)/i,
    key: (m) => `tt:s:${m[1]}`,
  },
  {
    platform: 'pinterest',
    regex: /https?:\/\/(?:[\w-]+\.)?pinterest\.[a-z.]+\/pin\/(?:[\w-]*--)?(\d+)/i,
    key: (m) => `pin:${m[1]}`,
  },
  {
    platform: 'pinterest',
    regex: /https?:\/\/pin\.it\/([\w-]+)/i,
    key: (m) => `pin:s:${m[1]}`,
  },
  {
    // facebook.com/reel/123, /watch?v=123, /<sahifa>/videos/123 (m., web. subdomenlari ham)
    platform: 'facebook',
    regex: /https?:\/\/(?:www\.|m\.|web\.)?facebook\.com\/(?:reel\/|watch\/?\?v=|[\w.-]+\/videos\/(?:[\w.-]+\/)?)(\d+)/i,
    key: (m) => `fb:${m[1]}`,
  },
  {
    // Qisqa/ulashish havolalari: fb.watch/xxx, facebook.com/share/{v,r,p}/xxx
    platform: 'facebook',
    regex: /https?:\/\/(?:fb\.watch|(?:www\.|m\.|web\.)?facebook\.com\/share\/[vrp])\/([\w-]+)/i,
    key: (m) => `fb:s:${m[1]}`,
  },
];

export function parseLink(text: string): ParsedLink | null {
  for (const p of PATTERNS) {
    const m = text.match(p.regex);
    if (m) return { platform: p.platform, url: m[0], cacheKey: p.key(m) };
  }
  return null;
}
