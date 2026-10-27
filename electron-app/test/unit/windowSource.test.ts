import { describe, expect, it } from 'vitest'
import { findWindowSource, withTimeout } from '../../src/main/windowSource'

describe('findWindowSource', () => {
  const editor = { id: 'window:10:0', name: 'メモ帳' }
  const slidesA = { id: 'window:20:0', name: '発表資料' }
  const slidesB = { id: 'window:21:0', name: '発表資料' }

  it('同じ id のウィンドウを選ぶ', () => {
    expect(findWindowSource([slidesA, editor], editor.id, editor.name)).toBe(editor)
  })

  it('一覧に無ければ何も選ばない', () => {
    expect(findWindowSource([slidesA], editor.id, editor.name)).toBeUndefined()
  })

  it('一覧に戻ってくれば再び選べる', () => {
    const list = [slidesA]
    expect(findWindowSource(list, editor.id, editor.name)).toBeUndefined()
    list.push(editor)
    expect(findWindowSource(list, editor.id, editor.name)).toBe(editor)
  })

  it('id が違っても名前が一つだけ合えばそれを選ぶ', () => {
    const renewed = { id: 'window:99:0', name: editor.name }
    expect(findWindowSource([slidesA, renewed], editor.id, editor.name)).toBe(renewed)
  })

  it('同じ名前が複数あるときは名前では選ばない', () => {
    expect(findWindowSource([slidesA, slidesB], 'window:1:0', '発表資料')).toBeUndefined()
  })
})

describe('withTimeout', () => {
  it('期限内に終わった結果をそのまま返す', async () => {
    await expect(withTimeout(Promise.resolve('ok'), 50)).resolves.toBe('ok')
  })

  it('期限を過ぎたら指定した名前で失敗にする', async () => {
    await expect(withTimeout(new Promise(() => {}), 10, 'capture_timeout')).rejects.toThrow('capture_timeout')
  })
})
