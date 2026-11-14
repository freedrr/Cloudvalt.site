export interface StoragePlan {
  id: '100mb' | '50gb' | '250gb' | '1tb';
  name: string;
  badge: string;
  tagline: string;
  priceFormatted: string;
  priceMonthly: number;
  checkoutUrl?: string;
  maxBytes: number;
  highlight?: boolean;
  features: string[];
}

export const STORAGE_PLANS: Record<string, StoragePlan> = {
  '100mb': {
    id: '100mb',
    name: '100 MB Free',
    badge: 'Test Mode',
    tagline: 'Test upload speeds, zero compression & 4K video streaming',
    priceFormatted: '$0',
    priceMonthly: 0,
    maxBytes: 100 * 1024 * 1024, // 100 MB
    features: [
      '100 MB instant quota for test mode',
      'Lossless RAW photo & 4K video playback',
      'Anti-spam protection (zero card required)',
      'Bank-grade AES-256 encrypted vault',
      'Instant drag & drop batch upload',
    ],
  },
  '50gb': {
    id: '50gb',
    name: '50 GB Starter',
    badge: 'Creator',
    tagline: 'For passionate mobile & mirrorless photographers',
    priceFormatted: '$3.99/month',
    priceMonthly: 3.99,
    checkoutUrl: 'https://whop.com/checkout/ch_nQGMC9zyxWndgAz/',
    maxBytes: 50 * 1024 * 1024 * 1024, // 50 GB
    features: [
      'Billed every 30 days; no extra first payment charge',
      '50 GB high-capacity vault (~12,500 photos)',
      'Smooth 4K 60fps video playback',
      'Fast multi-threaded uploads',
      'Instant secure wipe & starred albums',
      'Permanent cloud backup',
    ],
  },
  '250gb': {
    id: '250gb',
    name: '250 GB Pro Studio',
    badge: 'Most Popular',
    tagline: 'Best for videographers, filmmakers & active creators',
    priceFormatted: '$6.99/month',
    priceMonthly: 6.99,
    checkoutUrl: 'https://whop.com/checkout/ch_5Ws2YBO75QKKJfS/',
    maxBytes: 250 * 1024 * 1024 * 1024, // 250 GB
    highlight: true,
    features: [
      'Billed every 30 days; no extra first payment charge',
      '250 GB professional storage (~62,500 photos or 50 hrs 4K)',
      'Uncapped bitrate video streaming & scrubbing',
      'RAW, DNG, ProRes, MKV & MP4 support',
      'Zero compression guaranteed forever',
      'Priority client support & 99.99% uptime',
    ],
  },
  '1tb': {
    id: '1tb',
    name: '1 TB Ultimate',
    badge: 'Best Value',
    tagline: 'Complete production archive for studios & power creators',
    priceFormatted: '$13.99/month',
    priceMonthly: 13.99,
    checkoutUrl: 'https://whop.com/checkout/ch_Bk8BD0spJ6gdDgy/',
    maxBytes: 1024 * 1024 * 1024 * 1024, // 1 TB
    features: [
      'Billed every 30 days; no extra first payment charge',
      '1,000 GB enterprise cloud capacity',
      'Massive 4K / 8K RAW video archive',
      'Highest bandwidth global CDN pipeline',
      'Automated vault security backups',
      'VIP creator support & early feature access',
    ],
  },
};
