// Models under test for fidelity.mjs, all behind one interface:
//   respond(systemPrompt, contextText, instruction) -> Promise<string>
// The context is passed separately from the instruction so a provider can put them
// wherever suits it; every provider returns the raw model text and nothing else.
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';

// Headless Claude Code, because that is the environment compaction actually runs in.
// Tools are off and the system prompt is replaced so the model answers with text instead
// of acting, and it runs from a scratch directory so no project CLAUDE.md is picked up.
// The context goes over stdin: a whole transcript is far beyond the OS argv limit.
export function claudeProvider({ model, bin = 'claude', timeoutMs = 300_000 } = {}) {
  return {
    name: 'claude',
    calls: 0,
    async respond(systemPrompt, contextText, instruction) {
      this.calls++;
      const args = [
        '-p', '--output-format', 'text',
        '--system-prompt', systemPrompt,
        '--tools', '',
        '--disable-slash-commands',
        '--no-session-persistence',
      ];
      if (model) args.push('--model', model);
      const r = spawnSync(bin, args, {
        input: `${contextText}\n\n${instruction}`,
        cwd: tmpdir(),
        encoding: 'utf8',
        timeout: timeoutMs,
        maxBuffer: 64 * 1024 * 1024,
      });
      if (r.error) throw new Error(`claude -p failed to run: ${r.error.message}`);
      if (r.status !== 0) {
        throw new Error(`claude -p exited ${r.status}: ${(r.stderr || r.stdout || '').slice(0, 300)}`);
      }
      return r.stdout;
    },
  };
}

// Any OpenAI-compatible chat endpoint. OPENROUTER_API_KEY is read from the environment
// only; OPENROUTER_BASE_URL overrides the endpoint for other compatible hosts.
export function openrouterProvider({ model, env = process.env, fetchImpl = fetch } = {}) {
  const apiKey = env.OPENROUTER_API_KEY;
  if (!apiKey) throw new Error('OPENROUTER_API_KEY is not set (needed for --provider openrouter)');
  if (!model) throw new Error('--model is required for --provider openrouter');
  const base = (env.OPENROUTER_BASE_URL || 'https://openrouter.ai/api/v1').replace(/\/+$/, '');
  return {
    name: 'openrouter',
    calls: 0,
    async respond(systemPrompt, contextText, instruction) {
      this.calls++;
      const res = await fetchImpl(`${base}/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({
          model,
          temperature: 0,
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: `${contextText}\n\n${instruction}` },
          ],
        }),
      });
      if (!res.ok) throw new Error(`chat endpoint returned ${res.status}: ${(await res.text()).slice(0, 300)}`);
      const body = await res.json();
      const text = body?.choices?.[0]?.message?.content;
      if (typeof text !== 'string') throw new Error('chat endpoint returned no message content');
      return text;
    },
  };
}

// Canned output for tests: never touches the network. `answer` is a string, or a function
// (systemPrompt, contextText, instruction, callNumber) -> string.
export function fakeProvider(answer = '{"tool":"Read","input":{"file_path":"src/a.mjs"}}') {
  return {
    name: 'fake',
    calls: 0,
    async respond(systemPrompt, contextText, instruction) {
      this.calls++;
      return typeof answer === 'function' ? answer(systemPrompt, contextText, instruction, this.calls) : answer;
    },
  };
}

export function makeProvider(name, opts = {}) {
  if (name === 'claude') return claudeProvider(opts);
  if (name === 'openrouter') return openrouterProvider(opts);
  if (name === 'fake') return fakeProvider(opts.answer);
  throw new Error(`unknown provider "${name}" (expected claude, openrouter or fake)`);
}
