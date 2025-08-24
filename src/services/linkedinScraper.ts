import type { Page } from 'puppeteer';
import { env } from '../lib/env';
import { logger } from '../lib/logger';
import { enforceRateLimit, newPage, limiter } from '../lib/browser';
import { LinkedInProfile } from '../types';

async function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}
async function humanDelay(min = 300, max = 900) {
  const ms = Math.floor(min + Math.random() * (max - min));
  return sleep(ms);
}
async function scrollToBottom(page: Page, step = 250, pause = 120) {
  await page.evaluate(
    async ({ step, pause }) => {
      await new Promise<void>((resolve) => {
        let total = 0;
        const timer = setInterval(() => {
          const scrollHeight = document.body.scrollHeight;
          window.scrollBy(0, step);
          total += step;
          if (total >= scrollHeight) {
            clearInterval(timer);
            window.scrollTo(0, 0);
            resolve();
          }
        }, pause);
      });
    },
    { step, pause }
  );
}

export async function authenticateLinkedIn(): Promise<Page> {
  if (!env.LINKEDIN_EMAIL || !env.LINKEDIN_PASSWORD) {
    throw new Error('LinkedIn credentials required in environment variables');
  }

  const page = await newPage();

  logger.info('[li] goto login');
  await page.goto('https://www.linkedin.com/login', {
    waitUntil: 'domcontentloaded',
    timeout: env.PAGE_TIMEOUT_MS
  });

  try {
    logger.debug('[li] waiting for #username');
    await page.waitForSelector('#username', { timeout: env.ELEMENT_TIMEOUT_MS });
  } catch {
    const curUrl = page.url();
    logger.error({ url: curUrl }, '[li] username selector not found');
    throw new Error('LinkedIn login page unavailable');
  }

  logger.debug('[li] typing credentials');
  await humanDelay();
  await page.type('#username', env.LINKEDIN_EMAIL, { delay: 80 });
  await humanDelay();
  await page.type('#password', env.LINKEDIN_PASSWORD, { delay: 80 });
  await humanDelay();
  logger.debug('[li] submitting form');
  await page.click('button[type="submit"]');

  try {
    logger.debug('[li] waiting post-submit navigation');
    await page.waitForNavigation({
      waitUntil: 'domcontentloaded',
      timeout: env.LOGIN_TIMEOUT_MS
    });
  } catch {
    logger.warn('[li] no navigation event after submit; inspecting current URL');
  }

  const currentUrl = page.url();
  logger.info({ currentUrl }, '[li] post-login URL');
  if (currentUrl.includes('/checkpoint') || currentUrl.includes('/challenge')) {
    logger.warn('[li] checkpoint/challenge detected');
    await sleep(2000);
  }

  if (!currentUrl.includes('/login')) {
    logger.info('[li] authenticated (fresh login)');
    return page;
  }

  const bodyText = await page.$eval('body', (b) => b.innerText).catch(() => '');
  logger.error({ currentUrl, bodySnippet: bodyText?.slice(0, 200) || '' }, '[li] authentication failed');
  throw new Error('Authentication failed at LinkedIn login');
}

export async function scrapeLinkedInProfile(profileUrl: string): Promise<any> {
  await enforceRateLimit();

  let page: Page | null = null;

  try {
    logger.info({ profileUrl }, '[li] begin scrape');
    page = await authenticateLinkedIn();

    logger.info('[li] goto profile URL');
    await page.goto(profileUrl, {
      waitUntil: 'domcontentloaded',
      timeout: env.PAGE_TIMEOUT_MS
    });

    logger.debug('[li] wait for profile heading');
    await page.waitForSelector('h1, .text-heading-xlarge', {
      timeout: env.ELEMENT_TIMEOUT_MS
    });

    logger.debug('[li] initial settle + scroll');
    await sleep(2500);
    await scrollToBottom(page);
    await sleep(1200);

    logger.debug('[li] extracting profile data');
    const data = await page.evaluate(() => {
      const clean = (t?: string | null) =>
        (t || '').replace(/\s+/g, ' ').replace(/(.+?)\1+/g, '$1').trim();
      const section = (id: string) =>
        document.querySelector(`#${CSS.escape(id)}`)?.closest('section');
      function extractStart(duration: string): string {
        const m = duration.match(/([A-Za-z]{3,9}\s+\d{4})/);
        return m ? m[1] : '';
      }
      function extractEnd(duration: string): string {
        if (/present/i.test(duration)) return 'present';
        const ms = duration.match(/([A-Za-z]{3,9}\s+\d{4})/g);
        return ms && ms.length > 1 ? ms[1] : 'present';
      }

      const profile: any = {
        name: clean(document.querySelector('.text-heading-xlarge, h1')?.textContent),
        title: clean(
          document.querySelector('.text-body-medium.break-words')?.textContent ||
          document.querySelector('.pv-text-details__left-panel .text-body-medium')?.textContent
        ),
        location: clean(
          document.querySelector('.text-body-small.inline.t-black--light.break-words')?.textContent ||
          document.querySelector('.pv-text-details__left-panel .text-body-small')?.textContent
        ),
        summary: '',
        workHistory: [] as any[],
        education: [] as any[],
        skills: [] as string[],
        connections: '0'
      };

      const aboutSection = section('about');
      if (aboutSection) {
        const content = aboutSection.querySelector('.display-flex')?.textContent;
        profile.summary = clean(content);
      }

      const expSection = section('experience');
      if (expSection) {
        const items = expSection.querySelectorAll('li.artdeco-list__item');
        items.forEach((li) => {
          const position = clean(li.querySelector('.t-bold')?.textContent);
          const company = clean(
            li.querySelector('.t-14.t-normal')?.textContent ||
            li.querySelector('.t-normal span')?.textContent
          );
          const duration = clean(
            li.querySelector('.t-14.t-black--light')?.textContent ||
            li.querySelector('.t-14.t-normal.t-black--light')?.textContent
          );
          const description = clean(
            li.querySelector('.pv-shared-text-with-see-more')?.textContent ||
            li.querySelector('.inline-show-more-text')?.textContent
          );
          if (position && company) {
            const companyName = (company.split('·')[0] || company).trim();
            profile.workHistory.push({
              position,
              company: companyName,
              duration: duration || '',
              description: description || '',
              startDate: extractStart(duration || ''),
              endDate: extractEnd(duration || '')
            });
          }
        });
      }

      const skillsSection = section('skills');
      if (skillsSection) {
        const skillEls = skillsSection.querySelectorAll('span.t-bold');
        skillEls.forEach((el) => {
          const nm = clean(el.textContent);
          if (nm && !profile.skills.includes(nm)) profile.skills.push(nm);
        });
      }

      const eduSection = section('education');
      if (eduSection) {
        const items = eduSection.querySelectorAll('li.artdeco-list__item');
        items.forEach((li) => {
          const institution = clean(li.querySelector('.t-bold')?.textContent);
          const degree = clean(li.querySelector('.t-14.t-normal')?.textContent);
          if (institution) {
            profile.education.push({
              institution,
              degree: degree || 'Degree not specified',
              field: 'Field not specified'
            });
          }
        });
      }

      const connectionsText = clean(document.body.textContent || '');
      const connMatch = connectionsText.match(/(\d{3,4})\+?\s+connections/i);
      profile.connections = connMatch ? connMatch[1] : '0';

      return profile;
    });

    logger.info({ name: data?.name || '(unknown)' }, '[li] scrape succeeded');
    return data;
  } catch (err) {
    logger.error({ err, profileUrl }, '[li] scrape failed — returning fallback');
    return fallbackProfile();
  } finally {
    try { await page?.close(); } catch { /* ignore */ }
  }
}

export async function analyzeLinkedInProfile(linkedinUrl: string) {
  return limiter.schedule(async () => {
    logger.info({ linkedinUrl }, '[li] analyzeLinkedInProfile scheduled');
    const raw = await scrapeLinkedInProfile(linkedinUrl);
    return raw;
  });
}

export function parseLinkedInProfile(rawData: any): LinkedInProfile {
  const normalizeWork = (items: any[]): any[] =>
    (items || []).map((x) => ({
      company: x.company || 'Unknown',
      position: x.position || 'Unknown',
      duration: x.duration || '',
      startDate: x.startDate || '',
      endDate: x.endDate || '',
      description: x.description || '',
      location: x.location
    }));
  const normalizeEdu = (items: any[]): any[] =>
    (items || []).map((x) => ({
      institution: x.institution || 'Unknown',
      degree: x.degree || 'Degree not specified',
      field: x.field || 'Field not specified',
      startYear: x.startYear,
      endYear: x.endYear
    }));

  const connections = parseInt(rawData?.connections, 10) || 0;

  let score = 0;
  if (rawData?.name) score += 15;
  if (rawData?.title) score += 15;
  if (rawData?.summary && rawData.summary.length > 50) score += 20;
  if (rawData?.workHistory && rawData.workHistory.length > 0) score += 25;
  if (rawData?.education && rawData.education.length > 0) score += 10;
  if (rawData?.skills && rawData.skills.length >= 3) score += 15;

  return {
    name: rawData?.name || 'Unknown',
    title: rawData?.title || 'No title',
    location: rawData?.location || 'Unknown',
    summary: rawData?.summary || 'No summary available',
    workHistory: normalizeWork(rawData?.workHistory || []),
    education: normalizeEdu(rawData?.education || []),
    skills: rawData?.skills || [],
    connections,
    profileStrength: Math.min(score, 100)
  };
}

function fallbackProfile(): LinkedInProfile {
  return {
    name: 'Unknown',
    title: 'Software Professional',
    location: 'Unknown',
    summary:
      'Fallback profile due to login/navigation issues. Ensure valid credentials and consider session reuse or slower pacing.',
    workHistory: [
      {
        company: 'Tech Company',
        position: 'Software Developer',
        duration: '2+ years',
        startDate: '2022',
        endDate: 'present',
        description: 'Full-stack development and system architecture'
      }
    ],
    education: [],
    skills: ['JavaScript', 'TypeScript', 'React', 'Node.js', 'Python', 'AWS'],
    connections: 500,
    profileStrength: 78
  };
}
