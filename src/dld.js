import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';

const DLD_URL = 'https://dubailand.gov.ae/en/MyDLD/#/login/sso';
const SESSION_PATH = process.env.DLD_SESSION_PATH || '/data/dld-storage.json';
let browser;
let context;
let page;

async function firstVisible(pageObj, selectors) {
  for (const selector of selectors) {
    const locator = pageObj.locator(selector).first();
    try { if (await locator.isVisible({ timeout: 1200 })) return locator; } catch {}
  }
  return null;
}

function browserUrl() {
  const explicit = process.env.BROWSER_PUBLIC_URL;
  if (explicit) return explicit.replace(/\/$/, '') + '/vnc.html?autoconnect=true&resize=scale';
  const railwayDomain = process.env.RAILWAY_PUBLIC_DOMAIN;
  if (railwayDomain) return `https://${railwayDomain}/vnc.html?autoconnect=true&resize=scale`;
  return null;
}

async function saveSession() {
  try {
    fs.mkdirSync(path.dirname(SESSION_PATH), { recursive: true });
    await context.storageState({ path: SESSION_PATH });
    console.log(`DLD session saved to ${SESSION_PATH}`);
  } catch (error) {
    console.error('Could not save DLD session:', error.message);
  }
}

async function ensureSession() {
  if (browser && context && page && !page.isClosed()) return;

  browser = await chromium.launch({
    headless: false,
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--window-size=1440,900']
  });

  const contextOptions = { viewport: { width: 1365, height: 768 } };
  if (fs.existsSync(SESSION_PATH)) {
    contextOptions.storageState = SESSION_PATH;
    console.log(`Loading saved DLD session from ${SESSION_PATH}`);
  }

  context = await browser.newContext(contextOptions);
  page = await context.newPage();
  page.setDefaultTimeout(15000);
}

function extractUaePassChallenge(text) {
  const patterns = [
    /(?:number|code|match|matching|shown|displayed)[^0-9]{0,40}([0-9]{2,3})/i,
    /([0-9]{2,3})[^0-9]{0,40}(?:number|code|match|matching)/i
  ];
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match) return match[1];
  }
  return null;
}

async function isAuthenticatedPage() {
  const body = (await page.locator('body').innerText().catch(() => '')).toLowerCase();
  return body.includes('dld application dashboard') || body.includes('trakheesi') || body.includes('real estate office admin');
}

async function selectRealEstateAdminProfile() {
  const bodyRaw = await page.locator('body').innerText().catch(() => '');
  if (!/multiple profiles found/i.test(bodyRaw)) return null;

  const adminType = page.getByText(/REAL ESTATE OFFICE ADMIN/i).first();
  if (!(await adminType.isVisible().catch(() => false))) {
    return { status: 'real_estate_admin_profile_not_found', url: page.url(), browserUrl: browserUrl() };
  }

  const profileCard = adminType.locator('xpath=ancestor::*[.//input[@type="radio"]][1]');
  let radio = profileCard.locator('input[type="radio"]').first();
  if (!(await radio.count())) radio = adminType.locator('xpath=following::input[@type="radio"][1]');
  if (!(await radio.count())) return { status: 'admin_profile_radio_not_found', url: page.url(), browserUrl: browserUrl() };

  await radio.check({ force: true });
  await page.waitForTimeout(800);

  const proceed = await firstVisible(page, [
    'button:has-text("Proceed")', 'button:has-text("Continue")', 'button:has-text("Submit")',
    'button:has-text("Next")', 'button[type="submit"]'
  ]);
  if (proceed) {
    await proceed.click();
    await page.waitForTimeout(5000);
  }

  await saveSession();
  return { status: 'real_estate_admin_profile_selected', url: page.url() };
}

async function detectState() {
  const url = page.url();
  const bodyRaw = await page.locator('body').innerText().catch(() => '');
  const bodyText = bodyRaw.toLowerCase();

  if (/multiple profiles found/i.test(bodyRaw)) {
    return selectRealEstateAdminProfile();
  }

  if (await isAuthenticatedPage()) {
    await saveSession();
    return { status: 'session_active', url };
  }

  const captcha = bodyText.includes("i'm not a robot") || bodyText.includes('recaptcha') ||
    (await page.locator('iframe[src*="recaptcha"], iframe[title*="recaptcha" i]').count().catch(() => 0)) > 0;
  const challenge = extractUaePassChallenge(bodyRaw);
  if (challenge) return { status: 'uae_pass_approval_required', challenge, url, browserUrl: browserUrl() };
  if (bodyText.includes('authentication code')) return { status: 'authentication_code', url };
  if (bodyText.includes('uae pass') || bodyText.includes('uaepass')) return { status: 'uae_pass', url, browserUrl: browserUrl() };
  if (captcha) return { status: 'captcha_required', url, browserUrl: browserUrl() };

  const passField = await firstVisible(page, ['input[type="password"]']);
  if (passField) return { status: 'login_form', url };
  return { status: 'post_login_unknown', url, title: await page.title().catch(() => '') };
}

async function submitUaePassId() {
  const emiratesId = process.env.UAE_PASS_EMIRATES_ID;
  if (!emiratesId) return { status: 'uae_pass_id_required', url: page.url(), browserUrl: browserUrl() };

  const idInput = await firstVisible(page, [
    'input[placeholder*="Emirates ID" i]', 'input[aria-label*="Emirates ID" i]',
    'input[name*="emirates" i]', 'input[id*="emirates" i]', 'input[placeholder*="ID" i]',
    'input[type="text"]', 'input[type="tel"]'
  ]);
  if (!idInput) return { status: 'uae_pass_id_field_not_found', url: page.url(), browserUrl: browserUrl() };

  await idInput.fill(emiratesId);
  const loginButton = await firstVisible(page, [
    'button:has-text("Login")', 'button:has-text("Sign in")', 'button[type="submit"]', 'input[type="submit"]'
  ]);
  if (!loginButton) return { status: 'uae_pass_login_button_not_found', url: page.url(), browserUrl: browserUrl() };

  await loginButton.click();
  await page.waitForTimeout(5000);
  return detectState();
}

async function clickTrakheesiUaePass() {
  const trakheesiText = page.getByText('Trakheesi', { exact: true }).first();
  try {
    if (!(await trakheesiText.isVisible({ timeout: 8000 }))) return { status: 'trakheesi_not_found', url: page.url() };
  } catch {
    return { status: 'trakheesi_not_found', url: page.url() };
  }

  const card = trakheesiText.locator('xpath=ancestor::*[.//button or .//a][1]');
  let loginButton = card.getByRole('button', { name: /login with uae pass/i }).first();
  if (!(await loginButton.isVisible().catch(() => false))) loginButton = card.getByRole('link', { name: /login with uae pass/i }).first();
  if (!(await loginButton.isVisible().catch(() => false))) loginButton = card.getByText('Login with UAE Pass', { exact: true }).first();
  if (!(await loginButton.isVisible().catch(() => false))) return { status: 'trakheesi_uae_pass_button_not_found', url: page.url() };

  await loginButton.click();
  await page.waitForTimeout(1500);

  const continueButton = await firstVisible(page, [
    'button:has-text("Continue with UAE PASS")', 'text="Continue with UAE PASS"'
  ]);
  if (continueButton) {
    await continueButton.click();
    await page.waitForTimeout(5000);
  }

  return submitUaePassId();
}

export async function startInteractiveDldLogin() {
  const username = process.env.DLD_USERNAME;
  const password = process.env.DLD_PASSWORD;
  if (!username || !password) return { status: 'missing_credentials' };
  if (!process.env.VNC_PASSWORD) return { status: 'missing_vnc_password' };

  await ensureSession();

  // Reuse the current live browser session whenever DLD still accepts it.
  if (page.url() !== 'about:blank') {
    const current = await detectState();
    if (current.status === 'session_active' || current.status === 'real_estate_admin_profile_selected') return current;
  }

  await page.goto(DLD_URL, { waitUntil: 'domcontentloaded', timeout: 45000 });
  await page.waitForTimeout(4000);

  // A saved Railway session may already authenticate this new browser context.
  if (await isAuthenticatedPage()) {
    await saveSession();
    return { status: 'session_active', url: page.url() };
  }

  const userInput = await firstVisible(page, [
    'input[name="username"]:not([type="radio"]):not([type="checkbox"])',
    'input[name="Username"]:not([type="radio"]):not([type="checkbox"])',
    'input[type="text"][id*="user" i]', 'input[type="text"][placeholder*="user" i]',
    'input[type="email"]', 'input[type="text"]'
  ]);
  const passInput = await firstVisible(page, [
    'input[type="password"][name="password"]', 'input[type="password"][name="Password"]',
    'input[type="password"][id*="pass" i]', 'input[type="password"][placeholder*="pass" i]',
    'input[type="password"]'
  ]);

  if (!userInput || !passInput) return { status: 'login_form_not_found', url: page.url(), title: await page.title() };
  await userInput.fill(username);
  await passInput.fill(password);
  return detectState();
}

export async function continueAfterCaptcha() {
  if (!page || page.isClosed()) return { status: 'no_active_session' };
  const signIn = await firstVisible(page, [
    'button:has-text("Sign In")', 'button:has-text("Login")', 'input[type="submit"]', 'button[type="submit"]'
  ]);
  if (!signIn) return { status: 'signin_button_not_found', url: page.url() };
  await signIn.click();
  await page.waitForTimeout(6000);
  const bodyText = (await page.locator('body').innerText().catch(() => '')).toLowerCase();
  if (bodyText.includes('trakheesi') && bodyText.includes('login with uae pass')) return clickTrakheesiUaePass();
  return detectState();
}

export async function clickTrakheesiLogin() {
  if (!page || page.isClosed()) return { status: 'no_active_session' };
  return clickTrakheesiUaePass();
}

export async function continueUaePassLogin() {
  if (!page || page.isClosed()) return { status: 'no_active_session' };
  return submitUaePassId();
}

export async function checkUaePassStatus() {
  if (!page || page.isClosed()) return { status: 'no_active_session' };
  await page.waitForTimeout(1500);
  const state = await detectState();
  if (state.status === 'session_active' || state.status === 'real_estate_admin_profile_selected') await saveSession();
  return state;
}

export async function testDldLogin() {
  try { return await startInteractiveDldLogin(); }
  catch (error) { return { status: 'error', message: error.message }; }
}
