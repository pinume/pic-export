const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

async function render(merchant, options = {}) {
  const elements = new Map();
  const document = { querySelector(id) {
    if (!elements.has(id)) elements.set(id, { textContent: '', hidden: true, listeners: {}, addEventListener(event, fn) { this.listeners[event] = fn; } });
    return elements.get(id);
  } };
  const requested = [], opened = [], updated = [];
  const tabs = options.tabs || [{ id: 7 }];
  const chrome = {
    tabs: { query: async query => query.active ? [{ id: 7 }] : query.url.endsWith('popup.html*') ? options.pages || [] : tabs, create: async tab => opened.push(tab), update: async (id, changes) => updated.push({ id, ...changes }) },
    windows: { update: async () => {} },
    scripting: { executeScript: async request => {
      if (options.error) throw new Error(options.error);
      return request.files ? [] : [{ result: merchant }];
    } },
    runtime: { getURL: path => 'chrome-extension://fixture/' + path, sendMessage: async message => {
      requested.push(message.business);
      return options.response || { ok: true, task: { status: 'paused', completed: 8, skipped: 2, failed: 1 } };
    } }
  };
  vm.runInNewContext(fs.readFileSync(require.resolve('../entry.js'), 'utf8'), { chrome, document, URL, window: { close() {} } });
  await new Promise(resolve => setImmediate(resolve));
  return { elements, requested, opened, updated };
}

for (const [business, prefix, other, number, button] of [
  ['appliance', 'entry', 'digital', '89813015722APT1', '#open-task'],
  ['digital', 'digital', 'entry', '89813014812B06R', '#open-digital']
]) {
  test('entry shows only the detected ' + business + ' function and binds its source tab', async () => {
    const { elements, requested, opened } = await render({ name: '测试商户', number, business });
    assert.deepEqual(requested, [business]);
    assert.equal(elements.get('#' + prefix + '-card').hidden, false);
    assert.equal(elements.get('#' + prefix + '-status').textContent, '已暂停');
    assert.equal(elements.get('#' + prefix + '-progress').textContent, '成功 8 · 跳过 2 · 失败 1');
    assert.equal(elements.get('#merchant-name').textContent, '测试商户');
    assert.match(elements.get('#merchant-number').textContent, new RegExp(number));
    await elements.get(other === 'digital' ? '#open-digital' : '#open-task').listeners.click();
    assert.equal(opened.length, 0);
    await elements.get(button).listeners.click();
    assert.equal(new URL(opened[0].url).searchParams.get('business'), business);
    assert.equal(new URL(opened[0].url).searchParams.get('tabId'), '7');
  });
  test('reused ' + business + ' console binds the current source instead of the old page', async () => {
    const { elements, opened, updated } = await render({ name: '测试商户', number, business }, {
      tabs: [{ id: 7 }, { id: 8 }],
      pages: [{ id: 100, windowId: 1, url: 'chrome-extension://fixture/popup.html?business=' + business + '&tabId=8' }]
    });
    await elements.get(button).listeners.click();
    assert.equal(opened.length, 0);
    assert.equal(updated[0].id, 100);
    assert.equal(updated[0].active, true);
    assert.equal(new URL(updated[0].url).searchParams.get('business'), business);
    assert.equal(new URL(updated[0].url).searchParams.get('tabId'), '7');
  });
}

test('unsupported merchant exposes no export entry', async () => {
  const { elements, requested } = await render({ name: '其他商户', number: '898000000000001', business: null });
  assert.deepEqual(requested, []);
  assert.match(elements.get('#entry-error').textContent, /未配置/);
  assert.equal(elements.get('#merchant-name').textContent, '其他商户');
});

test('merchant detection failure exposes no export entry', async () => {
  const { elements, requested } = await render(null, { error: '登录已失效' });
  assert.deepEqual(requested, []);
  assert.equal(elements.get('#merchant-name').textContent, '未识别');
  assert.match(elements.get('#entry-error').textContent, /登录已失效/);
});

test('entry does not guess among multiple inactive website tabs', async () => {
  const { elements, requested } = await render(null, { tabs: [{ id: 8 }, { id: 9 }] });
  assert.deepEqual(requested, []);
  assert.match(elements.get('#entry-error').textContent, /需要导出/);
});

test('state read failure remains visible for the matched function', async () => {
  const { elements } = await render({ name: '测试商户', number: '89813014812B06R', business: 'digital' }, { response: { ok: false, error: '读取异常' } });
  assert.equal(elements.get('#digital-status').textContent, '读取失败');
  assert.equal(elements.get('#entry-error').textContent, '读取异常');
});
