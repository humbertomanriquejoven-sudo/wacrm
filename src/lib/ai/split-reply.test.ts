import { describe, it, expect } from 'vitest'
import { splitAiReply, MAX_AI_REPLY_MESSAGES } from './split-reply'

describe('splitAiReply', () => {
  it('returns nothing for empty / whitespace input', () => {
    expect(splitAiReply('')).toEqual([])
    expect(splitAiReply('   \n\n  ')).toEqual([])
  })

  it('keeps a single paragraph as one message', () => {
    expect(splitAiReply('Hola, ¿en qué puedo ayudarte?')).toEqual([
      'Hola, ¿en qué puedo ayudarte?',
    ])
  })

  it('splits each paragraph into its own bubble up to the cap', () => {
    const out = splitAiReply('Primero\n\nSegundo\n\nTercero')
    expect(out).toEqual(['Primero', 'Segundo', 'Tercero'])
  })

  it('merges anything beyond 3 paragraphs into the final message', () => {
    const out = splitAiReply('A\n\nB\n\nC\n\nD')
    expect(out).toHaveLength(3)
    expect(out[0]).toBe('A')
    expect(out[1]).toBe('B')
    expect(out[2]).toBe('C\n\nD')
  })

  it('keeps a 4-fragment ceiling regardless of paragraph count', () => {
    const out = splitAiReply('A\n\nB\n\nC\n\nD\n\nE\n\nF')
    expect(out).toHaveLength(MAX_AI_REPLY_MESSAGES)
    expect(out).toEqual(['A', 'B', 'C\n\nD\n\nE\n\nF'])
  })

  it('normalizes CRLF and collapses extra blank lines', () => {
    expect(splitAiReply('uno\r\n\r\ndos')).toEqual(['uno', 'dos'])
    expect(splitAiReply('uno\n\n\n\ndos')).toEqual(['uno', 'dos'])
  })
})