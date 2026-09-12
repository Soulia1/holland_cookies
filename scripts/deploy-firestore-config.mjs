/**
 * Deploy firestore.rules and firestore.indexes.json using the service account.
 *
 *     node scripts/deploy-firestore-config.mjs [--project <id>]
 *
 * `firebase deploy --only firestore:rules,firestore:indexes` is the normal way
 * to do this and it is better when it works. It does not work with a plain
 * Firebase Admin SDK service account: before deploying anything it calls
 * serviceusage.googleapis.com to check the Firestore API is enabled, and the
 * Admin SDK agent role has no serviceusage permission — so it fails the
 * precheck with a 403 while being perfectly able to do the actual work.
 *
 * This talks to the two REST APIs the CLI would have used, with the credential
 * we already have, and skips the precheck we do not need — the API is
 * self-evidently enabled, because we just read from Firestore through it.
 *
 * Indexes are created individually and an "already exists" is treated as
 * success, so this is safe to re-run.
 */

import { readFileSync } from 'node:fs';
import { GoogleAuth } from 'google-auth-library';

const KEY = 'backend/serviceAccount.json';
const key = JSON.parse(readFileSync(KEY, 'utf8'));
const argProject = process.argv.indexOf('--project');
const project = argProject > -1 ? process.argv[argProject + 1] : key.project_id;

const auth = new GoogleAuth({
  credentials: key,
  scopes: ['https://www.googleapis.com/auth/cloud-platform'],
});
const client = await auth.getClient();

async function api(url, options = {}) {
  const res = await client.request({ url, ...options });
  return res.data;
}

console.log(`\n  Deploying Firestore configuration to ${project}\n`);

// ---------------------------------------------------------------- rules ----
// Rules are deployed in two steps: create an immutable ruleset, then point the
// release at it. That is the same shape the CLI uses, and it is why a bad
// ruleset cannot half-apply.
const source = readFileSync('firestore.rules', 'utf8');

const ruleset = await api(
  `https://firebaserules.googleapis.com/v1/projects/${project}/rulesets`,
  {
    method: 'POST',
    data: { source: { files: [{ name: 'firestore.rules', content: source }] } },
  },
).catch((error) => {
  console.error('  ✖ could not create the ruleset:', error.response?.data?.error?.message ?? error.message);
  process.exit(1);
});

console.log(`  ruleset created: ${ruleset.name.split('/').pop()}`);

const releaseName = `projects/${project}/releases/cloud.firestore`;
try {
  await api(`https://firebaserules.googleapis.com/v1/${releaseName}`, {
    method: 'PATCH',
    data: { release: { name: releaseName, rulesetName: ruleset.name } },
  });
  console.log('  rules released to cloud.firestore\n');
} catch (error) {
  // No release exists yet on a brand new project; create rather than update.
  if (error.response?.status === 404) {
    await api(`https://firebaserules.googleapis.com/v1/projects/${project}/releases`, {
      method: 'POST',
      data: { name: releaseName, rulesetName: ruleset.name },
    });
    console.log('  rules released to cloud.firestore (first release)\n');
  } else {
    console.error('  ✖ could not release the rules:', error.response?.data?.error?.message ?? error.message);
    process.exit(1);
  }
}

// -------------------------------------------------------------- indexes ----
const config = JSON.parse(readFileSync('firestore.indexes.json', 'utf8'));
const base = `https://firestore.googleapis.com/v1/projects/${project}/databases/(default)/collectionGroups`;

let created = 0;
let existing = 0;

for (const index of config.indexes ?? []) {
  const fields = index.fields.map((f) => ({
    fieldPath: f.fieldPath,
    ...(f.order ? { order: f.order } : {}),
    ...(f.arrayConfig ? { arrayConfig: f.arrayConfig } : {}),
  }));
  const label = `${index.collectionGroup}(${index.fields.map((f) => `${f.fieldPath} ${f.order ?? f.arrayConfig}`).join(', ')})`;
  try {
    await api(`${base}/${index.collectionGroup}/indexes`, {
      method: 'POST',
      data: { queryScope: index.queryScope || 'COLLECTION', fields },
    });
    console.log(`  + ${label}`);
    created += 1;
  } catch (error) {
    const message = error.response?.data?.error?.message ?? error.message;
    if (/already exists/i.test(message)) {
      console.log(`  = ${label} (already exists)`);
      existing += 1;
    } else {
      console.error(`  ✖ ${label}\n      ${message}`);
      process.exit(1);
    }
  }
}

// ------------------------------------------------------- field overrides ----
let overrides = 0;
for (const override of config.fieldOverrides ?? []) {
  const name = `${base}/${override.collectionGroup}/fields/${encodeURIComponent(override.fieldPath)}`;
  try {
    // `updateMask=indexConfig`, not `updateMask.fieldPaths=` — the Firestore
    // Admin API takes the mask as a single query parameter here, and the dotted
    // form is rejected with "Field 'fieldPaths' could not be found".
    await api(`${name}?updateMask=indexConfig`, {
      method: 'PATCH',
      data: { indexConfig: { indexes: override.indexes ?? [] } },
    });
    console.log(`  ~ exempt ${override.collectionGroup}.${override.fieldPath} from indexing`);
    overrides += 1;
  } catch (error) {
    console.error(`  ✖ override ${override.collectionGroup}.${override.fieldPath}: `
      + (error.response?.data?.error?.message ?? error.message));
  }
}

console.log(`\n  ${created} index(es) created, ${existing} already present, ${overrides} field override(s) applied.`);
console.log('  Composite indexes build in the background — large ones take a few minutes.\n');
