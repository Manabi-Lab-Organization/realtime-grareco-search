import { describe, expect, it, vi } from 'vitest';
import { headerToggleClick, shouldToggleFromHeaderClick } from './headerToggle';

class FakeEl {
  constructor(
    public tag: string,
    public parent: FakeEl | null = null,
  ) {}
  closest(selector: string): FakeEl | null {
    const tags = selector.split(',').map((s) => s.trim());
    for (let el: FakeEl | null = this; el; el = el.parent) {
      if (tags.includes(el.tag)) return el;
    }
    return null;
  }
  contains(node: unknown): boolean {
    for (let el = node as FakeEl | null; el; el = el.parent) {
      if (el === this) return true;
    }
    return false;
  }
}

const noSelection = null;
const sel = (node: FakeEl, text: string) => ({
  isCollapsed: text === '',
  anchorNode: node,
  focusNode: node,
  toString: () => text,
});

describe('shouldToggleFromHeaderClick', () => {
  const header = new FakeEl('header');
  const title = new FakeEl('h2', header);
  const copyButton = new FakeEl('button', header);
  const iconInButton = new FakeEl('svg', copyButton);
  const link = new FakeEl('a', header);

  it('見出しの行そのもの・題名の文字を押したら開閉する', () => {
    expect(shouldToggleFromHeaderClick(header, header, noSelection)).toBe(true);
    expect(shouldToggleFromHeaderClick(title, header, noSelection)).toBe(true);
  });

  it('行の中のボタン・リンク（その中のアイコンも）を押したときは開閉しない', () => {
    expect(shouldToggleFromHeaderClick(copyButton, header, noSelection)).toBe(false);
    expect(shouldToggleFromHeaderClick(iconInButton, header, noSelection)).toBe(false);
    expect(shouldToggleFromHeaderClick(link, header, noSelection)).toBe(false);
  });

  it('見出しの行がボタンの中に置かれていても、行の外側のボタンは理由にしない', () => {
    const outerButton = new FakeEl('button');
    const innerHeader = new FakeEl('header', outerButton);
    const innerTitle = new FakeEl('h2', innerHeader);
    expect(shouldToggleFromHeaderClick(innerTitle, innerHeader, noSelection)).toBe(true);
  });

  it('見出しの文字を選択しているときは開閉しない', () => {
    expect(shouldToggleFromHeaderClick(title, header, sel(title, '文字起こし'))).toBe(false);
  });

  it('選択が空、または見出しの外の文字を選択しているだけなら開閉する', () => {
    const elsewhere = new FakeEl('p');
    expect(shouldToggleFromHeaderClick(title, header, sel(title, ''))).toBe(true);
    expect(shouldToggleFromHeaderClick(title, header, sel(title, '   '))).toBe(true);
    expect(shouldToggleFromHeaderClick(title, header, sel(elsewhere, '本文の文字'))).toBe(true);
  });

  it('行の外に描かれた要素（ダイアログなど）の中を押しても開閉しない', () => {
    const dialogBody = new FakeEl('div', new FakeEl('body'));
    expect(shouldToggleFromHeaderClick(dialogBody, header, noSelection)).toBe(false);
  });

  it('押した先が分からないときは開閉しない', () => {
    expect(shouldToggleFromHeaderClick(null, header, noSelection)).toBe(false);
  });
});

describe('headerToggleClick', () => {
  const header = new FakeEl('header');
  const title = new FakeEl('h2', header);
  const button = new FakeEl('button', header);
  const ev = (target: FakeEl) =>
    ({ target, currentTarget: header }) as unknown as {
      target: EventTarget;
      currentTarget: EventTarget;
    };

  it('題名を押すと 1 回だけ開閉する', () => {
    const onToggle = vi.fn();
    headerToggleClick(onToggle)(ev(title));
    expect(onToggle).toHaveBeenCalledTimes(1);
  });

  it('行の中のボタンを押しても開閉しない（ボタン自身の操作に任せる）', () => {
    const onToggle = vi.fn();
    headerToggleClick(onToggle)(ev(button));
    expect(onToggle).not.toHaveBeenCalled();
  });

  it('無効のときは何もしない', () => {
    const onToggle = vi.fn();
    headerToggleClick(onToggle, false)(ev(title));
    expect(onToggle).not.toHaveBeenCalled();
  });
});
