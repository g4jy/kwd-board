// Test-only preload: Playwright helper scripts launch Chromium without a channel; on this PC only installed Chrome exists.
import { chromium } from 'playwright';
const launch = chromium.launch.bind(chromium);
chromium.launch = (o = {}) => launch({ channel: 'chrome', ...o });
