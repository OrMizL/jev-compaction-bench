// Adapter: Claude Code JSONL session transcript -> fast-jev-compaction Message[]
// Usage: node adapt.mjs <transcript.jsonl> <out.json>
import { readFileSync, writeFileSync } from 'node:fs';

const [, , inPath, outPath] = process.argv;
if (!inPath || !outPath) {
  console.error('usage: node adapt.mjs <transcript.jsonl> <out.json>');
  process.exit(2);
}

const lines = readFileSync(inPath, 'utf8').split('\n');
const messages = [];
const counters = { entries: 0, text: 0, thinking: 0, tool_use: 0, tool_result: 0, skipped: 0 };

function resultText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((b) => {
        if (typeof b === 'string') return b;
        if (b && b.type === 'text') return b.text ?? '';
        if (b && b.type === 'image') return '[image]';
        return '';
      })
      .join('\n');
  }
  return content == null ? '' : String(content);
}

for (const line of lines) {
  const t = line.trim();
  if (!t) continue;
  let e;
  try { e = JSON.parse(t); } catch { counters.skipped++; continue; }
  const m = e.message;
  if (!m || !m.role || (m.role !== 'user' && m.role !== 'assistant')) { counters.skipped++; continue; }
  const content = m.content;
  let text = '';
  const toolUses = [];
  const toolResults = [];

  if (typeof content === 'string') {
    text = content;
  } else if (Array.isArray(content)) {
    for (const b of content) {
      if (!b || typeof b !== 'object') continue;
      if (b.type === 'text') { text += (text ? '\n' : '') + (b.text ?? ''); counters.text++; }
      else if (b.type === 'thinking') { counters.thinking++; }
      else if (b.type === 'tool_use') {
        toolUses.push({ tool_use_id: b.id, tool: b.name, input: b.input ?? {} });
        counters.tool_use++;
      } else if (b.type === 'tool_result') {
        toolResults.push({
          tool_use_id: b.tool_use_id,
          text: resultText(b.content),
          isError: b.is_error === true,
        });
        counters.tool_result++;
      }
    }
  }

  const msg = { role: m.role, text, toolUses };
  if (toolResults.length) msg.toolResults = toolResults;
  messages.push(msg);
  counters.entries++;
}

writeFileSync(outPath, JSON.stringify(messages));
const chars = messages.reduce(
  (n, m) => n + m.text.length + m.toolUses.length * 0 +
    (m.toolResults ?? []).reduce((k, r) => k + r.text.length, 0), 0);
console.log(JSON.stringify({ messages: messages.length, chars, counters }, null, 2));