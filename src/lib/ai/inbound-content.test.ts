import { describe, it, expect } from 'vitest';
import {
  AI_CONTEXT_CONTENT_TYPES,
  describeInboundContent,
  isOpaqueToModel,
  normalizeContentType,
} from './inbound-content';

// The contract: no inbound type may resolve to nothing, and no type may be
// invisible to the model. Before this module a sticker, an uncaptioned photo or
// a shared contact produced an empty turn and the auto-reply gate skipped the
// whole message.

describe('normalizeContentType', () => {
  it('keeps the types the messages CHECK already allows', () => {
    for (const t of [
      'text',
      'image',
      'video',
      'audio',
      'document',
      'location',
      'template',
      'interactive',
    ]) {
      expect(normalizeContentType(t)).toBe(t);
    }
  });

  it('folds WhatsApp types that have no stored equivalent', () => {
    expect(normalizeContentType('sticker')).toBe('image');
    expect(normalizeContentType('animation')).toBe('image');
    expect(normalizeContentType('voice')).toBe('audio');
    expect(normalizeContentType('button')).toBe('interactive');
    expect(normalizeContentType('interactive_reply')).toBe('interactive');
    expect(normalizeContentType('poll')).toBe('interactive');
    expect(normalizeContentType('poll_response')).toBe('interactive');
    expect(normalizeContentType('order')).toBe('interactive');
  });

  it('never stores a type outside the messages CHECK', () => {
    // `contacts` and `reaction` are not valid stored values; folding them to
    // `text` keeps the INSERT from failing on a real database.
    expect(normalizeContentType('contacts')).toBe('text');
    expect(normalizeContentType('reaction')).toBe('text');
    expect(normalizeContentType('contacts_shared')).toBe('text');
    expect(normalizeContentType('ephemeral')).toBe('text');
    expect(normalizeContentType('something_meta_ships_next_year')).toBe('text');
    expect(normalizeContentType('')).toBe('text');
    expect(normalizeContentType(undefined)).toBe('text');
    expect(normalizeContentType(null)).toBe('text');
  });

  it('only ever emits a content_type the schema accepts', () => {
    const allowed = new Set<string>(AI_CONTEXT_CONTENT_TYPES);
    for (const raw of [
      'sticker',
      'animation',
      'contacts',
      'reaction',
      'poll',
      'poll_response',
      'order',
      'ephemeral',
      'unknown_future_type',
    ]) {
      expect(allowed.has(normalizeContentType(raw))).toBe(true);
    }
  });
});

describe('describeInboundContent', () => {
  it('names every type the agent can receive', () => {
    const expected: Array<[string, string]> = [
      ['image', '[El usuario envió una foto]'],
      ['video', '[El usuario envió un video]'],
      ['audio', '[El usuario envió un mensaje de voz]'],
      ['document', '[El usuario envió un documento]'],
      ['location', '[El usuario compartió su ubicación]'],
      ['contacts', '[El usuario compartió un contacto]'],
      ['interactive', '[El usuario seleccionó una opción]'],
      ['template', '[El usuario interactuó con una plantilla]'],
    ];
    for (const [contentType, phrase] of expected) {
      expect(describeInboundContent({ contentType })).toBe(phrase);
    }
  });

  it('falls back to a generic sentence for anything unknown', () => {
    expect(describeInboundContent({ contentType: 'wat' })).toBe(
      '[El usuario envió un mensaje de texto]',
    );
  });

  it('prefers real extracted content over the placeholder', () => {
    // A captioned photo, a transcription, a list_reply title, a filename and a
    // formatted location all beat the generic sentence.
    expect(
      describeInboundContent({ contentType: 'image', contentText: 'mi recibo' }),
    ).toBe('mi recibo');
    expect(
      describeInboundContent({
        contentType: 'audio',
        contentText: 'quiero agendar',
      }),
    ).toBe('quiero agendar');
    expect(
      describeInboundContent({
        contentType: 'document',
        contentText: 'contrato.pdf',
      }),
    ).toBe('contrato.pdf');
  });

  it('treats whitespace-only text as no text', () => {
    expect(describeInboundContent({ contentType: 'image', contentText: '   ' })).toBe(
      '[El usuario envió una foto]',
    );
  });
});

describe('isOpaqueToModel', () => {
  it('knows when the agent cannot know what was sent', () => {
    expect(isOpaqueToModel({ contentType: 'image' })).toBe(true);
    expect(isOpaqueToModel({ contentType: 'audio' })).toBe(true);
    expect(isOpaqueToModel({ contentType: 'video' })).toBe(true);
  });

  it('knows when it can', () => {
    expect(
      isOpaqueToModel({ contentType: 'image', contentText: 'mi recibo' }),
    ).toBe(false);
    expect(isOpaqueToModel({ contentType: 'text', contentText: 'hola' })).toBe(
      false,
    );
  });
});

describe('AI_CONTEXT_CONTENT_TYPES', () => {
  it('covers every type the webhook can store', () => {
    // A stored type missing from this list is invisible to the model in every
    // later turn - which is how `location`, `video` and `document` rows ended
    // up persisted but never reasoned about.
    for (const t of ['text', 'image', 'video', 'audio', 'document', 'location', 'template', 'interactive', 'contacts']) {
      expect(AI_CONTEXT_CONTENT_TYPES).toContain(t);
    }
  });
});
