import { chromium } from 'playwright';

const DLD_URL = 'https://dubailand.gov.ae/en/MyDLD/#/login/sso';

async function firstVisible(page, selectors) {
  for (const selector of selectors) {
    const locator = page.locator(selector).first();
    try {
      if (await locator.isVisible({ timeout: 1500 })) return locator;
    } catch {}
  }
  return null;
}

export async function testDldLogin() {
  const username = process.env.DLD_USERNAME;
  const password = process.env.DLD_PASSWORD;
  if (!username || !password) return { status: 'missing_credentials' };

  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
  const context = await browser.newContext();
  const page = await context.newPage();
  page.setDefaultTimeout(15000);

  try {
    await page.goto(DLD_URL, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await page.waitForTimeout(4000);

    const userInput = await firstVisible(page, [
      'input[name="username"]:not([type="radio"]):not([type="checkbox"])',
      'input[name="Username"]:not([type="radio"]):not([type="checkbox"])',
      'input[type="text"][id*="user" i]',
      'input[type="text"][placeholder*="user" i]',
      'input[type="email"]',
      'input[type="text"]'
    ]);

    const passInput = await firstVisible(page, [
      'input[type="password"][name="password"]',
      'input[type="password"][name="Password"]',
      'input[type="password"][id*="pass" i]',
      'input[type="password"][placeholder*="pass" i]',
      'input[type="password"]'
    ]);

    if (!userInput || !passInput) {
      return { status: 'login_form_not_found', url: page.url(), title: await page.title() };
    }

    await userInput.fill(username);
    await passInput.fill(password);

    const bodyText = (await page.locator('body').innerText()).toLowerCase();
    const captcha = bodyText.includes("i'm not a robot") || bodyText.includes('recaptcha') ||
      (await page.locator('iframe[src*="recaptcha"], iframe[title*="recaptcha" i]').count()) > 0;

    if (captcha) {
      return {
        status: 'captcha_required',
        url: page.url(),
        message: 'DLD credentials were filled. CAPTCHA requires manual completion.'
      };
    }

    const signIn = await firstVisible(page, [
      'button:has-text("Sign In")',
      'button:has-text("Login")',
      'input[type="submit"]',
      'button[type="submit"]'
    ]);

    if (!signIn) return { status: 'signin_button_not_found', url: page.url() };

    await signIn.click();
    await page.waitForTimeout(5000);
    const afterText = (await page.locator('body').innerText()).toLowerCase();

    if (afterText.includes('authentication code')) return { status: 'authentication_code', url: page.url() };
    if (afterText.includes('uae pass') || afterText.includes('uaepass')) return { status: 'uae_pass', url: page.url() };
    if (afterText.includes("i'm not a robot") || afterText.includes('recaptcha')) return { status: 'captcha_required', url: page.url() };

    return { status: 'post_login_unknown', url: page.url(), title: await page.title() };
  } catch (error) {
    return { status: 'error', message: error.message };
  } finally {
    await context.close().catch(() => {});
    await browser.close().catch(() => {});
  }
}
