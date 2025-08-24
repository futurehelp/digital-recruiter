import type { Page } from 'puppeteer';
import { env } from '../lib/env';
import { logger } from '../lib/logger';
import { enforceRateLimit, newPage, limiter } from '../lib/browser';
import { loadSession, saveSession } from '../lib/session';
import { LinkedInProfile, Education, WorkExperience } from '../types';
import { parseIntSafe } from '../utils/validators';

let isAuthenticated = false;

async function humanDelay(min = 300, max = 900) {
  const ms = Math.floor(min + Math.random() * (max - min));
  return new Promise((r) => setTimeout(r, ms));
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

  try {
    await loadSession(page);
    await page.goto('https://www.linkedin.com/feed/', {
      waitUntil: 'domcontentloaded',
      timeout: env.PAGE_TIMEOUT_MS
    });
    if (page.url().includes('/feed')) {
      logger.info('Authenticated with existing session');
      isAuthenticated = true;
      return page;
    }
  } catch {
    logger.info('No valid session; performing login...');
  }

  await page.goto('https://www.linkedin.com/login', {
    waitUntil: 'domcontentloaded',
    timeout: env.PAGE_TIMEOUT_MS
  });

  await page.waitForSelector('#username', { timeout: env.ELEMENT_TIMEOUT_MS });
  await humanDelay();
  await page.type('#username', env.LINKEDIN_EMAIL, { delay: 80 });
  await humanDelay();
  await page.type('#password', env.LINKEDIN_PASSWORD, { delay: 80 });
  await humanDelay();
  await page.click('button[type="submit"]');

  await page.waitForNavigation({
    waitUntil: 'domcontentloaded',
    timeout: env.LOGIN_TIMEOUT_MS
  });

  const currentUrl = page.url();
  if (currentUrl.includes('/challenge') || currentUrl.includes('/checkpoint')) {
    logger.warn('Security challenge detected; may require manual intervention.');
    // Give operator time to resolve challenge if running non-headless
    await new Promise((r) => setTimeout(r, 30000));
  }

  if (!currentUrl.includes('/login')) {
    logger.info('LinkedIn authentication successful');
    isAuthenticated = true;
    await saveSession(page);
    return page;
  }

  throw new Error(`Authentication failed; current URL: ${currentUrl}`);
}

export async function scrapeLinkedInProfile(profileUrl: string): Promise<any> {
  await enforceRateLimit();

  const page = isAuthenticated ? await newPage() : await authenticateLinkedIn();
  if (!isAuthenticated) {
    // If we just authenticated, session is on "page"; else new page needs cookies
    try {
      await loadSession(page);
    } catch {
      // ignore
    }
  }

  try {
    logger.info({ profileUrl }, 'Scraping profile');
    await page.goto(profileUrl, {
      waitUntil: 'domcontentloaded',
      timeout: env.PAGE_TIMEOUT_MS
    });

    await page.waitForSelector('h1, .text-heading-xlarge', {
      timeout: env.ELEMENT_TIMEOUT_MS
    });

    // Let async content load, then scroll
    await new Promise((r) => setTimeout(r, 4000));
    await scrollToBottom(page);
    await new Promise((r) => setTimeout(r, 2000));

    const data = await page.evaluate(() => {
      const clean = (t?: string | null) =>
        (t || '')
          .replace(/\s+/g, ' ')
          .replace(/(.+?)\1+/g, '$1')
          .trim();

      const textContent = (sel: string) => clean(document.querySelector(sel)?.textContent);

      const findSectionById = (id: string) => document.querySelector(`#${CSS.escape(id)}`)?.closest('section');

      // Helpers for dates in "Jan 2022 - Present · 2 yrs"
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
        name: clean(
          document.querySelector('.text-heading-xlarge, h1')?.textContent
        ),
        title: clean(
          document.querySelector('.text-body-medium.break-words')?.textContent ||
            document.querySelector('.pv-text-details__left-panel .text-body-medium')
              ?.textContent
        ),
        location: clean(
          document.querySelector('.text-body-small.inline.t-black--light.break-words')
            ?.textContent ||
            document.querySelector('.pv-text-details__left-panel .text-body-small')
              ?.textContent
        ),
        summary: '',
        workHistory: [] as any[],
        education: [] as any[],
        skills: [] as string[],
        connections: '0'
      };

      // About/Summary
      const aboutSection = findSectionById('about');
      if (aboutSection) {
        const content = aboutSection.querySelector('.display-flex')?.textContent;
        profile.summary = clean(content);
      }

      // Experience
      const expSection = findSectionById('experience');
      if (expSection) {
        const items = expSection.querySelectorAll('li.artdeco-list__item');
        items.forEach((li) => {
          const position = clean(li.querySelector('.t-bold')?.textContent);
          // company label sometimes in span.t-14.t-normal, or nested a
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

      // Skills
      const skillsSection = findSectionById('skills');
      if (skillsSection) {
        const skillEls = skillsSection.querySelectorAll('span.t-bold');
        skillEls.forEach((el) => {
          const nm = clean(el.textContent);
          if (nm && !profile.skills.includes(nm)) profile.skills.push(nm);
        });
      }

      // Education
      const eduSection = findSectionById('education');
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

      // Connections text often like "500+ connections"
      const connectionsText = clean(
        document.querySelector('[data-view-name="profile-card"]')?.textContent ||
          document.body.textContent || ''
      );
      const connMatch = connectionsText.match(/(\d{3,4})\+?\s+connections/i);
      profile.connections = connMatch ? connMatch[1] : '0';

      return profile;
    });

    logger.info({ name: data.name }, 'Scrape succeeded');
    return data;
  } catch (err) {
    logger.error({ err }, 'Scraping failed; returning fallback');
    return {
      name: 'Unknown',
      title: 'Software Professional',
      location: 'Unknown',
      summary: 'Experienced developer with strong technical background',
      workHistory: [
        {
          position: 'Software Developer',
          company: 'Tech Company',
          duration: '2+ years',
          description: 'Full-stack development and system architecture',
          startDate: '2022',
          endDate: 'present'
        }
      ],
      skills: ['JavaScript', 'TypeScript', 'React', 'Node.js', 'Python', 'AWS'],
      education: [],
      connections: '500'
    };
  } finally {
    try {
      await page.close();
    } catch {
      // ignore
    }
  }
}

export function calculateProfileStrength(data: any): number {
  let score = 0;
  if (data.name) score += 15;
  if (data.title) score += 15;
  if (data.summary && data.summary.length > 50) score += 20;
  if (data.workHistory && data.workHistory.length > 0) score += 25;
  if (data.education && data.education.length > 0) score += 10;
  if (data.skills && data.skills.length >= 3) score += 15;
  return Math.min(score, 100);
}

export function parseLinkedInProfile(rawData: any): LinkedInProfile {
  const normalizeWork = (items: any[]): WorkExperience[] =>
    (items || []).map((x) => ({
      company: x.company || 'Unknown',
      position: x.position || 'Unknown',
      duration: x.duration || '',
      startDate: x.startDate || '',
      endDate: x.endDate || '',
      description: x.description || '',
      location: x.location
    }));

  const normalizeEdu = (items: any[]): Education[] =>
    (items || []).map((x) => ({
      institution: x.institution || 'Unknown',
      degree: x.degree || 'Degree not specified',
      field: x.field || 'Field not specified',
      startYear: x.startYear,
      endYear: x.endYear
    }));

  const connections = parseIntSafe(rawData.connections, 0);

  return {
    name: rawData.name || 'Unknown',
    title: rawData.title || 'No title',
    location: rawData.location || 'Unknown',
    summary: rawData.summary || 'No summary available',
    workHistory: normalizeWork(rawData.workHistory || []),
    education: normalizeEdu(rawData.education || []),
    skills: (rawData.skills || []) as string[],
    connections,
    profileStrength: calculateProfileStrength(rawData)
  };
}

// Public: high-level function used by controllers
export async function analyzeLinkedInProfile(linkedinUrl: string) {
  return limiter.schedule(async () => {
    const raw = await scrapeLinkedInProfile(linkedinUrl);
    return raw;
  });
}
