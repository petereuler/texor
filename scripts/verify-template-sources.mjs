#!/usr/bin/env node

import fs from 'node:fs/promises';
import path from 'node:path';

const root = path.resolve(new URL('..', import.meta.url).pathname);
const catalogPath = path.join(root, 'templates', 'catalog.json');
const distTemplateCatalogPath = path.join(root, 'dist-server', 'lib', 'templateCatalog.js');

async function main() {
  const raw = await fs.readFile(catalogPath, 'utf8');
  const entries = JSON.parse(raw);
  for (const entry of entries) {
    if (!entry.sourceProvider || !entry.sourceKind) {
      throw new Error(`Template entry ${entry.id} is missing sourceProvider/sourceKind.`);
    }
  }

  const { searchTemplateCatalog, ensureTemplate } = await import(`file://${distTemplateCatalogPath}`);
  const checks = [
    { query: 'IEEE Transactions on Wireless Communications', expectedId: 'ieee-article' },
    { query: 'ACM Transactions on Graphics', expectedId: 'acm-acmart' },
    { query: 'Information Sciences', expectedId: 'elsevier-elsarticle' },
  ];

  for (const check of checks) {
    const results = await searchTemplateCatalog(check.query, 3);
    const top = results[0];
    if (!top || top.id !== check.expectedId) {
      throw new Error(`Template search failed for "${check.query}". Expected ${check.expectedId}, got ${top?.id || 'none'}.`);
    }
    const ensured = await ensureTemplate(top.id);
    if (!ensured.ok) {
      throw new Error(`Template ensure failed for ${top.id}: ${ensured.message}`);
    }
    console.log(`ok   ${check.query} -> ${top.id} (${ensured.sourceUrl || 'no source'})`);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
