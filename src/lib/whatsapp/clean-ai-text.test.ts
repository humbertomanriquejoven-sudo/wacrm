import { describe, it, expect } from 'vitest';
import { cleanAiReplyText, stripRawTimestamps } from './clean-ai-text';

describe('stripRawTimestamps', () => {
  it('removes an ISO 8601 datetime with the Bogota offset', () => {
    expect(
      stripRawTimestamps(
        'Tu cita quedó agendada para 2026-09-17T17:32:11-05:00, te esperamos.'
      )
    ).toBe('Tu cita quedó agendada para , te esperamos.');
  });

  it('removes the raw wall-clock with its timezone read ("17:32:11 -05:00")', () => {
    expect(stripRawTimestamps('La hora actual es 17:32:11 -05:00')).toBe(
      'La hora actual es'
    );
  });

  it('removes a timestamp with the offset glued to it', () => {
    expect(stripRawTimestamps('Registrado a las 17:32:11-05:00')).toBe(
      'Registrado a las'
    );
  });

  it('returns an empty string when the reply was ONLY a raw timestamp', () => {
    expect(stripRawTimestamps('2026-09-17T17:32:11-05:00')).toBe('');
    expect(stripRawTimestamps('17:32:11 -05:00')).toBe('');
  });

  it('keeps natural human times (no seconds, no offset)', () => {
    const text = 'Puedes venir el 2026-09-18 a las 14:00 o mañana a las 6:00 p. m.';
    expect(stripRawTimestamps(text)).toBe(text);
  });

  it('keeps the Google Meet URL untouched', () => {
    expect(
      stripRawTimestamps(
        'Unirse a Google Meet: https://meet.google.com/abc-defg-hij'
      )
    ).toBe('Unirse a Google Meet: https://meet.google.com/abc-defg-hij');
  });

  it('drops a line that only contained raw availability slots', () => {
    expect(
      stripRawTimestamps(
        'Horarios disponibles:\nlunes 2026-09-21: 2026-09-21T08:00:00-05:00, 2026-09-21T09:00:00-05:00'
      )
    ).toBe('Horarios disponibles:\nlunes 2026-09-21');
  });
});

describe('cleanAiReplyText', () => {
  it('strips raw timestamps as part of the reply cleaning', () => {
    expect(
      cleanAiReplyText(
        'Confirmado a las 17:32:11 -05:00. Fecha: 2026-09-17T17:32:11-05:00'
      )
    ).toBe('Confirmado a las . Fecha');
  });
});