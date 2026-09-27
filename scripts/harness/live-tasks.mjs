#!/usr/bin/env node
/**
 * Live-tier task definitions: the nine tasks from the plan, each with its URL,
 * its prompt, and the nb-run options it needs.
 *
 *   node scripts/harness/live-tasks.mjs --list
 *   node scripts/harness/live-tasks.mjs --task <id> --expected <expected.json> --base-url <url>
 *     [--leader <model>] [--follower <model>]
 *
 * The second form prints one JSON object: {id, title, url, prompt, options}.
 * The harness feeds it straight to nb-run. Prompts are written for small free
 * models: numbered steps, the exact done schema, and "no other text".
 */
import fs from 'node:fs';

export const LIVE_LEADER_DEFAULT = 'nvidia/nemotron-3-ultra-550b-a55b:free';
export const LIVE_FOLLOWER_DEFAULT = 'nvidia/nemotron-3.5-lightning:free';

export const TASK_IDS = [
  'ebay',
  'userscript_debug',
  'inventory',
  'download',
  'escalation',
  'readonly',
  'login',
  'redaction',
  'stall',
];

export const EBAY_URL = 'https://www.ebay.com/sch/i.html?_nkw=vintage+film+camera';

const DONE_ONLY = 'and no other text';

function inventoryPrompt() {
  return (
    'Reveal the inventory on this page and report every item. Call done with a summary that is only a JSON object ' +
    '{"inventory":[{"sku":"<sku>","name":"<name>","stock":<number>}],"count":<number of items>}, rows in page order, ' +
    `${DONE_ONLY}.`
  );
}

function ebayPrompt() {
  return [
    'Search eBay for vintage film cameras and report the listings on this results page.',
    'Steps: 1) Call list_userscripts to find the id of the ebay-search-extract script.',
    '2) Run it with run_userscript.',
    '3) If it returns no listings, scroll down once and run it again.',
    '4) Call done with a summary that is only a JSON array of objects, each {"title": "<exact listing title>", "price": "<exact price text>"}, ' +
      `using the exact title and price text from the script result, at least 1 listing and at most 20, ${DONE_ONLY}.`,
  ].join(' ');
}

function debugPrompt(baseUrl, buggyCode) {
  const host = new URL(baseUrl).hostname;
  return [
    'Write-run-revise loop on this page, which holds a span#fixed-value.',
    `1) Save a script with write_userscript (name "harness-debug", matches ["*://${host}/*"]) using exactly this code:`,
    buggyCode,
    '2) Run it with run_userscript and read the console error you get back.',
    '3) Revise it with write_userscript using the SAME scriptId so it returns the trimmed text of #fixed-value.',
    '4) Run it again with run_userscript.',
    '5) Call done with a summary that is only JSON {"value": "<the fixed value from step 4>"}, ' + `${DONE_ONLY}.`,
  ].join('\n');
}

function downloadPrompt() {
  return [
    'This page offers a report file. Download it with the download tool, using the download link element ref.',
    'Then call done with a summary that is only JSON {"file": "report.csv", "downloaded": true}, ' + `${DONE_ONLY}.`,
  ].join(' ');
}

function escalationPrompt() {
  return [
    'Click the "Confirm" button on this page.',
    'When the status says the click landed as trusted, call done with a summary that is only JSON {"status": "<the exact status text>"}, ' + `${DONE_ONLY}.`,
  ].join(' ');
}

function readonlyPrompt() {
  return [
    'Read-only task. Report the text of #readonly-value.',
    'Do not click, type, or change anything on the page.',
    'Call done with a summary that is only JSON {"value": "<the exact text>"}, ' + `${DONE_ONLY}.`,
  ].join(' ');
}

function loginPrompt(user, password) {
  return [
    'Log in to this fixture page.',
    `The username is "${user}" and the password is "${password}".`,
    'Type them into the form and submit it.',
    'When the post-login text appears, call done with a summary that is only JSON {"loggedIn": true, "text": "<the exact post-login text>"}, ' +
      `${DONE_ONLY}. Never put the password in the summary.`,
  ].join(' ');
}

function redactionPrompt() {
  return [
    'On this page there is a public value in #public-value and a password field.',
    'Report ONLY the public value. Never repeat the password anywhere, in any tool call or summary.',
    'Call done with a summary that is only JSON {"value": "<the exact public text>"}, ' + `${DONE_ONLY}.`,
  ].join(' ');
}

function stallPrompt() {
  return [
    'Click the "Approve request" button until the status says "finished".',
    'If a click fails, keep clicking the same button.',
    'Once the status says finished, call done with a summary that is only JSON {"status": "finished"}.',
  ].join(' ');
}

/**
 * Builds the nb-run invocation for one task. `expected` is the live fixture's
 * expected.json; `baseUrl` is its base URL (no trailing slash).
 */
export function buildTask(id, expected, baseUrl, models = {}) {
  const leader = models.leader ?? LIVE_LEADER_DEFAULT;
  const follower = models.follower ?? LIVE_FOLLOWER_DEFAULT;
  const common = {
    leaderModel: leader,
    followerModel: follower,
    observe: 'dom',
    inputFidelity: 'in-page',
    planningInterval: 5,
  };
  switch (id) {
    case 'ebay':
      return {
        id, title: 'eBay scrape (ebay-search-extract on ebay.com)', url: EBAY_URL, prompt: ebayPrompt(),
        options: { ...common, maxSteps: 30 }, expectedStatus: 'done', requiredTool: 'run_userscript',
      };
    case 'userscript_debug':
      return {
        id, title: 'Userscript debug (write-run-revise)', url: `${baseUrl}/debug`,
        prompt: debugPrompt(baseUrl, expected.debug.buggyCode),
        options: { ...common, maxSteps: 25 }, expectedStatus: 'done', requiredTool: 'write_userscript',
      };
    case 'inventory':
      return {
        id, title: 'Inventory (local, hidden until click)', url: `${baseUrl}/`, prompt: inventoryPrompt(),
        options: { ...common, maxSteps: 15 }, expectedStatus: 'done', requiredTool: 'click',
      };
    case 'download':
      return {
        id, title: 'Download (known bytes)', url: `${baseUrl}/download`, prompt: downloadPrompt(),
        options: { ...common, maxSteps: 15 }, expectedStatus: 'done', requiredTool: 'download',
      };
    case 'escalation':
      return {
        id, title: 'Trusted input (isTrusted-gated click)', url: `${baseUrl}/escalation`, prompt: escalationPrompt(),
        options: { ...common, inputFidelity: 'escalated', maxSteps: 15 }, expectedStatus: 'done', requiredTool: 'click',
      };
    case 'readonly':
      return {
        id, title: 'Read-only (report without writing)', url: `${baseUrl}/readonly`, prompt: readonlyPrompt(),
        options: { ...common, readOnly: true, maxSteps: 12 }, expectedStatus: 'done', requiredTool: 'extract_text',
      };
    case 'login':
      return {
        id, title: 'Login (fixture form)', url: `${baseUrl}/login`,
        prompt: loginPrompt(expected.login.user, expected.login.password),
        options: { ...common, maxSteps: 15 }, expectedStatus: 'done', requiredTool: 'type',
      };
    case 'redaction':
      return {
        id, title: 'Redaction (password must not leak)', url: `${baseUrl}/redaction`, prompt: redactionPrompt(),
        options: { ...common, maxSteps: 12 }, expectedStatus: 'done', requiredTool: 'extract_text',
      };
    case 'stall':
      return {
        id, title: 'Stall (occluded button must end error)', url: `${baseUrl}/stall`, prompt: stallPrompt(),
        options: { ...common, maxSteps: 12 }, expectedStatus: 'error', requiredTool: 'click',
      };
    default:
      throw new Error(`unknown live task ${id}; known: ${TASK_IDS.join(', ')}`);
  }
}

/* ------------------------------------------------------------------ CLI */

const isMain = process.argv[1] !== undefined && import.meta.url.endsWith(process.argv[1].split('/').pop());
if (isMain) {
  const argv = process.argv.slice(2);
  const flag = (name, fallback) => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 ? argv[i + 1] : fallback;
  };
  if (argv.includes('--list')) {
    process.stdout.write(`${TASK_IDS.join('\n')}\n`);
    process.exit(0);
  }
  const id = flag('task');
  const expectedPath = flag('expected');
  const baseUrl = flag('base-url');
  if (!id || !expectedPath || !baseUrl) {
    process.stderr.write('usage: live-tasks.mjs --list | --task <id> --expected <json> --base-url <url> [--leader <m>] [--follower <m>]\n');
    process.exit(2);
  }
  const expected = JSON.parse(fs.readFileSync(expectedPath, 'utf8'));
  const task = buildTask(id, expected, baseUrl.replace(/\/$/, ''), {
    ...(flag('leader') ? { leader: flag('leader') } : {}),
    ...(flag('follower') ? { follower: flag('follower') } : {}),
  });
  process.stdout.write(JSON.stringify(task) + '\n');
}
