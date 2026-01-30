// Apify SDK - toolkit for building Apify Actors (Read more at https://docs.apify.com/sdk/js/)
import { Actor } from 'apify';
import { CheerioCrawler, Dataset } from 'crawlee';

// Initialize Actor
await Actor.init();

const input = (await Actor.getInput()) ?? {};
const {
  startUrls = ['https://angel.co/companies'],
  maxRequestsPerCrawl = 200,
  followInternalOnly = true,
} = input;

// Use Apify proxy (recommended)
const proxyConfiguration = await Actor.createProxyConfiguration();

const crawler = new CheerioCrawler({
  proxyConfiguration,
  maxRequestsPerCrawl,
  async requestHandler({ request, $, enqueueLinks, log }) {
    const url = request.loadedUrl ?? request.url;
    log.info('Processing', { url });

    // Enqueue likely portfolio and company pages
    await enqueueLinks({
      globs: [
        '**/portfolio/**',
        '**/portfolio*',
        '**/companies/**',
        '**/company/**',
        '**/companies/*',
        '**/team/*',
      ],
      transformRequestFunction: (r) => {
        if (followInternalOnly) {
          try {
            const startHost = new URL(request.userData.startHost || request.url).host;
            const candidateHost = new URL(r.url).host;
            if (candidateHost !== startHost) return null;
          } catch (e) {
            // ignore malformed URL
          }
        }
        return r;
      },
    });

    try {
      // Heuristics: if page looks like a VC firm portfolio listing, extract portfolio rows
      const bodyText = $('body').text().toLowerCase();

      // Try to detect firm name
      const vcFirm =
        $('meta[property="og:site_name"]').attr('content') ||
        $('meta[name="twitter:site"]').attr('content') ||
        $('h1, .company-name, header h1').first().text().trim() ||
        '';

      // Portfolio listing detection: look for lists/tables with company links
      const portfolioSelectors = $('[class*="portfolio"], [class*="companies"], [id*="portfolio"], .portfolio, .portfolio-list, .investments, .portfolio-grid');
      if (portfolioSelectors.length) {
        // Each candidate item: anchor to company, short description
        portfolioSelectors.find('a[href]').each(async (i, el) => {
          const $el = $(el);
          const href = $el.attr('href');
          if (!href) return;
          const abs = new URL(href, url).toString();
          const text = $el.text().trim();
          // Skip anchors that look like navigation
          if (!text || text.length < 2) return;

          // Try to get parent container for more metadata
          const parent = $el.closest('div, li, article, .card, .company');
          const description = parent.find('p').first().text().trim() || '';
          const industry = parent.find('.industry, .tag, .category').first().text().trim() || '';
          const tags = parent.find('.tag, .tags, .category').map((j, t) => $(t).text().trim()).get();

          await Dataset.pushData({
            vc_firm: vcFirm || '',
            portfolio_company: text || '',
            company_url: abs,
            industry,
            stage: '',
            investment_date: '',
            amount: '',
            description,
            tags: tags.length ? tags : [],
            source_url: url,
          });
        });
      }

      // Company page detection: if URL or page contains 'company' try to extract company metadata
      const isCompanyPage = url.includes('/company') || /company|about|portfolio/i.test(bodyText);
      if (isCompanyPage) {
        const companyName = $('h1').first().text().trim() || $('meta[property="og:title"]').attr('content') || '';
        const companyWebsite =
          $('a[href^="http"]').filter((i, a) => {
            const href = $(a).attr('href');
            return href && !href.includes(request.loadedUrl) && (href.includes('.') && !href.includes('twitter.com') && !href.includes('linkedin.com'));
          }).first().attr('href') || '';
        const industry = $('[class*="industry"], [class*="sector"], meta[name="keywords"]').first().text().trim() || '';
        const description =
          $('meta[name="description"]').attr('content') ||
          $('meta[property="og:description"]').attr('content') ||
          $('p').first().text().trim() ||
          '';

        // Investment details (may require structured pages or press release parsing)
        // Look for patterns like "Series A", "Seed", "$5M", or dates
        const pageText = $('body').text();
        const stageMatch = pageText.match(/\b(Seed|Pre[- ]?Seed|Series\s?[A-C]|Series\s?\d+|Venture|Angel)\b/i);
        const amountMatch = pageText.match(/(\$|USD)\s?[\d,]+(?:\.\d+)?\s?(k|m|bn)?/i);
        const dateMatch = pageText.match(/\b(January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2},\s+\d{4}\b/);

        await Dataset.pushData({
          vc_firm: vcFirm || '',
          portfolio_company: companyName || '',
          company_url: companyWebsite || url,
          industry: industry || '',
          stage: stageMatch ? stageMatch[0].trim() : '',
          investment_date: dateMatch ? dateMatch[0] : '',
          amount: amountMatch ? amountMatch[0] : '',
          description,
          tags: [],
          source_url: url,
        });
      }
    } catch (err) {
      log.warning('Extraction error', { url, message: err.message });
    }
  },
});

await crawler.run(startUrls);

// Exit Actor
await Actor.exit();
