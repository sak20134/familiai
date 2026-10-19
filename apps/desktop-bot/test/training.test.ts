// The fine-tuning data must teach the tools the bot really has, with the real fields.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { desktopTools } from '../src/main/desktop/tools';
import { emailTools } from '../src/main/email/tools';
import { familyTools } from '../src/main/family/tools';

const dir = join(__dirname, '..', 'training', 'data');
const rows = (f: string) => readFileSync(join(dir, f), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as { tools: Array<{ function: { name: string; parameters: { properties: Record<string, unknown>; required?: string[] } } }>; tool: string | null; args: Record<string, unknown> | null });

describe('training data', () => {
  const real = [...desktopTools({ sys: {} as never, takeover: {} as never, openExternal: async () => {} }), ...familyTools({ screen: {} as never, memory: {} as never, sys: {} as never }), ...emailTools({} as never)];
  const streamSrc = readFileSync(join(__dirname, '..', '..', 'stream-copilot', 'src', 'tools.ts'), 'utf8');
  const streamNames = [...streamSrc.matchAll(/^\s+(\w+): \{ name: '/gm)].map((m) => `stream_${m[1]}`);

  it('lists exactly the real tools, with the real fields', () => {
    const listed = rows('train.jsonl')[0]!.tools.map((t) => t.function);
    expect(listed.map((t) => t.name).sort()).toEqual([...real.map((t) => t.spec.name), ...streamNames].sort());
    for (const t of real) {
      const l = listed.find((x) => x.name === t.spec.name)!;
      expect(Object.keys(l.parameters.properties).sort(), t.spec.name).toEqual(Object.keys(t.input.properties).sort());
      expect(l.parameters.required ?? [], t.spec.name).toEqual([...(t.input.required ?? [])]);
    }
  });

  it('every example calls a real tool with fields that exist, and train/test do not overlap', () => {
    for (const f of ['train.jsonl', 'test.jsonl']) {
      for (const r of rows(f)) {
        if (!r.tool) continue;
        const spec = r.tools.find((t) => t.function.name === r.tool)!.function;
        for (const k of Object.keys(r.args ?? {})) expect(Object.keys(spec.parameters.properties), `${r.tool}.${k}`).toContain(k);
        for (const k of spec.parameters.required ?? []) expect(r.args, `${r.tool} needs ${k}`).toHaveProperty(k);
      }
    }
    const ask = (f: string) => new Set(readFileSync(join(dir, f), 'utf8').trim().split('\n').map((l) => (JSON.parse(l).messages[1].content as string).split('[Request]\n')[1]));
    const train = ask('train.jsonl');
    expect([...ask('test.jsonl')].filter((x) => train.has(x))).toEqual([]);
  });
});
