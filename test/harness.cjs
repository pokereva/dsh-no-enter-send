/**
 * Offline harness for dsh-no-enter-send.
 *
 * The plugin is a browser bundle: it calls window.__ModuleLoader__.load and
 * touches nothing but the DOM. This harness supplies a small fake DOM, runs
 * client.js in a fresh vm context, and asserts the keyboard contract that the
 * plugin exists for — Enter never sends, Enter still breaks the line, and the
 * gray hint is rendered.
 *
 * Run: node test/harness.cjs
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');
const CLIENT_SOURCE = fs.readFileSync(path.join(ROOT, 'client.js'), 'utf8');
const PACKAGE = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));

let passed = 0;
const failures = [];

function check(name, condition, detail) {
  if (condition) {
    passed += 1;
    return;
  }
  failures.push(name + (detail === undefined ? '' : ' — ' + detail));
}

function assertEqual(name, actual, expected) {
  check(name, actual === expected, 'expected ' + JSON.stringify(expected) + ', got ' + JSON.stringify(actual));
}

/* ------------------------------------------------------------------ fake DOM */

const allElements = [];

class FakeElement {
  constructor(tagName, attributes) {
    this.tagName = String(tagName).toUpperCase();
    this.nodeType = 1;
    this.attributes = Object.assign({}, attributes);
    this.children = [];
    this.parentElement = null;
    this.listeners = [];
    this.dispatched = [];
    this.textContent = '';
    this.className = '';
    /* Real DOM reflects the disabled *property*, which React writes directly. */
    this.disabled = false;
    /* Interaction pseudo-state the harness sets by hand, e.g. for :hover. */
    this.__hover = false;
  }

  setAttribute(name, value) {
    this.attributes[name] = String(value);
  }

  getAttribute(name) {
    const value = this.attributes[name];
    return value === undefined ? null : value;
  }

  hasAttribute(name) {
    return Object.prototype.hasOwnProperty.call(this.attributes, name);
  }

  appendChild(child) {
    child.parentElement = this;
    this.children.push(child);
    return child;
  }

  removeChild(child) {
    const index = this.children.indexOf(child);
    if (index >= 0) this.children.splice(index, 1);
    child.parentElement = null;
    return child;
  }

  addEventListener(type, handler) {
    this.listeners.push({ type, handler });
  }

  removeEventListener(type, handler) {
    const index = this.listeners.findIndex((entry) => entry.type === type && entry.handler === handler);
    if (index >= 0) this.listeners.splice(index, 1);
  }

  isConnected() {
    let node = this;
    while (node !== null && node !== undefined) {
      if (node === document.documentElement) return true;
      node = node.parentElement;
    }
    return false;
  }

  closest(selector) {
    let node = this;
    while (node !== null && node !== undefined) {
      if (matchesSelector(node, selector)) return node;
      node = node.parentElement;
    }
    return null;
  }

  matches(selector) {
    return matchesSelector(this, selector);
  }

  dispatchEvent(event) {
    event.target = this;
    this.dispatched.push(event);
    dispatchFrom(this, event);
    return !event.defaultPrevented;
  }
}

/* Selector support covers what the plugin queries: tag, [attr], tag[attr],
   [attr="value"], and the compact `:not(...)` / `:disabled` / `:hover` subset
   used by the send-button probe. Compound selectors are split on top-level
   whitespace so a descendant combinator ("a b") walks ancestors. */
const COMPOUND = /^([a-zA-Z0-9]*)((?:\[[-\w]+(?:="[^"]*")?\]|:not\([^()]*\)|:disabled|:hover)*)$/;
const PART_SOURCE = '\\[([-\\w]+)(?:="([^"]*)")?\\]|:(not)\\(([^()]*)\\)|:(disabled|hover)';

function matchCompound(element, compound) {
  const head = COMPOUND.exec(compound);
  if (head === null) throw new Error('harness: unsupported selector ' + compound);
  if (head[1] !== '' && element.tagName !== head[1].toUpperCase()) return false;
  /* A fresh matcher per call: `:not(...)` recurses, and a shared /g regex would
     have its lastIndex reset by the inner scan. */
  const partPattern = new RegExp(PART_SOURCE, 'g');
  let part;
  while ((part = partPattern.exec(head[2])) !== null) {
    if (part[1] !== undefined) {
      if (!element.hasAttribute(part[1])) return false;
      if (part[2] !== undefined && element.getAttribute(part[1]) !== part[2]) return false;
      continue;
    }
    if (part[3] === 'not') {
      if (matchesSelector(element, part[4])) return false;
      continue;
    }
    if (part[5] === 'disabled') {
      if (element.disabled !== true) return false;
      continue;
    }
    if (part[5] === 'hover') {
      if (element.__hover !== true) return false;
      continue;
    }
  }
  return true;
}

function matchesSelector(element, selector) {
  const text = String(selector).trim();
  const parts = text.split(/\s+/).filter((part) => part !== '');
  if (parts.length === 0) throw new Error('harness: unsupported selector ' + selector);
  if (!matchCompound(element, parts[parts.length - 1])) return false;
  let node = element.parentElement;
  for (let index = parts.length - 2; index >= 0; index -= 1) {
    while (node !== null && node !== undefined && !matchCompound(node, parts[index])) {
      node = node.parentElement;
    }
    if (node === null || node === undefined) return false;
    node = node.parentElement;
  }
  return true;
}

class FakeKeyboardEvent {
  constructor(type, init) {
    const opts = init === undefined || init === null ? {} : init;
    this.type = type;
    this.key = opts.key;
    this.code = opts.code;
    this.keyCode = opts.keyCode;
    this.which = opts.which;
    this.shiftKey = opts.shiftKey === true;
    this.ctrlKey = opts.ctrlKey === true;
    this.metaKey = opts.metaKey === true;
    this.altKey = opts.altKey === true;
    this.bubbles = opts.bubbles === true;
    this.cancelable = opts.cancelable === true;
    this.composed = opts.composed === true;
    this.isComposing = false;
    this.defaultPrevented = false;
    this.propagationStopped = false;
    this.immediateStopped = false;
    this.target = null;
  }

  preventDefault() {
    if (this.cancelable) this.defaultPrevented = true;
  }

  stopPropagation() {
    this.propagationStopped = true;
  }

  stopImmediatePropagation() {
    this.propagationStopped = true;
    this.immediateStopped = true;
  }
}

const documentElement = new FakeElement('html');
const head = new FakeElement('head');
const body = new FakeElement('body');
documentElement.appendChild(head);
documentElement.appendChild(body);
documentElement.lang = 'zh-CN';
allElements.push(documentElement, head, body);

const document = {
  documentElement,
  head,
  body,
  activeElement: body,
  createElement(tagName) {
    const element = new FakeElement(tagName);
    allElements.push(element);
    return element;
  },
  querySelector(selector) {
    for (const element of allElements) {
      if (element.isConnected() && matchesSelector(element, selector)) return element;
    }
    return null;
  },
  querySelectorAll(selector) {
    return allElements.filter((element) => element.isConnected() && matchesSelector(element, selector));
  },
  addEventListener() {},
  removeEventListener() {},
};

const windowListeners = [];
const window = {
  addEventListener(type, handler, capture) {
    windowListeners.push({ type, handler, capture: capture === true });
  },
  removeEventListener(type, handler) {
    const index = windowListeners.findIndex((entry) => entry.type === type && entry.handler === handler);
    if (index >= 0) windowListeners.splice(index, 1);
  },
  __ModuleLoader__: undefined,
};

function dispatchFrom(target, event) {
  for (const entry of windowListeners.slice()) {
    if (entry.capture !== true) continue;
    if (event.immediateStopped === true) return;
    entry.handler(event);
  }
  for (const entry of target.listeners.slice()) {
    if (event.immediateStopped === true) return;
    entry.handler(event);
  }
}

function fireKeyDown(target, init) {
  const event = new FakeKeyboardEvent('keydown', init);
  event.target = target;
  dispatchFrom(target, event);
  return event;
}

const reactStub = {
  createElement(type, props) {
    const children = Array.prototype.slice.call(arguments, 2);
    return { type, props: props === null || props === undefined ? {} : props, children };
  },
  Fragment: 'Fragment',
  useCallback: (fn) => fn,
  useEffect: () => {},
  useMemo: (fn) => fn(),
  useRef: (value) => ({ current: value }),
  useState: (value) => [value, () => {}],
};

/* ---------------------------------------------------------------- run bundle */

let manifest = null;
let factory = null;

window.__ModuleLoader__ = {
  load(spec) {
    manifest = spec;
    factory = spec.factory;
  },
};

const sandbox = {
  window,
  document,
  KeyboardEvent: FakeKeyboardEvent,
  Element: FakeElement,
  console,
};

vm.runInNewContext(CLIENT_SOURCE, sandbox, { filename: 'client.js' });

check('client.js 必须调用 window.__ModuleLoader__.load', manifest !== null);
assertEqual('load id 必须等于 package.json name', manifest === null ? null : manifest.id, PACKAGE.name);
check('factory 必须是函数', typeof factory === 'function');

const plugin = typeof factory === 'function' ? factory((name) => {
  if (name === 'react') return reactStub;
  throw new Error('harness: unexpected require(' + name + ')');
}) : null;

check('factory 必须返回插件对象', plugin !== null && typeof plugin === 'object');
check('插件必须声明 inject', Array.isArray(plugin === null ? null : plugin.inject));
check('插件必须暴露 apply', typeof (plugin === null ? null : plugin.apply) === 'function');

/* ------------------------------------------------------------------- apply */

const cleanups = [];
const registered = [];

const ctx = {
  effect(effect) {
    const cleanup = effect();
    if (typeof cleanup === 'function') cleanups.push(cleanup);
    return cleanup;
  },
  slots: {
    inject(name, register) {
      return register();
    },
    register(spec, component) {
      registered.push({ spec, component });
      return () => {};
    },
  },
};

if (plugin !== null && typeof plugin.apply === 'function') plugin.apply(ctx);

/* --- hint text ---------------------------------------------------------- */

const styleTag = document.querySelector('style[data-plugin-css="dsh-no-enter-send"]');
check('必须注入样式表', styleTag !== null);
const css = styleTag === null ? '' : styleTag.textContent;
check('样式必须包含输入框提示', css.indexOf('Enter 换行') >= 0, css.slice(0, 120));
check('提示必须挂在占位符节点上', css.indexOf('[data-composer-placeholder]::after') >= 0);
check('样式必须禁用指针事件', css.indexOf('pointer-events: none') >= 0);
/* The shell ships lang="en" and switches to zh-CN later, so the suffix cannot be
   frozen at load time; both languages must be present as :lang() rules. */
check('占位符提示必须按语言分别声明', css.indexOf('[data-composer-placeholder]:lang(zh)::after') >= 0);
check('占位符英文提示必须内置', css.indexOf('Enter = new line') >= 0);
check('占位符中文提示必须内置', css.indexOf('Enter 换行') >= 0);
/* The pill must advertise Enter-to-send and light up on hover, both in CSS. */
check('军械态必须由 :has() 驱动', css.indexOf(':has(button[aria-busy]:not([aria-haspopup]):not(:disabled):hover)') >= 0);
check('军械态必须有实心底色', css.indexOf('var(--dsw-alias-button-info-fill') >= 0);

assertEqual('必须注册一个输入框控件', registered.length, 1);
const caption = registered.length === 0 ? null : registered[0];
assertEqual('注册槽位', caption === null ? null : caption.spec.name, 'conversation.input.right');
const rendered = caption === null ? null : caption.component();
assertEqual('提示文案', rendered === null ? null : rendered.children[0], 'Enter发送');
assertEqual('提示类名', rendered === null ? null : rendered.props.className, 'dsnes-hint');

check('必须暴露调试句柄', typeof window.__dshNoEnterSend === 'object' && window.__dshNoEnterSend !== null);
assertEqual('调试句柄版本', window.__dshNoEnterSend === undefined ? null : window.__dshNoEnterSend.version, 2);

/* --- composer fixture ---------------------------------------------------- */

function createComposer() {
  const card = document.createElement('div');
  card.setAttribute('data-composer-card', '');
  const input = document.createElement('div');
  input.setAttribute('data-composer-input', '');
  input.__lexicalEditor = {};
  card.appendChild(input);
  /* The real send button: a <button> with aria-busy and no popup role. */
  const send = document.createElement('button');
  send.setAttribute('type', 'button');
  send.setAttribute('aria-busy', 'false');
  card.appendChild(send);
  /* A decoy that must never be mistaken for the send button. */
  const popup = document.createElement('button');
  popup.setAttribute('type', 'button');
  popup.setAttribute('aria-busy', 'false');
  popup.setAttribute('aria-haspopup', 'menu');
  card.appendChild(popup);
  body.appendChild(card);
  const counts = { sends: 0, breaks: 0 };
  /* Stand-in for the composer's own keymap: a plain Enter submits, a
     Shift+Enter inserts a line break. A handler that never runs proves the
     key press was intercepted before it reached the editor. */
  input.addEventListener('keydown', (event) => {
    if (event.defaultPrevented === true) return;
    if (event.shiftKey === true) counts.breaks += 1;
    else counts.sends += 1;
  });
  return { card, input, send, popup, counts };
}

/* --- Enter is a line break, never a send -------------------------------- */

{
  const { input, counts } = createComposer();
  const event = fireKeyDown(input, { key: 'Enter', code: 'Enter', keyCode: 13, cancelable: true });
  assertEqual('Enter 必须被 preventDefault', event.defaultPrevented, true);
  assertEqual('Enter 必须阻断后续监听', event.immediateStopped, true);
  assertEqual('Enter 不能触发送', counts.sends, 0);
  assertEqual('Enter 必须变成换行', counts.breaks, 1);
  const replay = input.dispatched.filter((item) => item.type === 'keydown');
  assertEqual('必须重放一次按键', replay.length, 1);
  assertEqual('重放必须是 Shift+Enter', replay[0] === undefined ? null : replay[0].shiftKey, true);
}

/* --- bounded modifiers: blocked as a send, no extra line break --------- */

{
  const { input, counts } = createComposer();
  const event = fireKeyDown(input, { key: 'Enter', code: 'Enter', keyCode: 13, ctrlKey: true, cancelable: true });
  assertEqual('Ctrl+Enter 必须被拦截', event.defaultPrevented, true);
  assertEqual('Ctrl+Enter 不能触发送', counts.sends, 0);
  assertEqual('Ctrl+Enter 不插入换行', counts.breaks, 0);
}

/* --- typing gestures and open menus pass through ----------------------- */

{
  const { input, counts } = createComposer();
  const composing = new FakeKeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, cancelable: true });
  composing.isComposing = true;
  composing.target = input;
  dispatchFrom(input, composing);
  assertEqual('输入法组字中的 Enter 必须放行', composing.defaultPrevented, false);
  assertEqual('组字中的 Enter 不能被当作换行', counts.breaks, 0);

  const menu = document.createElement('div');
  menu.setAttribute('data-trigger-menu', '');
  body.appendChild(menu);
  const withMenu = fireKeyDown(input, { key: 'Enter', code: 'Enter', keyCode: 13, cancelable: true });
  assertEqual('命令菜单打开时 Enter 必须放行', withMenu.defaultPrevented, false);
  body.removeChild(menu);
}

/* --- hover on the send button hands Enter back to the composer ---------- */

{
  const { input, send, counts } = createComposer();
  send.__hover = true;
  assertEqual('悬停时调试句柄必须报告已武装', window.__dshNoEnterSend.hover(), true);
  const event = fireKeyDown(input, { key: 'Enter', code: 'Enter', keyCode: 13, cancelable: true });
  assertEqual('悬停发送按钮时 Enter 不能被打断', event.defaultPrevented, false);
  assertEqual('悬停发送按钮时 Enter 必须触发送', counts.sends, 1);
  assertEqual('悬停发送按钮时 Enter 不能重放换行', input.dispatched.length, 0);
  assertEqual('悬停发送按钮时不产生换行', counts.breaks, 0);
  send.__hover = false;
  assertEqual('移开后必须解除武装', window.__dshNoEnterSend.hover(), false);
  const after = fireKeyDown(input, { key: 'Enter', code: 'Enter', keyCode: 13, cancelable: true });
  assertEqual('移开后 Enter 必须恢复拦截', after.defaultPrevented, true);
  assertEqual('移开后 Enter 必须变回换行', counts.sends, 1);
  assertEqual('移开后换行数加一', counts.breaks, 1);
}

/* --- a disabled send button never arms --------------------------------- */

{
  const { input, send, counts } = createComposer();
  send.disabled = true;
  send.__hover = true;
  assertEqual('禁用按钮悬停不得武装', window.__dshNoEnterSend.hover(), false);
  const event = fireKeyDown(input, { key: 'Enter', code: 'Enter', keyCode: 13, cancelable: true });
  assertEqual('禁用按钮悬停时 Enter 必须被拦截', event.defaultPrevented, true);
  assertEqual('禁用按钮悬停时不能发送', counts.sends, 0);
  assertEqual('禁用按钮悬停时必须换行', counts.breaks, 1);
}

/* --- only the real send button arms, not popup triggers ---------------- */

{
  const { input, popup, counts } = createComposer();
  popup.__hover = true;
  assertEqual('弹出菜单按钮不得被当成发送按钮', window.__dshNoEnterSend.hover(), false);
  const event = fireKeyDown(input, { key: 'Enter', code: 'Enter', keyCode: 13, cancelable: true });
  assertEqual('弹出菜单按钮悬停时 Enter 必须被拦截', event.defaultPrevented, true);
  assertEqual('弹出菜单按钮悬停时不能发送', counts.sends, 0);
  assertEqual('弹出菜单按钮悬停时必须换行', counts.breaks, 1);
}

/* --- armed composer still honours Shift+Enter as a break --------------- */

{
  const { input, send, counts } = createComposer();
  send.__hover = true;
  const event = fireKeyDown(input, { key: 'Enter', code: 'Enter', keyCode: 13, shiftKey: true, cancelable: true });
  assertEqual('武装态下 Shift+Enter 必须放行', event.defaultPrevented, false);
  assertEqual('武装态下 Shift+Enter 必须换行', counts.breaks, 1);
  assertEqual('武装态下 Shift+Enter 不能发送', counts.sends, 0);
}

/* --- an open slash menu outranks the armed state ----------------------- */

{
  const { input, send } = createComposer();
  send.__hover = true;
  const menu = document.createElement('div');
  menu.setAttribute('data-trigger-menu', '');
  body.appendChild(menu);
  const event = fireKeyDown(input, { key: 'Enter', code: 'Enter', keyCode: 13, cancelable: true });
  assertEqual('菜单打开时即使悬停也必须放行给菜单', event.defaultPrevented, false);
  assertEqual('菜单打开时不得重放换行', input.dispatched.length, 0);
  body.removeChild(menu);
}

/* --- Enter outside the composer keeps native behaviour ------------------ */

{
  const { input } = createComposer();
  const dialogInput = document.createElement('input');
  body.appendChild(dialogInput);
  const event = fireKeyDown(dialogInput, { key: 'Enter', code: 'Enter', keyCode: 13, cancelable: true });
  assertEqual('输入框之外的 Enter 必须放行', event.defaultPrevented, false);
  assertEqual('输入框之外的 Enter 不能重放', dialogInput.dispatched.length, 0);
  check('composer fixture 仍然存在', input.isConnected());
}

/* --- focus fallback: window-level Enter with no useful target ---------- */

{
  const { input, counts } = createComposer();
  document.activeElement = input;
  const event = fireKeyDown(body, { key: 'Enter', code: 'Enter', keyCode: 13, cancelable: true });
  assertEqual('焦点兜底必须拦截', event.defaultPrevented, true);
  assertEqual('焦点兜底必须插入换行', counts.breaks, 1);
  document.activeElement = body;
}

/* --- language switch --------------------------------------------------- */

{
  documentElement.lang = 'en-US';
  check('英文环境提示必须切换', window.__dshNoEnterSend.hint() === 'Enter to send');
  check('英文环境换行提示必须切换', window.__dshNoEnterSend.newline() === 'Enter = new line');
  documentElement.lang = 'zh-CN';
  check('中文环境提示必须保持', window.__dshNoEnterSend.hint() === 'Enter发送');
  check('中文环境换行提示必须保持', window.__dshNoEnterSend.newline() === 'Enter 换行');
}

/* --- teardown ---------------------------------------------------------- */

{
  for (const cleanup of cleanups) cleanup();
  assertEqual('卸载必须移除样式表', document.querySelector('style[data-plugin-css="dsh-no-enter-send"]'), null);
  const { input } = createComposer();
  const event = fireKeyDown(input, { key: 'Enter', code: 'Enter', keyCode: 13, cancelable: true });
  assertEqual('卸载后 Enter 必须恢复原状', event.defaultPrevented, false);
}

/* ------------------------------------------------------------------ report */

const total = passed + failures.length;
if (failures.length > 0) {
  console.error('FAIL ' + failures.length + '/' + total);
  for (const failure of failures) console.error('  ✗ ' + failure);
  process.exit(1);
}
console.log('PASS ' + total + '/' + total);
