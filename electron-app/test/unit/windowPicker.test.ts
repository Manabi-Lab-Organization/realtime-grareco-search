import { describe, expect, it } from 'vitest'
import { groupWindows, isMeetingWindow, moveSelection, orderedWindows } from '../../src/renderer/src/lib/windowPicker'
import { excludeOwnWindows } from '../../src/main/windowSource'

const zoom = { id: 'window:849:0', name: 'Zoom ミーティング' }
const cal = { id: 'window:124:0', name: 'Google カレンダー - Google Chrome' }
const meet = { id: 'window:300:0', name: 'Meet - abc-defg-hij - Google Chrome' }
const teams = { id: 'window:301:0', name: '定例 | Microsoft Teams' }
const memo = { id: 'window:302:0', name: 'メモ' }

describe('isMeetingWindow', () => {
  it('会議アプリの題名を見分ける', () => {
    for (const w of [zoom, meet, teams]) expect(isMeetingWindow(w.name)).toBe(true)
    expect(isMeetingWindow('Webex Meetings')).toBe(true)
  })
  it('会議アプリでない題名は拾わない', () => {
    expect(isMeetingWindow(cal.name)).toBe(false)
    expect(isMeetingWindow(memo.name)).toBe(false)
    expect(isMeetingWindow('Steamships.pdf')).toBe(false)
  })
})

describe('groupWindows / orderedWindows', () => {
  it('会議アプリを先頭にまとめ、それぞれの中の順は変えない', () => {
    const g = groupWindows([cal, zoom, memo, meet])
    expect(g.meeting).toEqual([zoom, meet])
    expect(g.others).toEqual([cal, memo])
    expect(orderedWindows([cal, zoom, memo, meet])).toEqual([zoom, meet, cal, memo])
  })
})

describe('moveSelection', () => {
  const list = [zoom, meet, cal]
  it('上下キーで隣へ動き、端では止まる', () => {
    expect(moveSelection(list, zoom.id, 1)).toBe(meet.id)
    expect(moveSelection(list, zoom.id, -1)).toBe(zoom.id)
    expect(moveSelection(list, cal.id, 1)).toBe(cal.id)
  })
  it('未選択・一覧に無い id のときは、下で先頭・上で末尾', () => {
    expect(moveSelection(list, '', 1)).toBe(zoom.id)
    expect(moveSelection(list, 'window:999:0', -1)).toBe(cal.id)
  })
  it('一覧が空なら何も選ばない', () => {
    expect(moveSelection([], zoom.id, 1)).toBe('')
  })
})

describe('excludeOwnWindows', () => {
  it('このアプリ自身のウィンドウを一覧から外す（末尾の番号が違っても同じ窓とみなす）', () => {
    const own = { id: 'window:500:0', name: 'Realtime GraReco & Search' }
    expect(excludeOwnWindows([own, zoom, cal], ['window:500:1'])).toEqual([zoom, cal])
  })
  it('自分の窓の id が取れないときは、何も外さない', () => {
    expect(excludeOwnWindows([zoom, cal], [])).toEqual([zoom, cal])
    expect(excludeOwnWindows([zoom, cal], [''])).toEqual([zoom, cal])
  })
})
