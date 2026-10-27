import { describe, expect, it } from 'vitest'
import { parseObservationSource } from '../../src/renderer/src/lib/observationSource'

describe('parseObservationSource', () => {
  it('保存された入力元を三種類とも読み戻す', () => {
    expect(parseObservationSource('camera')).toBe('camera')
    expect(parseObservationSource('window')).toBe('window')
    expect(parseObservationSource('display')).toBe('display')
  })

  it('保存が無いときや想定外の値はカメラにする', () => {
    expect(parseObservationSource(null)).toBe('camera')
    expect(parseObservationSource('')).toBe('camera')
    expect(parseObservationSource('unknown')).toBe('camera')
  })
})
