/** Supported stocks (kept in sync with the `stocks` seed in supabase/migrations). */
export interface StockRef {
  symbol: string;
  name: string;
  exchange: string;
  sector: string;
  description: string;
}

export const STOCK_REFS: StockRef[] = [
  { symbol: "NVDA", name: "NVIDIA", exchange: "NASDAQ", sector: "Semiconductors", description: "Designs GPUs and accelerated-computing platforms used in gaming, data centres and AI workloads." },
  { symbol: "AAPL", name: "Apple", exchange: "NASDAQ", sector: "Consumer Technology", description: "Makes the iPhone, Mac, iPad and wearables, and runs services such as the App Store, iCloud and Apple Pay." },
  { symbol: "MSFT", name: "Microsoft", exchange: "NASDAQ", sector: "Software & Cloud", description: "Develops Windows, Office and the Azure cloud platform, alongside LinkedIn, GitHub and Xbox." },
  { symbol: "TSLA", name: "Tesla", exchange: "NASDAQ", sector: "Automotive & Energy", description: "Builds electric vehicles, battery storage and solar products, and develops driver-assistance software." },
  { symbol: "AMZN", name: "Amazon", exchange: "NASDAQ", sector: "E-commerce & Cloud", description: "Operates a global online marketplace and logistics network, and Amazon Web Services (AWS)." },
  { symbol: "GOOGL", name: "Alphabet", exchange: "NASDAQ", sector: "Internet Services", description: "Parent company of Google Search, YouTube, Android and Google Cloud." },
  { symbol: "META", name: "Meta Platforms", exchange: "NASDAQ", sector: "Internet Services", description: "Runs Facebook, Instagram, WhatsApp and Messenger, and invests in AI and virtual reality." },
  { symbol: "AMD", name: "AMD", exchange: "NASDAQ", sector: "Semiconductors", description: "Designs CPUs, GPUs and adaptive chips for PCs, game consoles, data centres and embedded systems." },
  { symbol: "NFLX", name: "Netflix", exchange: "NASDAQ", sector: "Media & Streaming", description: "Subscription streaming service offering films, series and games in over 190 countries." },
  { symbol: "COIN", name: "Coinbase", exchange: "NASDAQ", sector: "Financial Services", description: "Operates a regulated crypto-asset exchange, custody and payments platform." },
];
