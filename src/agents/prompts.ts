import { readFileSync } from 'node:fs';

const cache = new Map<string, string>();

/** Prompts versionados em src/agents/prompts/*.md (copiados para dist no build). */
export function loadPrompt(name: string): string {
  if (!cache.has(name)) {
    cache.set(name, readFileSync(new URL(`./prompts/${name}.md`, import.meta.url), 'utf8'));
  }
  return cache.get(name)!;
}

export function fill(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_, k) => vars[k] ?? '');
}
