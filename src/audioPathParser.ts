const AUDIO_EXTENSION_RE = /\.(wav|mp3|flac|ogg|opus|m4a|aac|pcm|raw)$/i;
// 起点明确的路径：URL、绝对路径、~/、./ 或 ../ 开头的相对路径、Windows 盘符和 UNC 路径。
const ANCHORED_PATH_RE = /^(?:[a-z][a-z0-9+.-]*:\/\/|[\\/]|~[\\/]|\.{1,2}[\\/]|[a-z]:[\\/])/i;
// 这些字符总会结束未加引号的 token，也会结束当前由逗号/分号连接的片段。
const HARD_BREAK_RE = /[\s"`<>{}|]/;
const FIELD_SEPARATOR_RE = /[,;]/;
// 单引号只在字段边界处才算引号，"it's" 这类撇号留在单词里；允许 Python 前缀 r''、f''、b''。
const SINGLE_QUOTE_OPEN_RE = /(?:^|[\s,;=:([{|<>"`+])(?:[rubf]|br|rb|fr|rf)?$/i;
const SINGLE_QUOTE_CLOSE_RE = /^(?:$|[\s,;:.!?)\]}|<>"`])/;
const TRAILING_PUNCTUATION_RE = /[,;:.!?]$/;
const MARKDOWN_LINK_RE = /^\[[^\]]*\]\((.*)\)$/;

export interface AudioPathCandidate {
  text: string;
  start: number;
  end: number;
}

export interface AudioPathParseOptions {
  /**
   * CSV 文档中每个逗号/分号都是字段边界；其他文档中，起点明确的路径可以跨过它们
   * （例如 `/data/a,b.wav`）。
   */
  csv?: boolean;
}

export function isHttpAudioUrl(value: string): boolean {
  if (!/^https?:\/\//i.test(value)) return false;
  try {
    const url = new URL(value);
    return !!url.hostname && AUDIO_EXTENSION_RE.test(url.pathname);
  } catch {
    return false;
  }
}

export function shouldLinkAudioPath(value: string): boolean {
  if (isHttpAudioUrl(value)) return true;
  return !!value && !/^[a-z][a-z0-9+.-]*:\/\//i.test(value)
    && !/[*?[\]|\r\n]/.test(value) && AUDIO_EXTENSION_RE.test(value);
}

/** 规整用户选中的文本：去掉首尾空白、外层引号和标点。 */
export function normalizeAudioPathText(value: string): string {
  let text = value.trim();
  const quoted = /^(["'`])(.*)\1$/s.exec(text);
  if (quoted) text = quoted[2].trim();
  const span = trimDecorations(text, 0, text.length);
  return text.slice(span.start, span.end);
}

export function collectAudioPathCandidatesFromLine(line: string, options: AudioPathParseOptions = {}): AudioPathCandidate[] {
  const candidates: AudioPathCandidate[] = [];
  scanSegment(line, 0, line.length, options.csv === true, candidates);
  return candidates;
}

/**
 * hover 使用半开区间，指到路径后一个字符时不触发；光标命令传 `includeEnd`，
 * 光标停在路径末尾时也能命中。
 */
export function findAudioPathCandidateAt(
  line: string,
  character: number,
  options: AudioPathParseOptions & { includeEnd?: boolean } = {}
): AudioPathCandidate | undefined {
  const candidates = collectAudioPathCandidatesFromLine(line, options);
  return candidates.find((candidate) => character >= candidate.start && character < candidate.end)
    ?? (options.includeEnd ? candidates.find((candidate) => character === candidate.end) : undefined);
}

function scanSegment(line: string, from: number, to: number, csv: boolean, out: AudioPathCandidate[]): void {
  let run: Array<{ start: number; end: number }> = [];
  const flush = () => {
    if (run.length) processRun(line, run, csv, out);
    run = [];
  };
  // 某个位置的引号找不到闭合时，之后同类引号也不会找到；记住这一点让扫描保持线性。
  const unclosedFrom: Record<string, number> = {};
  const quoteEnd = (index: number): number | undefined => {
    const quote = line[index];
    if (quote !== "\"" && quote !== "'" && quote !== "`") return undefined;
    // 最多需要 3 个字符：边界 + 两个字母的前缀。切片更短只会出现在片段开头，此时 `^` 就是真实边界。
    if (quote === "'" && !SINGLE_QUOTE_OPEN_RE.test(line.slice(Math.max(from, index - 3), index))) return undefined;
    if (quote !== "\"" && unclosedFrom[quote] !== undefined && index >= unclosedFrom[quote]) return undefined;
    const close = findClosingQuote(line, index, to);
    if (close === undefined && quote !== "\"") unclosedFrom[quote] = index;
    return close;
  };

  let index = from;
  while (index < to) {
    const char = line[index];
    const close = quoteEnd(index);
    if (close !== undefined) {
      flush();
      addQuotedField(line, index + 1, close, char, out);
      index = close + 1;
      continue;
    }
    if (HARD_BREAK_RE.test(char)) {
      flush();
      index++;
      continue;
    }
    if (FIELD_SEPARATOR_RE.test(char)) {
      index++;
      continue;
    }
    let end = index + 1;
    while (end < to && !HARD_BREAK_RE.test(line[end]) && !FIELD_SEPARATOR_RE.test(line[end])
      && !(line[end] === "'" && quoteEnd(end) !== undefined)) {
      end++;
    }
    run.push({ start: index, end });
    index = end;
  }
  flush();
}

function findClosingQuote(line: string, open: number, to: number): number | undefined {
  const quote = line[open];
  for (let index = open + 1; index < to; index++) {
    const char = line[index];
    if (char === "\r" || char === "\n") return undefined;
    if (char !== quote) continue;
    if (quote === "\"" && line[index + 1] === "\"" && index + 1 < to) {
      index++; // CSV escaped quote
      continue;
    }
    if (quote === "'" && !SINGLE_QUOTE_CLOSE_RE.test(line.slice(index + 1, Math.min(to, index + 2)))) continue;
    return index;
  }
  return undefined;
}

function addQuotedField(line: string, start: number, end: number, quote: string, out: AudioPathCandidate[]): void {
  const raw = line.slice(start, end);
  const text = (quote === "\"" ? raw.replace(/""/g, "\"") : raw).trim();
  const wholeStart = start + raw.length - raw.trimStart().length;
  const wholeEnd = start + raw.trimEnd().length;

  // 引号字段可能整体就是路径（"/tmp/a b.wav"），也可能是含路径的一句话（"saved to /data/a.wav"）。
  // 字段本身不是路径，或含空格且内部有起点明确的路径时，取内部路径。
  const inner: AudioPathCandidate[] = [];
  scanSegment(line, start, end, false, inner);
  const whole = shouldLinkAudioPath(text);
  if (inner.length && (!whole || (/\s/.test(text) && inner.some((candidate) => ANCHORED_PATH_RE.test(candidate.text))))) {
    out.push(...inner);
  } else if (whole) {
    out.push({ text, start: wholeStart, end: wholeEnd });
  }
}

/**
 * 只由 `,` 或 `;` 隔开的 token 组成一个片段。CSV 中每个 token 都是独立字段；
 * 其他文档中，起点明确但本身不是音频路径的 token 可以与后续 token 连接，
 * 从而保留 `/data/a,b.wav` 和 `https://host/a;v=1/b.wav`，而 `id,/data/a.wav` 仍只识别路径。
 */
function processRun(line: string, run: Array<{ start: number; end: number }>, csv: boolean, out: AudioPathCandidate[]): void {
  let pendingStart: number | undefined;
  for (const token of run) {
    const field = anchoredValue(line, trimDecorations(line, token.start, token.end));
    const text = line.slice(field.start, field.end);
    if (shouldLinkAudioPath(text)) {
      if (pendingStart !== undefined && !ANCHORED_PATH_RE.test(text)) {
        const joined = trimDecorations(line, pendingStart, field.end);
        const joinedText = line.slice(joined.start, joined.end);
        if (shouldLinkAudioPath(joinedText)) {
          out.push({ text: joinedText, start: joined.start, end: joined.end });
          pendingStart = undefined;
          continue;
        }
      }
      out.push({ text, start: field.start, end: field.end });
      pendingStart = undefined;
    } else if (!csv && pendingStart === undefined && ANCHORED_PATH_RE.test(text)) {
      pendingStart = field.start;
    }
  }
}

/**
 * `key=/data/a.wav`、`--in=./a.wav`、`load(/data/a.wav)`：token 本身起点不明确，
 * 但 `=` 或 `(` 之后是起点明确的路径时，取后面的值。
 */
function anchoredValue(line: string, span: { start: number; end: number }): { start: number; end: number } {
  if (ANCHORED_PATH_RE.test(line.slice(span.start, span.end))) return span;
  for (let index = span.start; index < span.end; index++) {
    if (line[index] !== "=" && line[index] !== "(") continue;
    const value = trimDecorations(line, index + 1, span.end);
    if (ANCHORED_PATH_RE.test(line.slice(value.start, value.end))) return value;
  }
  return span;
}

/** 去掉 token 外围的包裹和标点：`(path)`、`[x](path)`、`path:`、`path).` */
function trimDecorations(line: string, start: number, end: number): { start: number; end: number } {
  for (;;) {
    const text = line.slice(start, end);
    if (!text) return { start, end };
    const markdown = MARKDOWN_LINK_RE.exec(text);
    if (markdown) {
      start = end - 1 - markdown[1].length;
      end--;
      continue;
    }
    const first = text[0];
    const last = text[text.length - 1];
    if (text.length >= 2 && ((first === "(" && last === ")") || (first === "[" && last === "]"))) {
      start++;
      end--;
      continue;
    }
    // 不成对或撇号式单引号留下的引号字符。
    if (first === "'") {
      start++;
      continue;
    }
    if (TRAILING_PUNCTUATION_RE.test(last) || last === "'"
      || (last === ")" && count(text, ")") > count(text, "("))
      || (last === "]" && count(text, "]") > count(text, "["))) {
      end--;
      continue;
    }
    if ((first === "(" && count(text, "(") > count(text, ")"))
      || (first === "[" && count(text, "[") > count(text, "]"))) {
      start++;
      continue;
    }
    return { start, end };
  }
}

function count(text: string, char: string): number {
  let total = 0;
  for (const value of text) if (value === char) total++;
  return total;
}
