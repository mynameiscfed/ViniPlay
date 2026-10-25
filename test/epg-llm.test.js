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
