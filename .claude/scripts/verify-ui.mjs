// Browser-verify the web app: login + all three themes, with screenshots.
// No npm dependencies — drives real Chrome over CDP using Node's built-in WebSocket + fetch.
//
// Usage (PowerShell, with `pnpm dev` already running):
//
//   $shots = "$env:TEMP\studiocrm-shots"; mkdir -Force $shots | Out-Null
//   Start-Process "C:\Program Files\Google\Chrome\Application\chrome.exe" -WindowStyle Hidden `
//     -ArgumentList "--headless=new","--remote-debugging-port=9222",
//                   "--user-data-dir=$env:TEMP\studiocrm-chrome","--no-first-run",
//                   "--disable-gpu","--window-size=1440,900","about:blank"
//   node .claude/scripts/verify-ui.mjs $shots
//
// Afterwards kill the Chrome process started above. Requires Node 21+ for global WebSocket.
import fs from 'node:fs';
const SHOTS = process.argv[2];
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const list = await (await fetch('http://127.0.0.1:9222/json/list')).json();
const page = list.find(t => t.type === 'page');
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise(r => ws.addEventListener('open', r, { once: true }));

let id = 0; const pending = new Map();
ws.addEventListener('message', (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
});
const send = (method, params = {}) => new Promise(res => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });

const evaluate = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
  if (r.result?.exceptionDetails) throw new Error('JS: ' + JSON.stringify(r.result.exceptionDetails.exception?.description ?? r.result.exceptionDetails));
  return r.result?.result?.value;
};
const shot = async (name) => {
  const r = await send('Page.captureScreenshot', { format: 'png' });
  if (!r.result?.data) { console.log(`  !! screenshot ${name} failed`); return; }
  fs.writeFileSync(`${SHOTS}/${name}.png`, Buffer.from(r.result.data, 'base64'));
  console.log(`  saved shots/${name}.png`);
};

await send('Page.enable'); await send('Runtime.enable');
await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });

console.log('== navigate to http://localhost:5173 ==');
await send('Page.navigate', { url: 'http://localhost:5173' });
await sleep(4000);
console.log('url:', await evaluate('location.href'));
console.log('title:', await evaluate('document.title'));
console.log('login heading:', await evaluate(`document.querySelector('h2')?.textContent ?? '(none)'`));
console.log('console errors:', await evaluate(`(window.__errs||[]).join(' | ') || '(none)'`));
await shot('01-login');

console.log('\n== fill + submit login form ==');
await evaluate(`(() => {
  const set = (el, v) => {
    const d = Object.getOwnPropertyDescriptor(el.constructor.prototype, 'value');
    d.set.call(el, v);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  };
  const ins = document.querySelectorAll('form input');
  set(ins[0], 'admin@example.com');
  set(ins[1], 'Admin@1234');
  return true;
})()`);
await sleep(300);
await shot('02-login-filled');
await evaluate(`document.querySelector('form button[type=submit]').click()`);
await sleep(5000);
console.log('url after login:', await evaluate('location.href'));
console.log('logged-in user in store:', await evaluate(`(JSON.parse(localStorage.getItem('erp-auth')||'{}').state?.user?.email) ?? '(none)'`));
console.log('data-theme now:', await evaluate('document.documentElement.dataset.theme'));
await shot('03-after-login');

// --- theme switching via the top-bar theme button ---
const switchTheme = async (label, tag) => {
  console.log(`\n== switch theme -> ${label} ==`);
  const opened = await evaluate(`(() => {
    const b = document.querySelector('button[title="Theme"]');
    if (!b) return 'no theme button';
    b.click(); return 'clicked';
  })()`);
  console.log('  theme button:', opened);
  await sleep(700);
  if (tag === 'dark') await shot('04-theme-menu-open');
  const picked = await evaluate(`(() => {
    const want = ${JSON.stringify(label)};
    const els = [...document.querySelectorAll('button, [role=menuitem], li, a, div')];
    const hit = els.filter(e => e.textContent.trim() === want && e.offsetParent !== null).pop();
    if (!hit) return 'option not found';
    const clickable = hit.closest('button, [role=menuitem], li') || hit;
    clickable.click(); return 'clicked ' + clickable.tagName;
  })()`);
  console.log(`  ${label} option:`, picked);
  await sleep(1200);
  const st = await evaluate(`JSON.stringify({
    dataTheme: document.documentElement.dataset.theme,
    stored: JSON.parse(localStorage.getItem('erp-ui')||'{}').state?.theme,
    bodyBg: getComputedStyle(document.body).backgroundColor,
    primary: getComputedStyle(document.documentElement).getPropertyValue('--c-primary').trim(),
    colorScheme: document.documentElement.style.colorScheme
  })`);
  console.log('  state:', st);
  await shot(`05-theme-${tag}`);
};

await switchTheme('Dark', 'dark');
await switchTheme('Olive', 'olive');
await switchTheme('Light', 'light');

console.log('\n== page errors seen ==');
console.log(await evaluate(`(window.__errs||[]).join(' | ') || '(none)'`));
ws.close();
