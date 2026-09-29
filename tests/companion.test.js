const test = require("node:test");
const assert = require("node:assert/strict");

const excerpt = {
  id: "note_1",
  sourceId: "youtube:abc123",
  sourceTitle: "A useful interview",
  sourceUrl: "https://youtube.com/watch?v=abc123&t=90s",
  text: "A complete, timestamped thought.",
  note: "Channel: Example · 1:30",
  translation: "一段完整并带有时间戳的想法。",
  createdAt: "2026-09-08T01:30:00.000Z",
};

test("companion groups repeated notes below one dated source", async () => {
  const { appendExcerpt } = await import("../scripts/companion/companion-notebook.mjs");
  const first = appendExcerpt("# Readnote Atlas\n", excerpt);
  const second = appendExcerpt(first, {
    ...excerpt,
    id: "note_2",
    text: "A second idea.",
    createdAt: "2026-09-08T01:45:00.000Z",
  });

  assert.equal((second.match(/#### A useful interview/g) || []).length, 1);
  assert.match(second, /\[Source\]\(https:\/\/youtube\.com\/watch\?v=abc123&t=90s\)/);
  assert.match(second, /> A second idea\./);
  assert.match(second, /Chinese: 一段完整并带有时间戳的想法。/);
});

test("Notion output keeps the playable source and note context", async () => {
  const { buildNotionExcerptBlocks } = await import("../scripts/companion/companion-notion.mjs");
  const blocks = buildNotionExcerptBlocks(excerpt);
  const serialized = JSON.stringify(blocks);

  assert.equal(blocks[0].type, "heading_3");
  assert.match(serialized, /youtube\.com\/watch\?v=abc123/);
  assert.match(serialized, /Channel: Example/);
  assert.match(serialized, /一段完整并带有时间戳的想法/);
});

test("companion defaults to the same DeepSeek provider as video features", async () => {
  const { translationProviderStatus } = await import("../scripts/companion/companion-openai.mjs");
  const status = translationProviderStatus({ apiKey: "" });
  assert.equal(status.provider, "deepseek");
  assert.equal(status.model, "deepseek-v4-flash");
});

test('article provider preserves valid partial results and positions for targeted retries', async () => {
  const { translateParagraphs } = await import('../scripts/companion/companion-openai.mjs');
  const result = await translateParagraphs({ paragraphs: ['First.', 'Second.', 'Third.'] }, {
    provider: 'deepseek', apiKey: 'test-key',
    fetchImpl: async (_url, init) => {
      assert.ok(init.signal instanceof AbortSignal);
      return { ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify({translations: ['第一。', ' ', {text: '第三。'}]}) } }] }) };
    }
  });
  assert.deepEqual(result, ['第一。', '', '第三。']);
});

test('article provider rejects count mismatch instead of attaching translations to wrong blocks', async () => {
  const { translateParagraphs } = await import('../scripts/companion/companion-openai.mjs');
  await assert.rejects(translateParagraphs({ paragraphs: ['First.', 'Second.'] }, {
    provider: 'deepseek', apiKey: 'test-key',
    fetchImpl: async () => ({ ok: true, json: async () => ({ choices: [{ message: {content: '{"translations":["第一。"]}'} }] }) })
  }), /translation_count_mismatch/);
});
