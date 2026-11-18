/**
 * dsh-no-enter-send — Enter cannot send... unless the pointer rests on the send
 * button. Hover that button and Enter is handed back to the composer's own
 * keymap, which sends (or queues, or steers) exactly as it does with this
 * plugin absent; everywhere else Enter is turned into a line break.
 *
 * Why a capture-phase window listener: the composer's Lexical editor handles
 * KEY_ENTER_COMMAND on the contenteditable root (bubble phase) and the shell's
 * shortcut service listens further up. A capture listener on window runs before
 * both, so preventDefault() + stopImmediatePropagation() removes every keyboard
 * send path in one place instead of chasing each handler.
 *
 * Blocked Enter is replayed as Shift+Enter, which this composer treats as a line
 * break, so the key keeps its "new line" meaning. A synthetic flag stops the
 * replayed event from being intercepted a second time.
 *
 * Hover is read at keydown time (`matches(':hover')`) rather than tracked with
 * listeners: no state to keep in sync, nothing to clean up, and the answer is
 * always the pointer's real position at the instant of the key press.
 *
 * Two hint surfaces that never fight for space and never lie:
 *   - the ghost suffix on the composer's own placeholder line, which speaks for
 *     the inside of the box and therefore says what Enter does there (new line);
 *   - the pill in the toolbar next to the send button, which advertises the
 *     Enter-to-send affordance and lights up solid the moment it is armed.
 */
window.__ModuleLoader__.load({
  id: 'dsh-no-enter-send',
  factory(require) {
    'use strict';

    const { createElement: h } = require('react');
    const STYLE_ID = 'dsh-no-enter-send';
    const HINT_ZH = 'Enter发送';
    const HINT_EN = 'Enter to send';
    const NEWLINE_ZH = 'Enter 换行';
    const NEWLINE_EN = 'Enter = new line';
    const HINT_CLASS = 'dsnes-hint';

    /*
     * The send button is the only element inside the composer card that is a
     * <button> carrying aria-busy without a popup role. Checked against the
     * shipped composer: the model chip has aria-haspopup="menu", the attachment
     * thumbnail has no aria-busy, the "+" button has aria-haspopup="listbox",
     * and the stop button reuses the send button's class but never sets
     * aria-busy. CSS module class names are hashed and must not be used.
     */
    const SEND_SELECTOR = '[data-composer-card] button[aria-busy]:not([aria-haspopup])';

    const state = { synthetic: false };

    function documentLanguage() {
      if (typeof document === 'undefined' || document === null) return '';
      const root = document.documentElement;
      if (root === undefined || root === null || typeof root.lang !== 'string') return '';
      return root.lang.toLowerCase();
    }

    function isEnglish() {
      return documentLanguage().indexOf('en') === 0;
    }

    function hintText() {
      return isEnglish() ? HINT_EN : HINT_ZH;
    }

    function newlineText() {
      return isEnglish() ? NEWLINE_EN : NEWLINE_ZH;
    }

    function quote(value) {
      return String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    }

    /**
     * Both surfaces are declared as two `:lang()` rules per text instead of one
     * string built at load time. The shell serves its HTML with lang="en" and
     * only switches documentElement.lang to zh-CN once the locale module
     * materialises, which can land after this stylesheet is installed; reading
     * the language once would freeze the wrong text into the CSS. Delegating to
     * `:lang()` lets the browser re-evaluate it whenever the attribute changes,
     * and keeps every hint surface in the same language at all times.
     *
     * The armed state is pure CSS (`:has()` over the hovering button) so the pill
     * can brighten without React re-rendering the slot, and so it matches the
     * keydown check — which also refuses to arm on a disabled button.
     */
    function cssText() {
      return [
        '/* Ghost suffix on the placeholder: what Enter does inside the box. */',
        '[data-composer-placeholder]::after {',
        '  content: " · ' + quote(NEWLINE_EN) + '";',
        '  color: inherit;',
        '  pointer-events: none;',
        '}',
        '[data-composer-placeholder]:lang(zh)::after {',
        '  content: " · ' + quote(NEWLINE_ZH) + '";',
        '}',
        '',
        '/* Toolbar pill next to the send button: the Enter-to-send affordance. */',
        '.' + HINT_CLASS + ' {',
        '  display: inline-flex;',
        '  align-items: center;',
        '  font-family: var(--dsw-font-family);',
        '  font-size: 12px;',
        '  font-weight: 500;',
        '  line-height: 18px;',
        '  letter-spacing: 0.01em;',
        '  white-space: nowrap;',
        '  user-select: none;',
        '  pointer-events: none;',
        '  padding: 0 8px;',
        '  border-radius: 999px;',
        '  color: var(--dsw-alias-button-info-fill, #3964fe);',
        '  background: rgba(57, 100, 254, 0.12);',
        '  background: color-mix(in srgb, var(--dsw-alias-button-info-fill, #3964fe) 14%, transparent);',
        '  transition: background-color 120ms ease, color 120ms ease, box-shadow 120ms ease;',
        '}',
        '',
        '/* Armed: the pointer is on an enabled send button, so Enter really sends. */',
        '[data-composer-card]:has(button[aria-busy]:not([aria-haspopup]):not(:disabled):hover) .' + HINT_CLASS + ' {',
        '  color: var(--dsw-alias-label-on-color, #ffffff);',
        '  background: var(--dsw-alias-button-info-fill, #3964fe);',
        '  box-shadow: 0 0 0 3px rgba(57, 100, 254, 0.26);',
        '  box-shadow: 0 0 0 3px color-mix(in srgb, var(--dsw-alias-button-info-fill, #3964fe) 26%, transparent);',
        '}',
        '',
        '@media (prefers-reduced-motion: no-preference) {',
        '  [data-composer-card]:has(button[aria-busy]:not([aria-haspopup]):not(:disabled):hover) .' + HINT_CLASS + ' {',
        '    animation: dsnes-pop 160ms ease-out;',
        '  }',
        '}',
        '@keyframes dsnes-pop {',
        '  from { transform: scale(0.94); }',
        '  to { transform: scale(1); }',
        '}',
      ].join('\n');
    }

    function headOf() {
      if (typeof document === 'undefined' || document === null) return null;
      const head = document.head;
      return head === undefined || head === null ? null : head;
    }

    function ensureStyles() {
      const head = headOf();
      if (head === null) return function noop() {};
      const selector = 'style[data-plugin-css="' + STYLE_ID + '"]';
      const existing = document.querySelector(selector);
      if (existing !== null && existing !== undefined) {
        existing.textContent = cssText();
        return function noop() {};
      }
      const tag = document.createElement('style');
      tag.setAttribute('data-plugin-css', STYLE_ID);
      tag.textContent = cssText();
      head.appendChild(tag);
      return function removeStyles() {
        const parent = tag.parentElement;
        if (parent !== null && parent !== undefined) parent.removeChild(tag);
      };
    }

    function elementOf(node) {
      if (node === undefined || node === null) return null;
      if (typeof node.closest === 'function') return node;
      if (node.nodeType === 1) return node;
      if (node.nodeType === 3) {
        const parent = node.parentElement;
        return parent === undefined || parent === null ? null : parent;
      }
      const root = node.documentElement;
      return root === undefined || root === null ? null : root;
    }

    function activeInput() {
      if (typeof document === 'undefined' || document === null) return null;
      const active = elementOf(document.activeElement);
      if (active === null) return null;
      const input = active.closest('[data-composer-input]');
      return input === undefined ? null : input;
    }

    /**
     * The text field that owns this event, or null when this Enter belongs to
     * something else (a rename box, a dialog, a button). Only the editor region
     * is intercepted, so controls around the composer keep normal keyboard
     * behaviour. A window-level Enter with no meaningful target resolves through
     * the focused element instead, which covers focus parked on the card.
     */
    function composerInput(node) {
      const element = elementOf(node);
      if (element === null) return null;
      const direct = element.closest('[data-composer-input]');
      if (direct !== null && direct !== undefined) return direct;
      const bare = typeof document !== 'undefined' && document !== null
        && (element === document.body || element === document.documentElement || element === document);
      return bare === true ? activeInput() : null;
    }

    function isTypingGesture(event) {
      return event.isComposing === true || event.keyCode === 229;
    }

    function isEnterGesture(event) {
      const key = typeof event.key === 'string' ? event.key : '';
      const code = typeof event.code === 'string' ? event.code : '';
      return key === 'Enter' || key === 'Return' || code === 'Enter'
        || code === 'NumpadEnter' || event.keyCode === 13;
    }

    function triggerMenuOpen() {
      if (typeof document === 'undefined' || document === null) return false;
      return document.querySelector('[data-trigger-menu]') !== null;
    }

    /** The composer's send button, or null when this panel has none. */
    function sendButton() {
      if (typeof document === 'undefined' || document === null) return null;
      const found = document.querySelectorAll(SEND_SELECTOR);
      if (found === undefined || found === null || found.length === 0) return null;
      return found[found.length - 1];
    }

    /**
     * True only while the pointer really rests on an enabled send button. A
     * disabled button (empty draft, upload pending, session busy) never arms, so
     * Enter keeps producing a line break instead of pretending to send.
     */
    function hoverSends() {
      const button = sendButton();
      if (button === null || button === undefined) return false;
      if (button.disabled === true) return false;
      if (button.getAttribute('aria-disabled') === 'true') return false;
      try {
        return button.matches(':hover') === true;
      } catch (error) {
        return false;
      }
    }

    /**
     * Insert a line break by replaying the gesture the composer maps to one.
     * Shift+Enter reaches Lexical's KEY_ENTER_COMMAND handler, which declines it
     * and lets the break be inserted as a line-break node.
     */
    function insertLineBreak(root) {
      if (root === null || root === undefined) return false;
      if (root.__lexicalEditor === undefined) {
        try {
          if (typeof document.execCommand === 'function' && document.execCommand('insertLineBreak') === true) return true;
        } catch (error) {
          /* fall through to the synthetic key */
        }
      }
      if (typeof KeyboardEvent !== 'function') return false;
      state.synthetic = true;
      try {
        const replay = new KeyboardEvent('keydown', {
          key: 'Enter',
          code: 'Enter',
          keyCode: 13,
          which: 13,
          shiftKey: true,
          bubbles: true,
          cancelable: true,
          composed: true,
        });
        root.dispatchEvent(replay);
      } catch (error) {
        return false;
      } finally {
        state.synthetic = false;
      }
      return true;
    }

    function onKeyDownCapture(event) {
      if (state.synthetic === true) return;
      if (event === undefined || event === null) return;
      if (event.defaultPrevented === true) return;
      if (isTypingGesture(event) === true) return;
      if (isEnterGesture(event) !== true) return;
      const input = composerInput(event.target);
      if (input === null) return;
      /* A slash / @ / command menu owns Enter while it is open. */
      if (triggerMenuOpen() === true) return;
      /*
       * Armed: leave the event untouched so the composer's own keymap runs —
       * it sends, queues or steers the draft, honours Shift+Enter as a break,
       * swallows auto-repeat, and refuses to submit while it is busy.
       */
      if (hoverSends() === true) return;
      if (typeof event.preventDefault === 'function') event.preventDefault();
      if (typeof event.stopImmediatePropagation === 'function') event.stopImmediatePropagation();
      else if (typeof event.stopPropagation === 'function') event.stopPropagation();
      /* Ctrl/Cmd/Alt+Enter is a shortcut, not typing: swallow it, add nothing. */
      if (event.ctrlKey === true || event.metaKey === true || event.altKey === true) return;
      insertLineBreak(input);
    }

    function HintCaption() {
      return h('span', { className: HINT_CLASS, 'aria-hidden': 'true' }, hintText());
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.effect(function stylesEffect() {
          return ensureStyles();
        }, 'dsh-no-enter-send: styles');

        ctx.effect(function enterEffect() {
          if (typeof window === 'undefined' || window === null) return function noop() {};
          window.addEventListener('keydown', onKeyDownCapture, true);
          return function removeEnterListener() {
            window.removeEventListener('keydown', onKeyDownCapture, true);
          };
        }, 'dsh-no-enter-send: enter');

        ctx.slots.inject('conversation.input.right', function registerHint() {
          return ctx.slots.register({
            name: 'conversation.input.right',
            id: 'no-enter-hint',
            order: 5,
          }, HintCaption);
        });

        if (typeof window !== 'undefined' && window !== null) {
          window.__dshNoEnterSend = {
            version: 2,
            hint: hintText,
            newline: newlineText,
            hover: hoverSends,
            button: sendButton,
            isEnter: isEnterGesture,
            css: cssText,
          };
        }
      },
    };
  },
});
