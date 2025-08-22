const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const RecaptchaPlugin = require('puppeteer-extra-plugin-recaptcha');
const express = require('express');
const fs = require('fs').promises;
const path = require('path');
const { faker } = require('@faker-js/faker');
const crypto = require('crypto');
const Sentry = require('@sentry/node');
const { GoLogin } = require('gologin');
const { createNoise2D } = require('simplex-noise');
const sqlite3 = require('sqlite3')
const { GoogleGenerativeAI } = require("@google/generative-ai");
const axios = require('axios');
const Mailjs = require('@cemalgnlts/mailjs');
require('dotenv').config();

const PORT = process.env.PORT || 3005;

// Gemini setup
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const model = genAI.getGenerativeModel({ model: "gemini-2.5-pro-exp-03-25" });

// Default configuration with all toggles
const defaultConfig = {
  headless: false,
  slowMo: 50 * 2,
  useProxy: false,
  proxyList: [],
  rotateUserAgent: true,
  randomDelays: true,
  mouseMovements: true,
  pageLoadRetries: true,
  usernamePrefix: 'Bot_',
  useComplexPassword: true,
  captchaMode: 'auto',
  emailMode: 'api',
  emailProvider: 'mail.tm',
  retriesEnabled: true,
  maxRetries: 1,
  useExponentialBackoff: true,
  switchProxyOnFail: true,
  useSentry: true,
  warmUpEnabled: false,
  warmUpDuration: 120000,
  rateLimitEnabled: true,
  rateLimitPerIP: 5,
  rateLimitWindow: 3600000,
  useContentApi: false, // Enable Gemini for dynamic selectors
  // registrationMode: 'hybrid',
  manualSelectors: {
    email: 'faceplate-text-input#register-email',
    username: '#register-username',
    password: '#register-password',
    submit: '[type="submit"]',
    gender: '#gender-prefer-not-to-say',
    interest: '[data-interest="popular"]',
    continue: '#continue-button',
    verification_code: '#email-verify > auth-flow-modal > div.font-sans.bg-ui-modalbackground.pb-\\[env\\(safe-area-inset-bottom\\)\\] > div > fieldset > faceplate-text-input' // Add this (inspect Reddit’s field)
  },
  tellStory: true, // Include story in prompts
  saveLearnedSelectors: true, // Save learned selectors
  learnedSelectors: {}, // Loaded below
  useGoLogin: true,
  goLoginToken: process.env.GOLOGIN_TOKEN,
  goLoginProfileId: process.env.GOLOGIN_PROFILE,
  useThreeDotMenu: false,
  hoverBeforeClick: true,
  readingTime: 2000,
  screenshotOnFail: true,
  logDir: './logs',
  noiseScale: 20,
  createNewProfile: false,
  profileOs: 'lin',
  refreshFingerprint: false,
  extensionPaths: [],
  applyFingerprint: false,
  rejectCookies: true, // Enable cookie rejection
  //Uncomment this if you want to manually specify it, else it should get fetched automatically
  // timezone: JSON.parse('{"ip":"104.28.224.49","country":"US","stateProv":"New York","city":"New York","timezone":"America/New_York","ll":["40.7128","-74.0060"],"languages":"en","accuracy":100}'),
  genderChoice: 4,        // Integer: 0-3 valid (e.g., 4 % 4 = 0), selects position
  topicCategory: 1,       // Integer: Category index (e.g., 1 % numCategories)
  numTopics: 2,           // Integer: Number of topics to select
  topicIndices: [0, 3],   // Array of integers: Specific topic positions in selected category
  validateClicks: false,   // Boolean: Enable click validation (optional)
  topicIndices: [0, 3],        // Specific topic indices
};

// Load learned selectors
(async () => {
  try {
    defaultConfig.learnedSelectors = JSON.parse(await fs.readFile('learned_selectors.json', 'utf8'));
  } catch {
    defaultConfig.learnedSelectors = {};
  }
})();

const SELECTORS = {
  desktop: {
    loginButton: 'auth-flow-link[step="login"]', // Opens the modal (replacing #login-button)
    threeDotMenu: '#expand-user-drawer-button', // Still valid for menu path
    loginSignUpMenu: 'auth-flow-link[step="login"]', // Menu item to open modal
    signUpButton: 'faceplate-tracker[noun="login"]',
    modalsignUpButton: 'auth-flow-link[step="register"]',
    emailField: 'faceplate-text-input#register-email', // Updated to match custom element
    passwordField: 'faceplate-text-input#login-password' // Assuming this still holds
  },
  mobile: {
    loginButton: 'faceplate-tracker[noun="login"]', // Mobile "Log In" link
    threeDotMenu: '#expand-user-drawer-button',
    loginSignUpMenu: 'auth-flow-link[step="login"]',
    signUpButton: 'faceplate-tracker[noun="login"]',
    modalsignUpButton: 'auth-flow-link[step="register"]',
    emailField: 'faceplate-text-input#register-email',
    passwordField: 'faceplate-text-input#login-password'
  }
};

// Global state
let pageContent = { html: null, screenshot: null, timestamp: null };
let story = [];

// Initialize plugins
puppeteer.use(StealthPlugin());
puppeteer.use(RecaptchaPlugin({
  provider: { id: '2captcha', token: process.env.TWOCAPTCHA_KEY || '' },
}));

Sentry.init({
  dsn: process.env.SENTRY_KEY || '',
  profileSessionSampleRate: 1.0,
});

// Ensure log directory exists
(async () => await fs.mkdir(defaultConfig.logDir, { recursive: true }))();

// Database Functions
async function initDatabase() {
  const dbPath = path.join(__dirname, 'accounts.db');
  const db = new sqlite3.Database(dbPath, (err) => {
    if (err) throw new Error(`Database connection failed: ${err.message}`);
  });

  await new Promise((resolve, reject) => {
    db.run(`
      CREATE TABLE IF NOT EXISTS accounts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT UNIQUE,
        password TEXT,
        email TEXT,
        proxy TEXT,
        profile_id TEXT,
        fingerprint TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `, (err) => {
      if (err) reject(new Error(`Database initialization failed: ${err.message}`));
      else resolve();
    });
  });

  return db;
}


async function saveAccountToDatabase(db, { username, password, email, proxy, profileId, fingerprint }) {
  try {
    await new Promise((resolve, reject) => {
      db.run(`
                INSERT INTO accounts (username, password, email, proxy, profile_id, fingerprint)
                VALUES (?, ?, ?, ?, ?, ?)
            `, [username, password, email, proxy || 'none', profileId || 'none', JSON.stringify(fingerprint)],
        (err) => {
          if (err) reject(new Error(`Failed to save account: ${err.message}`));
          else resolve();
        });
    });
    await log(`Saved account ${username} to database`);
  } catch (error) {
    await log(`Error saving account to database: ${error.message}`);
    throw error;
  }
}

// Utility Functions
async function log(message) {
  const timestamp = new Date().toISOString();
  console.log(`[${timestamp}] ${message}`);
  await fs.appendFile(path.join(defaultConfig.logDir, 'script.log'), `[${timestamp}] ${message}\n`);
}

async function generateUniqueUsername(config) {
  const baseLength = Math.floor(Math.random() * 3) + 4; // 4-6 chars
  const numLength = Math.floor(Math.random() * 2) + 3; // 3-4 nums
  const base = faker.internet.username({ length: baseLength }).slice(0, baseLength);

  const name = faker.internet.username({ length: baseLength }).slice(0, baseLength);

  const nums = faker.string.numeric({ length: numLength });
  return `${name}_${base}${nums}`; // e.g., Bot_Joel9228
}

async function rejectNonEssentialCookies(page, config) {
  const bannerHostSelector = 'body > shreddit-app > shreddit-async-loader:nth-child(4) > reddit-cookie-banner';
  const rejectButtonSelector = '#reject-nonessential-cookies-button > button';

  // Run indefinitely in the background
  const checkInterval = setInterval(async () => {
    try {
      // Check if the cookie banner is visible within its shadow DOM
      const bannerVisible = await page.evaluate((hostSel) => {
        const banner = document.querySelector(hostSel);
        return !!banner && !!banner.shadowRoot;
      }, bannerHostSelector);

      if (bannerVisible) {
        await log('Cookie banner detected in shadow DOM, attempting to reject non-essential cookies');

        // Click the reject button inside the shadow DOM
        const buttonClicked = await page.evaluate((hostSel, buttonSel) => {
          const banner = document.querySelector(hostSel);
          if (!banner || !banner.shadowRoot) return false;
          const button = banner.shadowRoot.querySelector(buttonSel);
          if (!button) return false;
          button.click(); // Direct click since natural movement needs DOM element handle
          return true;
        }, bannerHostSelector, rejectButtonSelector);

        if (!buttonClicked) throw new Error('Reject button not found in shadow DOM');

        // Verify the banner is gone (host element or shadow content disappears)
        await page.waitForFunction((hostSel) => {
          const banner = document.querySelector(hostSel);
          return !banner || !banner.shadowRoot.querySelector('#reject-nonessential-cookies-button');
        }, { timeout: 10000 }, bannerHostSelector);

        await log('Successfully rejected non-essential cookies');
      }
    } catch (error) {
      await log(`Cookie rejection failed: ${error.message}`);
      await takeScreenshot(page, 'cookie-reject-fail', config); // Debug screenshot
    }
  }, 5000); // Check every 5 seconds

  return checkInterval;
}

async function capturePageContent(page) {
  if (!page) return;
  const html = await page.evaluate(() => {
    const elements = document.querySelectorAll('*');
    let cleanHtml = document.documentElement.outerHTML;
    elements.forEach(el => {
      if (el.shadowRoot) {
        cleanHtml = cleanHtml.replace(el.shadowRoot.innerHTML, '');
      }
    });
    return cleanHtml;
  });
  const screenshot = await page.screenshot({ encoding: 'base64' });
  pageContent = { html, screenshot, timestamp: new Date().toISOString() };
  return pageContent;
}

async function queryLLM(config, pageContent, step, value = null) {
  const prompt = config.tellStory
    ? `Story so far: ${JSON.stringify(story)}. Current step: ${step}. Using the screenshot and HTML (excluding shadow DOM), find the element with text "${step}" to ${value ? 'type into' : 'click'}. Provide a CSS selector in a JSON object like {"selector": "#id", "action": "click"}. Avoid shadow DOM elements.`
    : `Using the screenshot and HTML (excluding shadow DOM), find the element with text "${step}" to ${value ? 'type into' : 'click'}. Provide a CSS selector in a JSON object like {"selector": "#id", "action": "click"}. Avoid shadow DOM elements.`;

  try {
    const chatSession = model.startChat({
      generationConfig: {
        temperature: 1,
        topP: 0.95,
        topK: 64,
        maxOutputTokens: 65536,
        responseMimeType: "application/json",
      },
      history: [],
    });

    const messageParts = [
      { text: prompt },
      { inlineData: { mimeType: "image/png", data: pageContent.screenshot } },
      { text: pageContent.html }
    ];

    await log(`Sending prompt to Gemini: ${prompt}`);
    const result = await chatSession.sendMessage(messageParts);
    const responseText = result.response.text();
    await log(`Gemini response: ${responseText}`);

    const responseJson = JSON.parse(responseText);
    if (!responseJson.selector || !responseJson.action) {
      throw new Error("Invalid response format from Gemini");
    }
    return responseJson;
  } catch (error) {
    await log(`Gemini query failed: ${error.message}`);
    throw error;
  }
}

async function performAction(page, config, step, value = null) {
  let selector, action;

  if (config.useContentApi && config.learnedSelectors && config.learnedSelectors[step]) {
    selector = config.learnedSelectors[step];
    action = value ? 'type' : 'click';
  } else if (config.useContentApi || config.registrationMode === 'hybrid') {
    const pageContent = await capturePageContent(page);
    const llmResponse = await queryLLM(config, pageContent, step, value);
    selector = llmResponse.selector;
    action = llmResponse.action;

    const elements = await page.$$(selector);
    if (elements.length > 1) {
      for (const el of elements) {
        const text = await page.evaluate(element => element.textContent, el);
        if (text.toLowerCase().includes(step.toLowerCase())) {
          selector = await page.evaluate(element => {
            return element.id ? `#${element.id}` : element.getAttribute('class') ? `.${element.className.split(' ')[0]}` : null;
          }, el) || selector;
          break;
        }
      }
    }
  } else {
    selector = config.manualSelectors[step];
    action = value ? 'type' : 'click';
  }

  if (!selector) throw new Error(`No selector for ${step}`);

  await clickElementWithNaturalMovement(page, selector, config);
  if (action === 'type' && value) {
    await page.type(selector, value, { delay: config.randomDelays ? Math.random() * 100 + 50 : 0 });
  }

  if (config.tellStory) {
    story.push({ step, action, result: `Used selector ${selector}` });
  }

  if (config.useContentApi && config.saveLearnedSelectors) {
    config.learnedSelectors[step] = selector;
    await fs.writeFile('learned_selectors.json', JSON.stringify(config.learnedSelectors, null, 2));
    await log(`Saved learned selector for ${step}: ${selector}`);
  }
}

class ProxyManager {
  constructor(proxies) {
    this.proxies = proxies || [];
    this.currentIndex = 0;
  }
  getNext() {
    if (!this.proxies.length) return null;
    const proxy = this.proxies[this.currentIndex];
    this.currentIndex = (this.currentIndex + 1) % this.proxies.length;
    return proxy;
  }
}

class RateLimiter {
  constructor(limit, windowMs) {
    this.limit = limit;
    this.windowMs = windowMs;
    this.requests = new Map();
  }
  check(ip) {
    const now = Date.now();
    const count = this.requests.get(ip) || 0;
    if (count >= this.limit) return false;
    this.requests.set(ip, count + 1);
    setTimeout(() => this.requests.delete(ip), this.windowMs);
    return true;
  }
}

async function launchBrowser(config, proxy) {
  let browser, glInstance;
  await log('Launching browser');
  try {
    if (config.useGoLogin) {
      if (!config.goLoginToken) throw new Error('GoLogin access token is missing');
      glInstance = new GoLogin({
        token: config.goLoginToken,
        profile_id: config.goLoginProfileId,
        ...(proxy && { proxy }),
        headless: config.headless || false,
        autoUpdateBrowser: true,
        args: proxy ? [`--proxy-server=${proxy}`] : ['--no-sandbox'],
      });

      if (!config.goLoginProfileId && config.createNewProfile) {
        const { id } = await glInstance.quickCreateProfile('auto-generated-local');
        await glInstance.setProfileId(id);
        await log(`Created new local profile: ${id}`);
      }

      const startResult = await glInstance.startLocal();
      browser = await puppeteer.connect({
        browserWSEndpoint: startResult.wsUrl.toString(),
        ignoreHTTPSErrors: true,
      });
    } else {
      browser = await puppeteer.launch({
        headless: config.headless || false,
        slowMo: config.slowMo || 0,
        args: proxy ? [`--proxy-server=${proxy}`] : ['--no-sandbox'],
      });
    }
    browser.glInstance = glInstance; // Attach GoLogin instance
    return { browser, glInstance };
  } catch (error) {
    await log(`Browser launch failed: ${error.message}`);
    throw error;
  }
}

async function navigateTo(page, url, config) {
  await log(`Navigating to ${url}`);
  for (let i = 0; i < (config.pageLoadRetries ? 3 : 1); i++) {
    try {
      await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });
      if (config.useContentApi) await capturePageContent(page);
      break;
    } catch {
      if (i === 2) throw new Error('Page load failed');
    }
  }
  if (config.randomDelays) await new Promise(r => setTimeout(r, Math.random() * 1000 + 500));
  await new Promise(r => setTimeout(r, config.readingTime));
}

async function isMobileViewport(page) {
  const dimensions = await page.evaluate(() => ({
    width: window.innerWidth,
    height: window.innerHeight
  }));
  return dimensions.width <= 800; // Changed from 768 to 800
}

async function getElementPosition(page, selector) {
  const element = await page.$(selector);
  if (!element) throw new Error(`Element not found: ${selector}`);
  await element.scrollIntoViewIfNeeded();
  const boundingBox = await element.boundingBox();
  return {
    x: boundingBox.x + boundingBox.width / 2,
    y: boundingBox.y + boundingBox.height / 2
  };
}

async function simulateMouseMovement(page, startX, startY, endX, endY, config) {
  if (!config.mouseMovements) return;

  const noise2D = createNoise2D();
  const steps = 50;
  const noiseScale = config.noiseScale || 20;
  const baseDelay = config.randomDelays ? Math.random() * 10 + 10 : 20;

  const path = [];
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const x = startX + (endX - startX) * t + noise2D(t * 10, 0) * noiseScale;
    const y = startY + (endY - startY) * t + noise2D(0, t * 10) * noiseScale;
    const delay = baseDelay * (1 + Math.random() * 0.5);
    path.push({ x: Math.round(x), y: Math.round(y), delay });
  }

  await page.mouse.move(startX, startY);
  for (const point of path) {
    await page.mouse.move(point.x, point.y, { steps: 1 });
    await new Promise(resolve => setTimeout(resolve, point.delay));
  }

  if (config.hoverBeforeClick) {
    await page.mouse.move(endX, endY);
    await new Promise(resolve => setTimeout(resolve, 100));
  }
}

async function clickElementWithNaturalMovement(page, target, config, { startX = 0, startY = 0, isShadow = false } = {}) {
  let element;

  if (typeof target === 'string') {
    if (isShadow) {
      // Handle shadow DOM selector
      element = await page.evaluateHandle((sel) => {
        const slotter = document.querySelector('body > shreddit-app > auth-flow-manager > span[slot="onboarding"] > faceplate-partial > onboarding-flow > shreddit-slotter');
        return slotter && slotter.shadowRoot ? slotter.shadowRoot.querySelector(sel.split(' ').pop()) : null;
      }, target);
      if (!element.asElement()) throw new Error(`Shadow DOM element not found: ${target}`);
    } else {
      // Regular DOM selector
      element = await page.$(target);
      if (!element) throw new Error(`Element not found: ${target}`);
    }
  } else {
    // Assume it’s an ElementHandle (e.g., passed directly)
    element = target;
  }

  await element.scrollIntoViewIfNeeded();
  const box = await element.boundingBox();
  if (!box) throw new Error(`Element not clickable (no bounding box): ${typeof target === 'string' ? target : 'ElementHandle'}`);
  const { x: endX, y: endY, width, height } = box;

  // Use center of element for consistency
  const targetX = endX + width / 2;
  const targetY = endY + height / 2;

  await simulateMouseMovement(page, startX, startY, targetX, targetY, config);
  if (config.hoverBeforeClick) {
    await page.mouse.move(targetX, targetY);
    await new Promise(r => setTimeout(r, 100));
  }
  await page.mouse.click(targetX, targetY); // Use mouse.click for precision
  await log(`Clicked element: ${typeof target === 'string' ? target : 'ElementHandle'}`);
}
async function retry(fn, config, retries = config.maxRetries) {
  try {
    return await fn();
  } catch (error) {
    if (retries > 0) {
      await log(`Retrying (${config.maxRetries - retries + 1}) due to: ${error.message}`);
      await new Promise(r => setTimeout(r, 1000));
      return await retry(fn, config, retries - 1);
    }
    throw error;
  }
}

async function takeScreenshot(page, name, config) {
  if (config.screenshotOnFail && page) {
    const timestamp = new Date().toISOString().replace(/:/g, '-');
    const filePath = path.join(config.logDir, `${name}-${timestamp}.png`);
    await page.screenshot({ path: filePath });
    await log(`Screenshot saved: ${filePath}`);
  }
}

async function handleMainPage(page, config, browser) {
  const isMobile = await isMobileViewport(page);
  const selectors = isMobile ? SELECTORS.mobile : SELECTORS.desktop;
  // const signupModalSelector = 'auth-flow-manager[step-name="register"]';
  const signupModalSelector = 'auth-flow-manager';

  await retry(async () => {
    // Check if the signup modal is already visible
    const modalVisible = await page.$(signupModalSelector) !== null;
    if (!modalVisible) {
      // Modal isn’t up—let’s open it
      if (!config.useThreeDotMenu && !isMobile) {
        await clickElementWithNaturalMovement(page, selectors.loginButton, config);
      } else {
        await clickElementWithNaturalMovement(page, selectors.threeDotMenu, config);
        await page.waitForSelector(selectors.loginSignUpMenu, { visible: true, timeout: 5000 });
        await clickElementWithNaturalMovement(page, selectors.loginSignUpMenu, config);
      }

      // Wait for the modal to appear using MutationObserver
      await page.evaluate(() => {
        return new Promise((resolve) => {
          const observer = new MutationObserver((mutations, obs) => {
            const modal = document.querySelector('auth-flow-manager');
            if (modal) {
              obs.disconnect(); // Stop observing once found
              resolve();
            }
          });
          observer.observe(document.body, { childList: true, subtree: true });
          // Fallback timeout if modal never shows (10s)
          setTimeout(() => {
            observer.disconnect();
            resolve(); // Resolve anyway to avoid hanging
          }, 10000);
        });
      });
      // Double-check it’s there
      const modalExists = await page.$('auth-flow-manager') !== null;
      if (!modalExists) throw new Error('Modal failed to appear after click');
    }
  }, config);

  const accountData = await checkModalMode(page, config, browser);
  await log(`Main page handled successfully for ${isMobile ? 'mobile' : 'desktop'}`);
  return accountData; // Return accountData
}

async function checkUsernameAvailability(page, config, username) {
  await page.waitForSelector(config.manualSelectors.username, { visible: true, timeout: 15000 });

  // Clear the field
  await page.click(config.manualSelectors.username, { clickCount: 3 }); // Triple-click to select all
  await page.keyboard.press('Backspace');

  // Type username
  await page.type(config.manualSelectors.username, username, { delay: config.randomDelays ? Math.random() * 100 + 50 : 50 });

  // Lose focus by clicking modal background
  await clickElementWithNaturalMovement(page, 'auth-flow-modal[pagename="register_username_and_password"]', config);

  // Wait briefly for Reddit to update helper text
  await new Promise(r => setTimeout(r, 1000));

  const helperText = await page.evaluateHandle(() => {
    const usernameInput = document.querySelector('#register-username');
    if (!usernameInput || !usernameInput.shadowRoot) return null;
    const formHelper = usernameInput.shadowRoot.querySelector('faceplate-form-helper-text');
    if (!formHelper || !formHelper.shadowRoot) return null;
    return formHelper.shadowRoot.querySelector('#helper-text');
  });

  if (!helperText) throw new Error('Could not find username helper text');

  const text = await page.evaluate(el => el.innerText.trim().toLowerCase(), helperText);
  await log(`Username check: "${text}"`);
  return text.includes('available');
}

async function getUniqueUsername(page, config) {
  let username;
  let isAvailable = false;
  let attempts = 0;
  const maxAttempts = 5;

  while (!isAvailable && attempts < maxAttempts) {
    username = await generateUniqueUsername(config);
    isAvailable = await checkUsernameAvailability(page, config, username);
    if (!isAvailable) {
      await log(`Username ${username} taken, retrying...`);
      attempts++;
    }
  }

  if (!isAvailable) throw new Error('Could not find an available username after max attempts');
  return username;
}

async function checkModalMode(page, config, browser) {
  const isMobile = await isMobileViewport(page);
  const selectors = isMobile ? SELECTORS.mobile : SELECTORS.desktop;

  // Check if the modal is in signup mode
  const isSignupMode = await page.evaluate(() => {
    const modal = document.querySelector('auth-flow-manager');
    return modal && modal.getAttribute('step-name') === 'register';
  });

  if (!isSignupMode) {
    await log('Modal in login mode, toggling to signup');
    await clickElementWithNaturalMovement(page, selectors.signUpButton, config);

    // Wait for the email field using MutationObserver
    await page.evaluate(() => {
      return new Promise((resolve) => {
        const observer = new MutationObserver((mutations, obs) => {
          const emailField = document.querySelector('#register-email');
          if (emailField) {
            obs.disconnect();
            resolve();
          }
        });
        observer.observe(document.body, { childList: true, subtree: true });
        setTimeout(() => {
          observer.disconnect();
          resolve(); // Fallback after 10s
        }, 10000);
      });
    });

    const signUpModalExists = await page.$(selectors.modalsignUpButton) !== null;
    if (!signUpModalExists) throw new Error('Signup button not found in modal');

    // Click the "Sign Up" link again
    await clickElementWithNaturalMovement(page, selectors.modalsignUpButton, config);
    await log('Clicked Sign Up button link again while in signup modal');

    // Wait for signup mode to fully activate (password field gone)
    await log('Waiting for signup mode to stabilize...');
    // await log('Pausing execution indefinitely...');
    // await new Promise(() => { }); // Infinite wait
    await page.waitForFunction(() => {
      let elements = document.querySelectorAll('auth-flow-link[step]');
      for (const element of elements) {
        const text = element.textContent.trim().toLowerCase();
        if (text.includes('log in')) {
          const rect = element.getBoundingClientRect();
          return rect.height > 0 && rect.width > 0 && (rect.top !== 0 || rect.left !== 0); // Visible, not all zeros
        }
      }
      return false;
    }, { timeout: 15000 }); // 15s max wait
    await log('Signup mode confirmed via button state');

    // Confirm email field is present
    const emailExists = await page.$('faceplate-text-input#register-email') !== null;
    if (!emailExists) throw new Error('Email field not found after toggling to signup');

    // Proceed with email entry (from your earlier flow)
    await log('Clicking email field to focus');
    await clickElementWithNaturalMovement(page, selectors.emailField, config);
    const { email, mailjs_password, mailjs } = await generateTempEmail(config);
    await log(`Typing email: ${email}`);
    await page.type(selectors.emailField, email, { delay: config.randomDelays ? Math.random() * 100 + 50 : 50 });
    await clickContinueButton(page, config);
    // Generate realistic username and password
    // Wait for and input verification codeawait log('Waiting for verification code...');
    await waitForVerificationCode(page, config, mailjs);

    // Wait 5 seconds after code input
    await new Promise(r => setTimeout(r, 5000));
    await clickContinueButton(page, config);
    await log('Clicked Continue after verification code');

    // Wait forever here
    // await log('Pausing execution indefinitely...');
    // await new Promise(() => { }); // Infinite wait
    // Username
    await log('Waiting for username field...');
    await page.waitForSelector(config.manualSelectors.username, { visible: true, timeout: 15000 });
    await log('Clicking username field');
    await clickElementWithNaturalMovement(page, config.manualSelectors.username, config);
    const username = await getUniqueUsername(page, config);

    // Password
    await log('Clicking password field');
    const password = faker.internet.password({ length: 16, memorable: true, pattern: /[A-Za-z0-9!@#$%^&*]/ });
    const finalPassword = password.length >= 8 ? password : password.padEnd(8, 'x') + faker.string.alphanumeric(8);
    await clickElementWithNaturalMovement(page, config.manualSelectors.password, config);
    await page.type(config.manualSelectors.password, finalPassword, { delay: config.randomDelays ? Math.random() * 100 + 50 : 50 });
    await log(`Generated credentials - Username: ${username}, Password: ${finalPassword}`);

    // Wait 5s, click Continue
    // After username/password submission
    await new Promise(r => setTimeout(r, 5000));
    await clickContinueButton(page, config);
    await log('Submitted signup form');

    // Gender Selection
    await log('Waiting for gender selection...');
    const slotterSelector = 'body > shreddit-app > auth-flow-manager > span[slot="onboarding"] > faceplate-partial > onboarding-flow > shreddit-slotter';
    await page.waitForFunction(selector => {
      const slotter = document.querySelector(selector);
      return slotter && slotter.shadowRoot && slotter.shadowRoot.querySelector('ob-gender-selection');
    }, { timeout: 15000 }, slotterSelector);

    const genderButtons = await page.evaluate(() => {
      const slotter = document.querySelector('body > shreddit-app > auth-flow-manager > span[slot="onboarding"] > faceplate-partial > onboarding-flow > shreddit-slotter');
      const buttons = slotter.shadowRoot.querySelectorAll('ob-gender-selection > auth-flow-modal > div > div > button:not([disabled])');
      return Array.from(buttons).map(btn => ({
        idx: Array.from(buttons).indexOf(btn) + 1, // 1-based for nth-child
        text: btn.textContent.trim().toLowerCase() // For logging only
      }));
    });

    const numGenderButtons = genderButtons.length; // Total number of gender options
    const genderChoice = Number.isInteger(config.genderChoice) && config.genderChoice >= 0
      ? config.genderChoice % numGenderButtons // Modular arithmetic for overflow
      : Math.floor(Math.random() * numGenderButtons); // Fallback to random if invalid
    const selectedGender = genderButtons[genderChoice];
    const genderSelector = `ob-gender-selection > auth-flow-modal > div > div > button:nth-child(${selectedGender.idx})`;
    await log(`Selecting gender option: ${selectedGender.text} (index ${genderChoice})`);
    await clickElementWithNaturalMovement(page, genderSelector, config, { isShadow: true });
    await new Promise(r => setTimeout(r, 1000)); // 1s delay

    if (config.validateClicks) {
      await page.waitForFunction(sel => {
        const btn = document.querySelector('body > shreddit-app > auth-flow-manager > span[slot="onboarding"] > faceplate-partial > onboarding-flow > shreddit-slotter')
          .shadowRoot.querySelector(sel);
        return btn && btn.getAttribute('aria-checked') === 'true';
      }, { timeout: 5000 }, genderSelector);
    }

    await log('Done with gender selection...');
    // Save session data to GoLogin
    await log('Saving session to GoLogin...');
    const cookies = await page.cookies();
    if (browser.glInstance) {
      try {
        await browser.glInstance.update({
          id: browser.glInstance.profile_id,
          cookies: cookies
        });
        await log(`Session saved for profile ${config.goLoginProfileId}`);
      } catch (e) {
        await log(`Failed to save session: ${e.message}`);
      }
    } else {
      await log('No GoLogin instance found, skipping session save');
    }

    // Finalization
    const accountData = {
      username,
      password: finalPassword,
      email,
      proxy: config.useProxy ? config.proxy : null,
      profileId: config.goLoginProfileId || (browser.glInstance ? browser.glInstance.profile_id : null),
      mailjs
    };
    await fs.appendFile('accounts.txt', `${username}:${finalPassword}:${email}\n`);
    await log(`Saved credentials to accounts.txt: ${username}:${finalPassword}:${email}`);

    // const genderContinueSelector = `ob-gender-selection > auth-flow-modal > div > div > button:contains('Continue')`;
    // await page.waitForFunction(selector => {
    //   const slotter = document.querySelector(selector);
    //   return slotter && slotter.shadowRoot && slotter.shadowRoot.querySelector("ob-gender-selection > auth-flow-modal > div > div > button:contains('Continue')");
    // }, { timeout: 15000 }, slotterSelector);
    // await clickElementWithNaturalMovement(page, genderContinueSelector, config, { isShadow: true });
    await new Promise(r => setTimeout(r, 500)); // 0.5s delay
    // await log('Pausing execution indefinitely...');
    // await new Promise(() => { }); // Infinite wait
    // Topics Selection
    const SLOTTER_SELECTOR = 'body > shreddit-app > auth-flow-manager > span[slot="onboarding"] > faceplate-partial > onboarding-flow > shreddit-slotter';

    await log('Waiting for onboarding topics...');
    await page.waitForFunction(sel => {
      const slotter = document.querySelector(sel);
      return slotter && slotter.shadowRoot && slotter.shadowRoot.querySelector('#topics');
    }, { timeout: 15000 }, SLOTTER_SELECTOR);
    
    await log('Fetching topic categories and positions...');
    const topicData = await page.evaluate((base) => {
      const slotter = document.querySelector(base);
      if (!slotter || !slotter.shadowRoot) return [];
      const fieldsets = slotter.shadowRoot.querySelectorAll('#topics fieldset');
      const categories = [];
      fieldsets.forEach((fieldset, index) => {
        const containers = fieldset.querySelectorAll('div.topic-container');
        const categoryTopics = Array.from(containers).map(container => {
          const btn = container.querySelector('button[role="checkbox"]');
          const rect = btn.getBoundingClientRect();
          return {
            id: btn.id,
            text: btn.querySelector('span.select-none').textContent.trim(),
            position: { x: rect.x, y: rect.y, width: rect.width, height: rect.height }
          };
        });
        if (categoryTopics.length > 0) categories.push(categoryTopics);
      });
      return categories;
    }, SLOTTER_SELECTOR);
    
    const numCategories = topicData.length;
    const topicCategory = Number.isInteger(config.topicCategory) && config.topicCategory >= 0
      ? config.topicCategory % numCategories
      : Math.floor(Math.random() * numCategories);
    const allTopicsInCategory = topicData[topicCategory];
    
    const clickableTopics = allTopicsInCategory.filter(topic => {
      const { x, y, width, height } = topic.position;
      const isVisible = width > 0 && height > 0 && y >= 0 && x >= 0;
      if (!isVisible) log(`Topic ${topic.text} (id: ${topic.id}) not clickable: x=${x}, y=${y}, w=${width}, h=${height}`);
      return isVisible;
    });
    const numTopicsInCategory = clickableTopics.length;
    
    await log(`Selected category index ${topicCategory} with ${allTopicsInCategory.length} total topics, ${numTopicsInCategory} clickable`);
    if (numTopicsInCategory === 0) {
      await page.screenshot({ path: `logs/error-${new Date().toISOString()}.png` });
      throw new Error(`No clickable topics found in category ${topicCategory}`);
    }
    
    const numTopicsToSelect = Number.isInteger(config.numTopics) && config.numTopics > 0
      ? Math.min(config.numTopics, numTopicsInCategory)
      : 1;
    const topicIndices = Array.isArray(config.topicIndices) && config.topicIndices.every(i => Number.isInteger(i) && i >= 0)
      ? config.topicIndices.slice(0, numTopicsToSelect).map(i => i % numTopicsInCategory)
      : Array.from({ length: numTopicsToSelect }, () => Math.floor(Math.random() * numTopicsInCategory));
    
    const selectedTopics = topicIndices.map(index => clickableTopics[index]);
    for (const topic of selectedTopics) {
      await log(`Selecting topic: ${topic.text} (id: ${topic.id}, position: x=${topic.position.x}, y=${topic.position.y})`);
      const selector = `#${topic.id}`;
      
      let clicked = false;
      for (const topic of selectedTopics) {
        await log(`Selecting topic: ${topic.text} (id: ${topic.id}, position: x=${topic.position.x}, y=${topic.position.y})`);
        
        // Use topic index (1-based) and category index (1-based)
        const topicIndex = topicIndices[selectedTopics.indexOf(topic)] + 1; // Convert 0-based to 1-based
        const categoryIndex = topicCategory + 1; // 0-based to 1-based
        const selector = `#topics > fieldset:nth-child(${categoryIndex}) > div > div.topic-container:nth-child(${topicIndex})`;
        
        let clicked = false;
        for (let attempt = 1; attempt <= 3; attempt++) {
          try {
            const element = await page.evaluateHandle((sel, base) => {
              const slotter = document.querySelector(base);
              return slotter && slotter.shadowRoot ? slotter.shadowRoot.querySelector(sel) : null;
            }, selector, SLOTTER_SELECTOR);
            if (!element.asElement()) throw new Error(`Topic element ${selector} not found`);
      
            await element.scrollIntoViewIfNeeded();
            await new Promise(r => setTimeout(r, 1000));
      
            await clickElementWithNaturalMovement(page, selector, config, { isShadow: true, baseSelector: SLOTTER_SELECTOR });
            await new Promise(r => setTimeout(r, Math.random() * 500 + 500)); // 0.5-1s delay
            clicked = true;
            break;
          } catch (e) {
            await log(`Attempt ${attempt} failed for ${selector}: ${e.message}`);
            if (attempt === 3) {
              await page.screenshot({ path: `logs/error-${new Date().toISOString()}.png` });
              throw new Error(`Failed to click topic ${selector} after 3 attempts`);
            }
            await new Promise(r => setTimeout(r, 2000));
          }
        }
      
        if (config.validateClicks && clicked) {
          await page.waitForFunction((sel, base) => {
            const slotter = document.querySelector(base);
            const btn = slotter.shadowRoot.querySelector(sel);
            return btn && btn.getAttribute('aria-checked') === 'true';
          }, { timeout: 5000 }, selector, SLOTTER_SELECTOR);
        }
      }
    }
    
    await log('Done with topics selection...');
    await log('Verifying account creation...');
    await page.waitForSelector('shreddit-post', { timeout: 15000 });
    await log('Account creation complete and verified on feed page!');
    
    try {
      if (browser.glInstance) {
        await browser.glInstance.stop();
        await log('GoLogin stopped successfully');
      }
    } catch (e) {
      await log(`GoLogin stop failed: ${e.message}`);
    }
    
    return accountData;
  }
  await log('Confirmed signup mode');
  return null;
}

async function generateTempEmail(config) {
  const mailjs = new Mailjs();

  try {
    const accountResponse = await mailjs.createOneAccount();
    if (!accountResponse.status) throw new Error(`Mailjs account creation failed: ${accountResponse.message}`);
    const { username: email, password } = accountResponse.data;
    await log(`Generated email with Mailjs: ${email}`);

    return { email, password, mailjs }; // Return mailjs instance for later use
  } catch (error) {
    await log(`Mailjs email generation failed: ${error.message}`);
    throw error;
  }
}

// old one with logic to check position, works everywhere except in the verification code
// async function clickContinueButton(page, config) {
//   await log('Looking for visible Continue button...');
//   const buttonHandle = await page.evaluateHandle(() => {
//     function getVisiblePrimaryButtons() {
//       let elements = document.querySelectorAll('[slot="primaryButton"]');
//       let visibleElements = [];
//       elements.forEach(element => {
//         const rect = element.getBoundingClientRect();
//         if ((rect.height > 0 || rect.width > 0) && (rect.top !== 0 || rect.bottom !== 0)) {
//           visibleElements.push(element);
//         }
//       });
//       return visibleElements;
//     }
//     const visibleButtons = getVisiblePrimaryButtons();
//     return visibleButtons.length > 0 ? visibleButtons[0] : null; // Take the first visible button
//   });

//   if (!buttonHandle) throw new Error('No visible Continue button found');

//   const buttonText = await page.evaluate(el => el.textContent.trim(), buttonHandle);
//   await log(`Found button with text: "${buttonText}" at ${JSON.stringify(await buttonHandle.boundingBox())}`);

//   // Scroll into view if needed (unlikely at y: 621 in 726 height, but safe)
//   await buttonHandle.scrollIntoViewIfNeeded();
//   await clickElementWithNaturalMovement(page, buttonHandle, config);
//   await log('Clicked Continue button');
// }

//second one works up until verification code continue section
// async function clickContinueButton(page, config) {
//   await log('Looking for visible Continue button...');
//   // Use $$ to get all primary buttons and filter for the right one
//   const buttons = await page.$$('[slot="primaryButton"]');
//   let targetButton = null;

//   for (const button of buttons) {
//       const text = await page.evaluate(el => el.textContent.trim(), button);
//       if (text === 'Continue' && !text.includes('Google')) {
//           targetButton = button; // This is an ElementHandle
//           break;
//       }
//   }

//   if (!targetButton) throw new Error('No valid Continue button found');

//   const buttonText = await page.evaluate(el => el.textContent.trim(), targetButton);
//   await log(`Found button with text: "${buttonText}" at ${JSON.stringify(await targetButton.boundingBox())}`);

//   // Pass the ElementHandle directly to clickElementWithNaturalMovement
//   await clickElementWithNaturalMovement(page, targetButton, config);
//   await log('Clicked Continue button');
// }
//merged functionality, third
// async function clickContinueButton(page, config) {
//   await log('Looking for visible Continue button...');
//   const buttons = await page.$$('[slot="primaryButton"]');
//   let targetButton = null;

//   for (const button of buttons) {
//       const text = await page.evaluate(el => el.textContent.trim(), button);
//       const rect = await button.boundingBox();
//       if (text.toLowerCase() === 'continue' && !text.includes('Google') && rect && (rect.height > 0 && rect.width > 0 && (rect.top !== 0 || rect.bottom !== 0))) {
//           targetButton = button;
//           break;
//       }
//   }

//   if (!targetButton) throw new Error('No visible Continue button found');

//   const buttonText = await page.evaluate(el => el.textContent.trim(), targetButton);
//   await log(`Found button with text: "${buttonText}" at ${JSON.stringify(await targetButton.boundingBox())}`);
//   await clickElementWithNaturalMovement(page, targetButton, config);
//   await log('Clicked Continue button');
// }
//clone of the first one but checks for nested buttons in the div and checks the text there
async function clickContinueButton(page, config) {
  await log('Looking for visible Continue button...');
  const candidates = await page.$$('[slot="primaryButton"]');
  if (!candidates.length) throw new Error('No visible Continue button found');

  let targetDiv = null;

  // Find the first visible div with "continue" in its text
  for (const candidate of candidates) {
    const rect = await candidate.boundingBox();
    if (!rect || rect.height <= 0 || rect.width <= 0 || (rect.top === 0 && rect.bottom === 0)) continue;

    const text = await page.evaluate(el => el.textContent.trim().toLowerCase(), candidate);
    if (text.includes('continue') && !text.includes('google')) {
      targetDiv = candidate;
      break;
    }
  }

  if (!targetDiv) throw new Error('No visible Continue button found');

  // Find nested element with "continue"
  const nestedElements = await targetDiv.$$('*'); // All descendants
  let targetElement = null;
  for (const element of nestedElements) {
    const text = await page.evaluate(el => el.textContent.trim().toLowerCase(), element);
    if (text === 'continue') { // Exact match for precision
      targetElement = element;
      break;
    }
  }

  // Fallback to the div if no nested "continue" found
  if (!targetElement) targetElement = targetDiv;

  const elementText = await page.evaluate(el => el.textContent.trim(), targetElement);
  await log(`Found element with text: "${elementText}" at ${JSON.stringify(await targetElement.boundingBox())}`);
  await targetElement.scrollIntoViewIfNeeded();
  await clickElementWithNaturalMovement(page, targetElement, config);
  await log('Clicked Continue button');
}

async function waitForVerificationCode(page, config, mailjs) {
  return new Promise((resolve, reject) => {
    mailjs.on('arrive', async (msg) => {
      if (msg.from.address.includes('reddit') || msg.subject.includes('Reddit')) {
        await log(`Email subject: ${msg.subject}`);

        // Try subject first
        const codeFromSubject = msg.subject.match(/\d{6}/)?.[0];
        if (codeFromSubject) {
          await log(`Received verification code from subject: ${codeFromSubject}`);
          await page.waitForSelector(config.manualSelectors.verification_code, { visible: true, timeout: 15000 });
          await performAction(page, config, 'verification_code', codeFromSubject);
          mailjs.off();
          resolve(codeFromSubject);
          return;
        }

        // Fallback to body
        const messageDetails = await mailjs.getMessage(msg.id);
        if (!messageDetails.status) {
          reject(new Error(`Mailjs getMessage failed: ${messageDetails.message}`));
          return;
        }
        const messageText = messageDetails.data.text || messageDetails.data.html.join('');
        const codeFromBody = messageText.match(/\d{6}/)?.[0];
        if (codeFromBody) {
          await log(`Received verification code from body: ${codeFromBody}`);
          await page.waitForSelector(config.manualSelectors.verification_code, { visible: true, timeout: 15000 });
          await performAction(page, config, 'verification_code', codeFromBody);
          mailjs.off();
          resolve(codeFromBody);
        } else {
          reject(new Error('No 6-digit code found in subject or body'));
        }
      }
    });

    mailjs.on('error', (err) => reject(new Error(`Mailjs error: ${err}`)));

    setTimeout(() => {
      mailjs.off();
      reject(new Error('Verification code timeout (1 min)'));
    }, 60000 * 10);
  });
}

async function warmUpAccount(page, config) {
  if (!config.warmUpEnabled) return;
  await log('Warming up...');
  await navigateTo(page, 'https://www.reddit.com/r/all', config);
  await page.evaluate(() => window.scrollBy(0, 500));
  await new Promise(r => setTimeout(r, config.warmUpDuration));
}

async function registerRedditAccount(config) {
  const proxyManager = config.useProxy ? new ProxyManager(config.proxyList) : null;
  const rateLimiter = config.rateLimitEnabled ? new RateLimiter(config.rateLimitPerIP, config.rateLimitWindow) : null;
  let browser, page, glInstance, cookieChecker;
  let attempt = 0;

  const db = await initDatabase();
  story = [{ step: 'start', action: 'Loaded main page', result: 'Goal is to register' }];

  if (!process.env.GEMINI_API_KEY && config.useContentApi) {
    throw new Error('GEMINI_API_KEY is required when useContentApi is true');
  }

  while (config.retriesEnabled ? attempt < config.maxRetries : attempt < 1) {
    try {
      const proxy = config.useProxy ? proxyManager.getNext() : null;
      if (config.rateLimitEnabled && !rateLimiter.check(proxy || 'natural')) throw new Error('Rate limit exceeded');

      const { browser: b, glInstance: g } = await launchBrowser(config, proxy);
      browser = b;
      glInstance = g;

      page = await browser.newPage();
      await page.setViewport({ width: 800, height: 600 });
      if (!config.useGoLogin && config.rotateUserAgent) await page.setUserAgent(faker.internet.userAgent());

      // Start the cookie checker
      if (config.rejectCookies) {
        cookieChecker = await rejectNonEssentialCookies(page, config);
        await log('Started periodic cookie rejection checker');
      }

      await navigateTo(page, 'https://www.reddit.com/', config);
      const accountData = await handleMainPage(page, config, browser);

      if (!accountData) throw new Error('Failed to retrieve account data from handleMainPage');
     
      await warmUpAccount(page, config);
      await saveAccountToDatabase(db, accountData);
      await log(`✅ Registered: ${accountData.username}:${accountData.password}:${accountData.email}`);
      break;
      
    } catch (error) {
      attempt++;
      await log(`Attempt ${attempt} failed: ${error.message}`);
      if (config.useSentry) Sentry.captureException(error);
      await takeScreenshot(page, 'error', config);
      if (config.retriesEnabled && attempt < config.maxRetries && config.switchProxyOnFail && config.useProxy) {
        proxyManager.getNext();
      }
      if (config.useExponentialBackoff) await new Promise(r => setTimeout(r, 2 ** attempt * 1000));
    } finally {
      if (cookieChecker) clearInterval(cookieChecker); // Stop the checker
      if (browser) await browser.close().catch(() => log('Browser close failed'));
      if (glInstance) await glInstance.stopLocal({ posting: true }).catch(() => log('GoLogin stop failed'));
      if (attempt >= config.maxRetries || !config.retriesEnabled) await db.close();
    }
  }
}

function startWebServer() {
  const app = express();
  app.use(express.json());
  app.use(express.static('public'));

  app.post('/start', async (req, res) => {
    const config = { ...defaultConfig, ...req.body };
    config.proxyList = config.useProxy && req.body.proxyList ? req.body.proxyList.split('\n').filter(Boolean) : [];
    await fs.writeFile('config.json', JSON.stringify(config, null, 2));
    registerRedditAccount(config);
    res.send('Registration started!');
  });

  app.get('/page-content', (req, res) => {
    if (!defaultConfig.useContentApi || !pageContent.html) {
      return res.status(404).json({ error: 'No content available. Enable useContentApi and run registration.' });
    }
    res.json({ ...pageContent, story });
  });

  app.listen(PORT, () => console.log(`Server running on http://localhost:${PORT}`));
}

(async () => {
  try {
    if (process.argv.includes('--web')) {
      if (defaultConfig.useSentry) Sentry.init({ dsn: process.env.SENTRY_KEY });
      startWebServer();
    } else {
      const config = await fs.readFile('./config.json', 'utf8').then(JSON.parse).catch(() => defaultConfig);
      await registerRedditAccount(config);
    }
  } catch (error) {
    console.log(error);
  }
})();