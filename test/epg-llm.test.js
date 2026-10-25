// The model picks among candidates only; see epgLlm.js.
const { test } = require('node:test');
const assert = require('node:assert');
const { pickWithLlm } = require('../epgLlm');

const item = (name, ...ids) => ({ name, group: 'g', candidates: ids.map((id) => ({ id, names: [id] })) });
const reply = (content) => async () => ({ data: { choices: [{ message: { content } }] } });

test('accepts a candidate, null, and drops anything else', async () => {
    const items = [item('CNN Intl', 'CNN.us', 'CNN2.us'), item('Nothing', 'A.us'), item('Liar', 'B.us'), item('Silent', 'C.us')];
    // "Z.us" was never offered; index 3 is not answered at all
    const post = reply('Sure! ```json\n{"0":"CNN.us","1":null,"2":"Z.us"}\n```');
    assert.deepStrictEqual(await pickWithLlm(items, { apiKey: 'k', model: 'm', post }), ['CNN.us', null, undefined, undefined]);
});

test('an unreadable answer gives no picks instead of failing the run', async () => {
    const picks = await pickWithLlm([item('A', 'A.us')], { apiKey: 'k', model: 'm', post: reply('I cannot help with that.') });
    assert.deepStrictEqual(picks, [undefined]);
});

test('sends batches of 25 with the key and model, never more than the candidates', async () => {
    const calls = [];
    const post = async (url, body, config) => { calls.push({ url, body, config }); return { data: { choices: [{ message: { content: '{}' } }] } }; };
    await pickWithLlm(Array.from({ length: 60 }, (_, i) => item(`C${i}`, 'X.us')), { apiKey: 'sekret', model: 'some/model', post });
    assert.strictEqual(calls.length, 3);
    assert.strictEqual(calls[0].url, 'https://openrouter.ai/api/v1/chat/completions');
    assert.strictEqual(calls[0].config.headers.Authorization, 'Bearer sekret');
    assert.strictEqual(calls[0].body.model, 'some/model');
    assert.strictEqual(Object.keys(JSON.parse(calls[0].body.messages[1].content)).length, 25);
    assert.strictEqual(Object.keys(JSON.parse(calls[2].body.messages[1].content)).length, 10);
});

test('an upstream error rejects with its message', async () => {
    const post = async () => { throw Object.assign(new Error('Request failed with status code 402'), { response: { data: { error: { message: 'Insufficient credits' } } } }); };
    await assert.rejects(pickWithLlm([item('A', 'A.us')], { apiKey: 'k', model: 'm', post }), /Insufficient credits/);
});

// The tests below stub only the HTTP layer (`post`/`get`); nothing here talks to openrouter.ai.
const { chat, listModels, searchModels, aiStatus, updateAiConfig } = require('../epgLlm');

test('chat sends the key, a title and the model, and returns the reply text', async () => {
    let seen;
    const post = async (url, body, config) => { seen = { url, body, config }; return { data: { choices: [{ message: { content: 'OK' } }] } }; };
    assert.strictEqual(await chat({ apiKey: 'k', model: 'v/m', messages: [{ role: 'user', content: 'hi' }], maxTokens: 16, post }), 'OK');
    assert.strictEqual(seen.config.headers.Authorization, 'Bearer k');
    assert.strictEqual(seen.config.headers['X-Title'], 'ViniPlay');
    assert.strictEqual(seen.body.max_tokens, 16);
});

test('chat treats an error object inside an HTTP 200 as a failure', async () => {
    const post = async () => ({ data: { error: { message: 'Provider returned error' } } });
    await assert.rejects(chat({ apiKey: 'k', model: 'm', messages: [], maxTokens: 1, post }), /Provider returned error/);
});

test('model list: per-million prices, unknown prices, free models, cached for an hour', async () => {
    let calls = 0;
    const get = async () => {
        calls++;
        return { data: { data: [
            { id: 'a/flash', name: 'A: Flash', pricing: { prompt: '0.0000003' } },
            { id: 'b/free', name: 'B Free', pricing: { prompt: '0' } },
            { id: 'c/auto', name: 'Auto', pricing: { prompt: '-1' } },
            { id: 'd/none' },
        ] } };
    };
    const list = await listModels({ get });
    assert.deepStrictEqual(list.map((m) => m.promptPerM), [0.3, 0, null, null]);
    assert.strictEqual(list[3].name, 'd/none');
    await listModels({ get });
    assert.strictEqual(calls, 1);
});

test('model search needs every word and caps the result', () => {
    const list = Array.from({ length: 80 }, (_, i) => ({ id: `v/flash-${i}`, name: `Vendor Flash ${i}` })).concat({ id: 'x/pro', name: 'X Pro' });
    assert.strictEqual(searchModels(list, 'FLASH vendor').length, 50);
    assert.deepStrictEqual(searchModels(list, 'x pro').map((m) => m.id), ['x/pro']);
    assert.strictEqual(searchModels(list, '').length, 50);
    assert.strictEqual(searchModels(list, '', Infinity).length, 81); // ?all=1 sends the whole list
    assert.deepStrictEqual(searchModels(list, 'nothing like it'), []);
});

test('the browser only ever learns whether a key is set and how it ends', () => {
    assert.deepStrictEqual(aiStatus({ apiKey: 'sk-or-v1-abcdef123456', model: 'v/m' }), { keySet: true, keyHint: '3456', model: 'v/m' });
    assert.deepStrictEqual(aiStatus({ apiKey: 'short' }), { keySet: true, keyHint: '', model: '' });
    assert.deepStrictEqual(aiStatus(undefined), { keySet: false, keyHint: '', model: '' });
    assert.ok(!JSON.stringify(aiStatus({ apiKey: 'sk-or-v1-abcdef123456' })).includes('sk-or-v1'));
});

test('saving: a blank key keeps the saved one, clearKey removes it, bad input is refused', () => {
    const saved = { apiKey: 'sk-old', model: 'v/old' };
    assert.deepStrictEqual(updateAiConfig(saved, { apiKey: '', model: ' v/new ' }), { apiKey: 'sk-old', model: 'v/new' });
    assert.deepStrictEqual(updateAiConfig(saved, { apiKey: ' sk-new ' }), { apiKey: 'sk-new', model: 'v/old' });
    assert.deepStrictEqual(updateAiConfig(saved, { clearKey: true, apiKey: 'ignored' }), { model: 'v/old' });
    assert.deepStrictEqual(updateAiConfig({}, undefined), {});
    assert.throws(() => updateAiConfig(saved, { apiKey: 42 }), /Invalid API key/);
    assert.throws(() => updateAiConfig(saved, { apiKey: 'x'.repeat(201) }), /Invalid API key/);
    assert.throws(() => updateAiConfig(saved, { model: 'two words' }), /Invalid model/);
    assert.throws(() => updateAiConfig(saved, { model: {} }), /Invalid model/);
    assert.deepStrictEqual(saved, { apiKey: 'sk-old', model: 'v/old' }, 'the saved config is not modified in place');
});
