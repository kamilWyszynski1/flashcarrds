import type { ExtractedCard } from './types';

/**
 * Parse a pasted vocabulary list, one pair per line:
 *   "la ventana – okno", "la ventana - okno", "la ventana — okno",
 *   "la ventana; okno", "la ventana\tokno", "la ventana = okno", "la ventana: okno"
 * An optional third field becomes the example sentence.
 */
export function parsePairs(text: string): ExtractedCard[] {
  const out: ExtractedCard[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const parts = splitLine(line);
    if (parts.length < 2) {
      out.push({ front: line, back: '', confidence: 0.3 });
      continue;
    }
    const [front, back, ...rest] = parts;
    const example = rest.join(' ').trim();
    out.push({ front, back, example: example || null, confidence: 1 });
  }
  return out;
}

function splitLine(line: string): string[] {
  // Prefer explicit separators in order of how unambiguous they are.
  const seps = [/\t+/, /\s+[–—]\s+/, /\s+-\s+/, /\s*;\s*/, /\s*\|\s*/, /\s+=\s+/, /\s*:\s+/];
  for (const re of seps) {
    const parts = line.split(re).map((p) => p.trim()).filter(Boolean);
    if (parts.length >= 2) return parts;
  }
  return [line];
}
