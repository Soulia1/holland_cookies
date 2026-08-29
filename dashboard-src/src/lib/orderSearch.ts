import { normalizeText } from "@shared/orderSearch.mjs";

export interface HighlightSegment {
  text: string;
  match: boolean;
}

/**
 * Where a query lands inside a piece of text, in the ORIGINAL text's offsets.
 *
 * Matching is normalised — case-folded, NFKC, Arabic marks stripped — and
 * normalising changes length, so a match found in the normalised form cannot be
 * sliced out of the original by the same index. The fold is therefore done one
 * character at a time, keeping a map back to where each normalised character
 * came from. That is what lets "no" highlight the first two letters of
 * "Noha Ahmed" and "احمد" highlight the same letters in "أحمد" — the customer's
 * name is rendered exactly as they wrote it, with the marks intact.
 */
function foldWithSourceMap(text: string) {
  let normalized = "";
  // sources[i] is the index in `text` that normalized[i] came from; ends[i] is
  // where that source character finishes, so a match can be sliced inclusively.
  const starts: number[] = [];
  const ends: number[] = [];

  let cursor = 0;
  for (const char of text) {
    const start = cursor;
    cursor += char.length; // Code points, so an emoji is never split in half.
    // Whitespace runs collapse to a single space, matching how a query is
    // normalised — otherwise "noha ahmed" would miss "Noha  Ahmed".
    const folded = /\s/.test(char)
      ? (normalized.endsWith(" ") || normalized === "" ? "" : " ")
      : normalizeText(char);
    for (const piece of folded) {
      normalized += piece;
      starts.push(start);
      ends.push(cursor);
    }
  }
  return { normalized, starts, ends };
}

/**
 * `text` split into runs, with the part matching `query` marked.
 *
 * Returns a single unmatched segment when there is nothing to mark, so callers
 * can render the result unconditionally.
 */
export function highlightSegments(text: string, query: string): HighlightSegment[] {
  const whole = [{ text, match: false }];
  if (!text || !query) return whole;

  const needle = normalizeText(query);
  if (!needle) return whole;

  const { normalized, starts, ends } = foldWithSourceMap(text);
  const at = normalized.indexOf(needle);
  if (at < 0) return whole;

  const from = starts[at];
  const to = ends[at + needle.length - 1];
  return [
    { text: text.slice(0, from), match: false },
    { text: text.slice(from, to), match: true },
    { text: text.slice(to), match: false },
  ].filter((segment) => segment.text.length > 0);
}
