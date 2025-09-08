#!/usr/bin/env node
// test-ec2.js - Test Chrome + Proxy on EC2

const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
puppeteer.use(StealthPlugin());

const PROXY_SERVER = 'http://gate.decodo.com:10001';
const PROXY_USERNAME = 'spu4sqmfbj';
const PROXY_PASSWORD = 'bBIDVcg2qh_q2xr72o';

async function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function testSetup() {
  console.log('Starting EC2 Chrome + Proxy test...\n');
  
  // Ensure Xvfb
  const { exec } = require('child_process');
  const { promisify } = require('util');
  const execAsync = promisify(exec);
  
  try {
    await execAsync('pgrep -x Xvfb');
    console.log('✓ Xvfb is running');
  } catch {
    console.log('Starting Xvfb...');
    await execAsync('Xvfb :99 -screen 0 1920x1080x24 &');
    await sleep(2000);
  }
  
  process.env.DISPLAY = ':99';
  
  console.log('Launching Chrome...');
  const browser = await puppeteer.launch({
    headless: false, // Headful mode
    executablePath: '/usr/bin/google-chrome-stable',
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--window-size=1920,1080',
      '--disable-blink-features=AutomationControlled',
      `--proxy-server=${PROXY_SERVER}`, // Proxy without auth in URL
    ],
    defaultViewport: null,
  });
  
  console.log('✓ Chrome launched\n');
  
  try {
    const page = await browser.newPage();
    
    // CRITICAL: Authenticate proxy
    await page.authenticate({
      username: PROXY_USERNAME,
      password: PROXY_PASSWORD
    });
    console.log('✓ Proxy authenticated\n');
    
    // Set user agent
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36');
    
    // Anti-detection
    await page.evaluateOnNewDocument(() => {
      Object.defineProperty(navigator, 'webdriver', {
        get: () => undefined
      });
      window.chrome = { runtime: {} };
    });
    
    // Test 1: Check IP
    console.log('Test 1: Checking IP address...');
    await page.goto('https://httpbin.org/ip', { waitUntil: 'networkidle2' });
    const ip = await page.evaluate(() => document.body.innerText);
    console.log('Your IP:', ip);
    console.log('(Should be a Decodo proxy IP, not your EC2 IP)\n');
    
    // Wait a bit between requests
    await sleep(3000);
    
    // Test 2: Try LinkedIn
    console.log('Test 2: Loading LinkedIn...');
    try {
      const response = await page.goto('https://www.linkedin.com', { 
        waitUntil: 'networkidle2',
        timeout: 30000 
      });
      
      const status = response.status();
      const url = page.url();
      const title = await page.title();
      
      console.log('Status:', status);
      console.log('URL:', url);
      console.log('Title:', title);
      
      if (status === 429) {
        console.log('\n⚠️  Got 429 (Rate Limited) - LinkedIn is detecting automation');
        console.log('This might be because:');
        console.log('1. The proxy IP is flagged');
        console.log('2. Too many requests from this proxy');
        console.log('3. Need to rotate proxy endpoints');
      } else if (status === 200) {
        console.log('\n✓ Successfully loaded LinkedIn!');
      }
      
      // Take screenshot
      await page.screenshot({ path: 'linkedin-test.png' });
      console.log('\nScreenshot saved as linkedin-test.png');
      
      // Check for specific elements
      const hasLoginForm = await page.$('#username') !== null;
      const hasFeed = await page.$('.feed-shared-update-v2') !== null;
      
      if (hasLoginForm) {
        console.log('✓ Login form detected - ready to authenticate');
      }
      if (hasFeed) {
        console.log('✓ Feed detected - already logged in?');
      }
      
    } catch (err) {
      console.error('Error loading LinkedIn:', err.message);
      
      // Check what page we're on
      const currentUrl = page.url();
      console.log('Current URL:', currentUrl);
      
      if (currentUrl.includes('chrome-error://')) {
        console.log('\n❌ Chrome error page - network/proxy issue');
      }
    }
    
  } catch (err) {
    console.error('Test failed:', err);
  } finally {
    await browser.close();
    console.log('\nTest complete');
  }
}

// Run test
testSetup().catch(console.error);